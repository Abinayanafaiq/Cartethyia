import { expect, test } from "bun:test";
import { buildQoderIdeRequest, qoderBodyToCanonicalEvents } from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest } from "../../../src/protocol/canonical-model";
import { recoverQoderDsmlEvents } from "../../../src/providers/integrations/qoder/qoder-dsml";

/**
 * Two wire defects on the modern `/model/v1` surface, both found live
 * (2026-11-02, dmodel/dfmodel):
 *
 * 1. The body dropped `tools`, so the model never saw the caller's tools and
 *    wrote the call as text (raw JSON args, `<read>` tags, DSML markup).
 * 2. The upstream splits `data:` payloads with raw newlines anywhere —
 *    inside keys, ids, numbers. Escaping those into the string kept a key
 *    like `choic\nes` unrecognised, so the chunk (and any tool-argument
 *    fragment in it) was silently dropped.
 */

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

test("ide request carries the declared tools and tool_choice", () => {
  const request = {
    model: "dmodel",
    messages: [{ role: "user", content: [{ kind: "text", text: "read a.txt" }] }],
    generation_controls: { parallel_tool_calls: true },
    stream: true,
    source_surface: "chat",
    tools: [READ_TOOL],
    tool_choice: "required",
  } as unknown as CanonicalRequest;
  const auth = { userId: "u", userName: "", userType: "personal_standard", securityOauthToken: "jt-x", refreshToken: "" };
  const cfg = { id: "dmodel", display_name: "DeepSeek", max_input_tokens: 180000, is_vl: true, is_reasoning: true };
  const body = buildQoderIdeRequest("dmodel", request, cfg as never, auth as never);
  const tools = body["tools"] as Array<{ type: string; function: { name: string } }>;
  expect(Array.isArray(tools)).toBe(true);
  expect(tools.map((t) => t.function.name)).toEqual(["read"]);
  // The remaining knobs ride the `parameters` passthrough, as the desktop
  // client sends them.
  const parameters = body["parameters"] as Record<string, unknown> | undefined;
  expect(parameters?.["parallel_tool_calls"]).toBe(true);
  expect(parameters?.["tool_choice"]).toBe("required");
});

test("ide request omits tools when none are declared", () => {
  const request = {
    model: "dmodel",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  } as unknown as CanonicalRequest;
  const auth = { userId: "u", userName: "", userType: "personal_standard", securityOauthToken: "jt-x", refreshToken: "" };
  const cfg = { id: "dmodel", display_name: "DeepSeek", max_input_tokens: 180000, is_vl: true, is_reasoning: true };
  const body = buildQoderIdeRequest("dmodel", request, cfg as never, auth as never);
  // No declared tools: the body carries no `tools` key at all, as the
  // desktop client omits it.
  expect(body["tools"]).toBeUndefined();
});

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return JSON.stringify({ choices: [{ delta, finish_reason: finish, index: 0 }], created: 1793628743, model: "dmodel" });
}

/** Splits a JSON payload with a raw newline at `at`, as the upstream does. */
function split(json: string, at: number): string {
  return `data: ${json.slice(0, at)}\n${json.slice(at)}\n\n`;
}

async function collect(sse: string): Promise<Array<Record<string, unknown>>> {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(sse)); c.close(); } });
  const out: Array<Record<string, unknown>> = [];
  for await (const e of recoverQoderDsmlEvents(qoderBodyToCanonicalEvents(body, new AbortController().signal, "dmodel"), [READ_TOOL])) {
    out.push(e as unknown as Record<string, unknown>);
  }
  return out;
}

test("raw newlines inside keys, strings and numbers do not drop tool-call fragments", async () => {
  const first = chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }] });
  const parts = ['{"path"', ': "', 'a.txt"', "}"];
  let sse = split(first, first.indexOf("choices") + 5); // "choic\nes"
  parts.forEach((p, i) => {
    const c = chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] });
    // Alternate split points: inside a key, inside the arguments string, inside a number.
    const at = [c.indexOf("tool_calls") + 4, c.indexOf("arguments") + 14, c.indexOf("1793") + 4, c.indexOf("finish") + 3][i]!;
    sse += split(c, at);
  });
  sse += `data: ${chunk({}, "tool_calls")}\n\ndata: [DONE]\n\n`;
  const events = await collect(sse);
  const args = events
    .filter((e) => e["type"] === "tool_call_delta")
    .map((e) => (e["arguments_delta"] as string | undefined) ?? "")
    .join("");
  expect(JSON.parse(args)).toEqual({ path: "a.txt" });
  const names = events.filter((e) => e["type"] === "tool_call_delta" && e["name"]).map((e) => e["name"]);
  expect(names).toEqual(["read"]);
});

test("a split inside a content string restores the text without a stray newline", async () => {
  const c = chunk({ content: "hello world" });
  const sse = split(c, c.indexOf("hello") + 3) + `data: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`;
  const events = await collect(sse);
  const text = events
    .filter((e) => e["type"] === "content_delta")
    .map((e) => ((e["content"] as { text?: string }).text ?? ""))
    .join("");
  expect(text).toBe("hello world");
});

/**
 * 3. The split can land right before a `:` (`"model"` / `:"dfmodel"`) or inside
 *    the `data:` field name itself (`da` / `ta: {...}`). The first was read as
 *    an SSE comment, the payload never closed, and every later frame was
 *    swallowed — the answer text vanished ("putus-putus" output). The second
 *    threw "Malformed SSE line".
 */
test("splits before a colon or inside the data: prefix keep every frame", async () => {
  const a = chunk({ content: "Every " });
  const b = chunk({ content: "evening" });
  const c = chunk({}, "stop");
  const sse =
    `data: ${a.slice(0, a.indexOf('"model"') + 7)}\n${a.slice(a.indexOf('"model"') + 7)}\n\n\n` +
    `da\nta: ${b}\n\n\n` +
    `data\n: ${c}\n\ndata: [DONE]\n\n`;
  const events = await collect(sse);
  const text = events
    .filter((e) => e["type"] === "content_delta")
    .map((e) => ((e["content"] as { text?: string }).text ?? ""))
    .join("");
  expect(text).toBe("Every evening");
  expect(events.at(-1)?.["stop_reason"]).toBe("stop");
});
