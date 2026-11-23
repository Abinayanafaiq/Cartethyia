/**
 * OpenScale: plan-key catalog narrowing, the declared one-slot inflight
 * default, and the `model_not_in_plan` verdict.
 *
 * The inflight default is the load-bearing piece. OpenScale does not refuse a
 * request past a plan's concurrency limit — it holds it open with `: ping`
 * keep-alives — so the only way an extra request reaches another provider is
 * the gateway refusing it admission locally and moving to the next candidate.
 */
import { describe, expect, test } from "bun:test";
import {
  OPENSCALE_MODELS,
  fetchOpenScaleQuota,
  isOpenScalePlanKey,
  openScaleModelDiscovery,
} from "../../src/providers/integrations/openscale";
import { providerDefaultMaxInflight } from "../../src/providers/provider-metadata";
import { InMemoryAdmissionController } from "../../src/transport/routing/admission";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate, RoutePlan } from "../../src/transport/routing/route-model";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { mapUpstreamHttpError } from "../../src/transport/failure-policy";
import { GatewayError } from "../../src/protocol/gateway-error";

// Non-secret placeholders shaped like the two key kinds.
const PLAN_KEY = "sk-openscale-plan-test";
const PAYG_KEY = "sk-openscale-test";

/** Trimmed `GET /v1/models` rows in the upstream's own shape. */
function modelRow(id: string, ctx: number, out: number): Record<string, unknown> {
  return {
    id,
    input_modalities: [
      { type: "text", supported_inputs: { max_context_length: { value: ctx, unit: "token" } } },
      { type: "image" },
    ],
    output_modalities: [{ type: "text", max_length: { value: out, unit: "token" } }],
  };
}

const LIVE_MODELS = {
  object: "list",
  data: [
    modelRow("deepseek/deepseek-v4.1-flash", 1_048_568, 384_000),
    modelRow("deepseek/deepseek-v4.1-flash-1017", 1_048_568, 384_000),
    modelRow("deepseek/deepseek-v4.1-flash:fast", 1_048_568, 384_000),
    modelRow("z-ai/glm-5.3-flash", 1_048_576, 131_072),
    modelRow("vendor/brand-new-model", 500_000, 64_000),
  ],
};

