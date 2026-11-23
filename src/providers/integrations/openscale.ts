// OpenScale (`api.openscale.so`) — an OpenAI-compatible chat gateway sold as
// pay-as-you-go keys and as flat-rate plan keys (`sk-openscale-plan-…`).
//
// Two upstream facts shape this module, both verified live on 2026-11-23:
//
// 1. A plan key is gated per model. `/v1/models` lists the whole roster, but a
//    plan key calling a row outside its plan answers
//    `400 {"code":"model_not_in_plan"}`. Discovery therefore narrows a plan key
//    to the rows observed to answer on a plan (`plan: true` below) instead of
//    advertising models every request would be refused on.
//
// 2. A plan's concurrency limit is not enforced with an error. A request past
//    the limit is answered `200 text/event-stream` and *held*: the server sends
//    `: ping` comments until a slot frees, then streams normally (a third
//    parallel request on a 1-slot plan waited ~40s). The same `: ping` comments
//    also appear on a lone request while a long prompt prefills (~37s for a
//    600k-token prompt with nothing queued), so the stream cannot tell
//    "queued" from "slow" and the gateway must not abort on it. The concurrency
//    limit is enforced locally instead: the provider's default per-account
//    inflight ceiling (`defaultMaxInflight` in `provider-metadata.ts`) is one,
//    so a second concurrent request is refused admission on this account and
//    `Router.reserve` moves to the next candidate — the next OpenScale account,
//    or the next combo member on another provider.
import type { ApiKeyProviderSpec } from "../configured-provider";
import { defineModel, type ModelDefinition } from "../provider-model-definition";
import type { ProviderModelDiscovery } from "../discovery/discovery-types";
import type { FetchLike, ProviderQuotaResult } from "../quota/quota-contracts";
import { cleanError } from "../quota/quota-contracts";
import { createProbeFetch } from "../operations/probe-fetch";
import { providerBaseUrl } from "../provider-metadata";

export const OPENSCALE_PROVIDER_ID = "openscale" as const;

/** Prefix OpenScale gives every plan (subscription) key. */
const OPENSCALE_PLAN_KEY_PREFIX = "sk-openscale-plan-";

export function isOpenScalePlanKey(credential: string): boolean {
  return credential.trim().startsWith(OPENSCALE_PLAN_KEY_PREFIX);
}

export const OPENSCALE_SPEC: ApiKeyProviderSpec = {
  provider_id: OPENSCALE_PROVIDER_ID,
  endpoint_paths_by_wire_family: { chat: "/chat/completions" },
};

interface OpenScaleModelRow {
  readonly id: string;
  readonly ctx: number;
  readonly out: number;
  /** Upstream `supported_parameters.reasoning_effort.values`. */
  readonly efforts: readonly string[];
  /**
   * Upstream pay-as-you-go price in USD per 1M tokens: prompt, cached prompt,
   * completion (the row's `pricing[].cost_usd`, which is per token, ×1e6).
   */
  readonly price: readonly [input: number, cacheRead: number, output: number];
  /** Observed to answer 200 on a plan key; every other row is pay-as-you-go only. */
  readonly plan: boolean;
}

const DEEPSEEK_EFFORTS = ["none", "low", "high", "max"] as const;
const GLM_EFFORTS = ["low", "high", "max"] as const;

/**
 * Mirrors `GET /v1/models` (fetched 2026-11-23, 12 rows). Limits and effort
 * scales are the upstream's own `input_modalities[].supported_inputs` /
 * `output_modalities[].max_length` / `supported_parameters` / `pricing` values. Every row
 * accepts image input and declares `tools` and `reasoning`.
 *
 * `plan` is the result of calling each row with a plan key: only the three
 * DeepSeek V4.1 Flash rows answered; the rest returned `model_not_in_plan`.
 */
const OPENSCALE_MODEL_ROWS: readonly OpenScaleModelRow[] = [
  { id: "deepseek/deepseek-v4.1-flash", ctx: 1_048_568, out: 384_000, efforts: DEEPSEEK_EFFORTS, price: [0.06, 0.003, 0.24], plan: true },
  { id: "deepseek/deepseek-v4.1-flash-1017", ctx: 1_048_568, out: 384_000, efforts: DEEPSEEK_EFFORTS, price: [0.06, 0.003, 0.24], plan: true },
  { id: "deepseek/deepseek-v4.1-flash-0910", ctx: 1_048_568, out: 384_000, efforts: DEEPSEEK_EFFORTS, price: [0.06, 0.003, 0.24], plan: true },
  { id: "deepseek/deepseek-v4.1-flash:fast", ctx: 1_048_568, out: 384_000, efforts: DEEPSEEK_EFFORTS, price: [0.28, 0.028, 1.1], plan: false },
  { id: "deepseek/deepseek-v4.1-flash-1017:fast", ctx: 1_048_568, out: 384_000, efforts: DEEPSEEK_EFFORTS, price: [0.28, 0.028, 1.1], plan: false },
  { id: "deepseek/deepseek-v4.1-flash-0910:fast", ctx: 1_048_568, out: 384_000, efforts: DEEPSEEK_EFFORTS, price: [0.28, 0.028, 1.1], plan: false },
  { id: "deepseek/deepseek-v4.1-flash-abliterated", ctx: 1_048_576, out: 1_000_000, efforts: DEEPSEEK_EFFORTS, price: [0.12, 0.019, 0.45], plan: false },
  { id: "z-ai/glm-5.3-flash", ctx: 1_048_576, out: 131_072, efforts: GLM_EFFORTS, price: [0.12, 0.024, 0.4], plan: false },
  { id: "z-ai/glm-5.3-flash-0828", ctx: 1_048_576, out: 131_072, efforts: GLM_EFFORTS, price: [0.12, 0.024, 0.4], plan: false },
  { id: "z-ai/glm-5.3-flash-abliterated", ctx: 1_048_576, out: 1_000_000, efforts: GLM_EFFORTS, price: [0.12, 0.025, 0.5], plan: false },
  { id: "qwen/qwen3.8-27b", ctx: 262_144, out: 131_072, efforts: ["none", "low", "medium", "xhigh"], price: [0.04, 0.01, 1.25], plan: false },
  { id: "moonshotai/kimi-k3.1-pro", ctx: 1_048_576, out: 943_718, efforts: ["none", "low", "medium", "high"], price: [0.3, 0.2, 9], plan: false },
];