function discoveryFetcher(seen: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(String(url));
    const auth = new Headers(init?.headers).get("authorization");
    expect(auth?.startsWith("Bearer sk-openscale")).toBe(true);
    return new Response(JSON.stringify(LIVE_MODELS), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function discover(credential: string): Promise<readonly string[]> {
  const seen: string[] = [];
  const run = openScaleModelDiscovery();
  const models = await run({
    baseUrl: "https://api.openscale.so/v1",
    credential,
    fetcher: discoveryFetcher(seen),
  });
  expect(seen).toEqual(["https://api.openscale.so/v1/models"]);
  return (models ?? []).map((model) => model.modelId);
}

describe("openscale catalog", () => {
  test("recognizes plan keys by their prefix", () => {
    expect(isOpenScalePlanKey(PLAN_KEY)).toBe(true);
    expect(isOpenScalePlanKey(PAYG_KEY)).toBe(false);
  });

  test("a plan key only discovers the rows a plan can call", async () => {
    // GLM, `:fast` and unknown rows answer `model_not_in_plan` on a plan key.
    expect(await discover(PLAN_KEY)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash-1017",
    ]);
  });

  test("a pay-as-you-go key discovers the whole roster, unknown rows included", async () => {
    const ids = await discover(PAYG_KEY);
    expect(ids).toContain("z-ai/glm-5.3-flash");
    expect(ids).toContain("deepseek/deepseek-v4.1-flash:fast");
    expect(ids).toContain("vendor/brand-new-model");
  });

  test("known rows keep their effort scale and chat wire", async () => {
    const run = openScaleModelDiscovery();
    const models = await run({
      baseUrl: "https://api.openscale.so/v1",
      credential: PLAN_KEY,
      fetcher: discoveryFetcher([]),
    });
    const flash = models?.find((model) => model.modelId === "deepseek/deepseek-v4.1-flash");
    expect(flash?.wireFamily).toBe("chat");
    expect(flash?.reasoning).toBe(true);
    expect(flash?.reasoningEfforts).toEqual(["none", "low", "high", "max"]);
    expect(flash?.contextLimit).toBe(1_048_568);
    expect(flash?.modalities.input).toContain("image");
  });

  test("a failed discovery falls back to the plan roster", async () => {
    const run = openScaleModelDiscovery();
    const models = await run({
      baseUrl: "https://api.openscale.so/v1",
      credential: PLAN_KEY,
      fetcher: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(models).toBe(OPENSCALE_MODELS);
    expect(OPENSCALE_MODELS.map((model) => model.modelId)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash-1017",
      "deepseek/deepseek-v4.1-flash-0910",
    ]);
  });
});

describe("openscale concurrency", () => {
  test("declares a one-slot default; other providers stay unlimited", () => {
    expect(providerDefaultMaxInflight("openscale")).toBe(1);
    expect(providerDefaultMaxInflight("groq")).toBeNull();
    expect(providerDefaultMaxInflight("my-custom-byok")).toBeNull();
  });

  test("a busy OpenScale account hands the next request to the next combo member", async () => {
    const engine = new RoutingEngine(new InMemoryAdmissionController());
    const openscale = {
      provider_id: "openscale",
      model_id: "deepseek/deepseek-v4.1-flash",
      provider_account_id: "os-1",
      max_inflight: 1,
    } as RouteCandidate;
    const fallback = {
      provider_id: "tokenharbor",
      model_id: "deepseek-v4.1-flash",
      provider_account_id: "th-1",
    } as RouteCandidate;
    const plan = {
      revision: 1,
      candidates: [openscale, fallback],
      requested_model: "deepseek-combo",
      resolved_model: "deepseek-combo",
      provider_id: "openscale",
      decisions: new Map(),
    } as unknown as RoutePlan;

    const first = await engine.reserve(plan);
    expect(first.candidate.provider_id).toBe("openscale");
    const second = await engine.reserve(plan);
    expect(second.candidate.provider_id).toBe("tokenharbor");

    // Once the slot frees, OpenScale is first again.
    await engine.release(first);
    const third = await engine.reserve(plan);
    expect(third.candidate.provider_id).toBe("openscale");
  });
});

describe("openscale model_not_in_plan", () => {
  const BODY = JSON.stringify({
    error: {
      message:
        "The model 'z-ai/glm-5.3-flash' is not included in your plan, so a plan key cannot call it.",
      type: "invalid_request_error",
      param: "model",
      code: "model_not_in_plan",
    },
  });

  test("the upstream code reaches the classifier", async () => {
    const response = new Response(BODY, { status: 400, headers: { "content-type": "application/json" } });
    const error = await mapUpstreamHttpError(response, "openscale").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).details.providerCode).toBe("model_not_in_plan");
  });

  test("cools the (account, model) pair, never the account", () => {
    const classification = classifyAccountError(new Error(BODY), {
      origin: "upstream",
      scope: "provider",
      providerId: "openscale",
      providerCode: "model_not_in_plan",
      statusCode: 400,
      modelId: "z-ai/glm-5.3-flash",
    });
    expect(classification.category).toBe("model_unreachable");
    expect(classification.status).toBe("cooldown");
    expect(classification.mutatesAccount).toBe(true);
  });

  test("without a model id it never parks the account", () => {
    const classification = classifyAccountError(new Error(BODY), {
      origin: "upstream",
      scope: "provider",
      providerId: "openscale",
      providerCode: "model_not_in_plan",
      statusCode: 400,
    });
    expect(classification.category).toBe("model_unreachable");
    expect(classification.mutatesAccount).toBe(false);
  });
});

describe("openscale account test", () => {
  // `/v1/models` is public (200 for any key), so the probe posts an empty chat
  // body instead: auth is checked first, validation second, inference never.
  function answering(status: number, seen: Array<{ url: string; init?: RequestInit }>): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ error: { code: status === 401 ? "invalid_api_key" : "missing_required_parameter" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  test("a 400 on the empty body is a valid key, and no messages are sent", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const result = await fetchOpenScaleQuota(PLAN_KEY, answering(400, seen));
    expect(result.error).toBeNull();
    expect(result.plan).toBe("Plan");
    expect(seen[0]?.url).toBe("https://api.openscale.so/v1/chat/completions");
    expect(seen[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(seen[0]?.init?.body)) as Record<string, unknown>;
    expect(body.messages).toBeUndefined();
  });

  test("a 401 is an invalid key", async () => {
    const result = await fetchOpenScaleQuota(PAYG_KEY, answering(401, []));
    expect(result.error).toBe("API key is invalid or revoked.");
  });

  test("anything else is inconclusive, not a verdict", async () => {
    const result = await fetchOpenScaleQuota(PAYG_KEY, answering(502, []));
    expect(result.error).toBe("Connectivity check failed: HTTP 502.");
  });
});