/**
 * Prices are stated explicitly: OpenScale is absent from the base catalog, so
 * `defineModel` would otherwise borrow another reseller's price for the same
 * model id (≈8× OpenScale's own for DeepSeek V4.1 Flash). A plan key is billed
 * a flat fee rather than per token; the per-token figure is still what the
 * usage page reports for it, which reads as "what this would have cost".
 */
function toDefinition(row: OpenScaleModelRow): ModelDefinition {
  const [input, cacheRead, output] = row.price;
  const definition = defineModel({
    id: row.id,
    providerId: OPENSCALE_PROVIDER_ID,
    wireFamily: "chat",
    ctx: row.ctx,
    out: row.out,
    vision: true,
    toolCall: true,
    reasoning: true,
    reasoningEfforts: row.efforts,
  });
  return { ...definition, cost: { input, output, cache_read: cacheRead, pricing_model: "pay-per-use" } };
}

const STATIC_ROWS_BY_ID: ReadonlyMap<string, OpenScaleModelRow> = new Map(
  OPENSCALE_MODEL_ROWS.map((row) => [row.id, row]),
);

/**
 * Offline catalog: the plan roster. It is what a plan key can actually call,
 * and a pay-as-you-go key serves it too, so it is the safe answer whichever
 * key kind the account holds when live discovery is unavailable.
 */
export const OPENSCALE_MODELS: readonly ModelDefinition[] = OPENSCALE_MODEL_ROWS.filter(
  (row) => row.plan,
).map(toDefinition);

/**
 * Narrows discovered rows to what the credential may call and folds in the
 * effort scale the generic `/models` reader does not keep.
 *
 * A plan key keeps only rows observed to answer on a plan. A row the upstream
 * lists but this module has never seen keeps the generic reader's limits and
 * modalities — the upstream named it, so it is offered — except on a plan key,
 * where an unknown row would most likely be refused as `model_not_in_plan`.
 */
export function selectOpenScaleModels(
  discovered: readonly ModelDefinition[],
  credential: string,
): readonly ModelDefinition[] {
  const plan = isOpenScalePlanKey(credential);
  const selected: ModelDefinition[] = [];
  for (const model of discovered) {
    const known = STATIC_ROWS_BY_ID.get(model.modelId);
    if (plan && known?.plan !== true) continue;
    if (known === undefined) {
      selected.push({ ...model, wireFamily: "chat", endpointPath: "/chat/completions" });
      continue;
    }
    const definition = toDefinition(known);
    selected.push({
      ...definition,
      // The upstream's live limits win over the committed snapshot.
      contextLimit: model.contextLimit ?? definition.contextLimit,
      outputLimit: model.outputLimit ?? definition.outputLimit,
    });
  }
  return selected;
}

/** Live `/v1/models` discovery, narrowed per key kind; falls back to {@link OPENSCALE_MODELS}. */
export function openScaleModelDiscovery(): ProviderModelDiscovery {
  return async (input) => {
    // dynamic-import: same lazy load every discovery-backed provider uses.
    const { fetchOpenAICompatibleModels } = await import("../discovery/openai-model-discovery");
    const models = await fetchOpenAICompatibleModels({
      baseUrl: input.baseUrl,
      providerId: OPENSCALE_PROVIDER_ID,
      headers: { authorization: `Bearer ${input.credential}` },
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    });
    if (models === null || models.length === 0) return OPENSCALE_MODELS;
    const selected = selectOpenScaleModels(models, input.credential);
    return selected.length > 0 ? selected : OPENSCALE_MODELS;
  };
}

/**
 * The account test. OpenScale exposes no quota or plan surface (`/v1/account`,
 * `/v1/usage`, `/v1/plan` are 404), and the shared `/models` probe cannot be
 * used: `/v1/models` is public, so it answers 200 for a wrong key too.
 *
 * Authentication is checked before body validation, so a chat POST with no
 * `messages` is a free credential check — verified live: a valid key gets
 * `400 missing_required_parameter`, a wrong key `401 invalid_api_key`, and no
 * inference runs, so the plan's single slot is never taken.
 */
export async function fetchOpenScaleQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const source = OPENSCALE_PROVIDER_ID;
  const base = (providerBaseUrl(source) ?? "").replace(/\/+$/, "");
  let response: Response;
  try {
    response = await createProbeFetch(fetcher)(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ model: OPENSCALE_MODEL_ROWS[0]?.id }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Connectivity check failed: ${cleanError(error)}`);
  }
  await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return { source, plan: null, windows: [], error: "API key is invalid or revoked." };
  }
  // 400 is the expected answer to the deliberately empty body; a 2xx would
  // mean the upstream stopped validating it, which still proves the key.
  if (response.status === 400 || response.ok) {
    return { source, plan: isOpenScalePlanKey(credential) ? "Plan" : "Pay-as-you-go", windows: [], error: null };
  }
  return { source, plan: null, windows: [], error: `Connectivity check failed: HTTP ${response.status}.` };
}
