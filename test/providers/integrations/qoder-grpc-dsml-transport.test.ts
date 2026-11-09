import { expect, test } from "bun:test";
import type { CanonicalEvent } from "../../../src/protocol/canonical-model";
import { recoverQoderDsmlEvents } from "../../../src/providers/integrations/qoder/qoder-dsml";
import { resolveQoderTransport } from "../../../src/providers/integrations/qoder/qoder-adapter";

/**
 * Fork guarantees carried onto the upstream gRPC transport:
 *
 * 1. Paid Qoder models dispatch over gRPC by default. The HTTP IDE surface
 *    (`/model/v1`) rejects bodies above ~256 KiB with a bare 500, which is
 *    what made contexts past ~50k tokens fail; gRPC accepts ~5.5M chars.
 * 2. DSML markup written into the text stream is still recovered as a tool
 *    call on the gRPC surface, and the terminal reports `tool_use`.
 */

const READ_TOOL = {
  name: "read",
  jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

async function* events(list: readonly CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const event of list) yield event;
}

async function collect(list: readonly CanonicalEvent[]): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const event of recoverQoderDsmlEvents(events(list), [READ_TOOL])) out.push(event);
  return out;
}

const text = (sequence_number: number, value: string): CanonicalEvent =>
  ({ type: "content_delta", sequence_number, content: { kind: "text", text: value } }) as CanonicalEvent;

test("paid models use gRPC by default; only free-tier rows fall back to COSY", () => {
  const paid = { id: "dmodel", display_name: "DeepSeek", max_input_tokens: 1_000_000, is_vl: true, is_reasoning: true };
  expect(resolveQoderTransport(undefined, paid as never)).toBe("grpc");
  expect(resolveQoderTransport("grpc", paid as never)).toBe("grpc");
  expect(resolveQoderTransport(undefined, { ...paid, is_free: true } as never)).toBe("cosy");
});

test("gRPC stream: DSML split across frames becomes a tool call and the terminal says tool_use", async () => {
  const out = await collect([
    { type: "response_start", sequence_number: 1, model: "dmodel" } as CanonicalEvent,
    text(2, "Let me read it. <｜｜DS"),
    text(3, 'ML｜｜ calls>\n<｜｜DSML｜｜ invoke name="">\n<｜｜DSML｜｜ parameter name="path" string="true">a.txt</｜｜DSML｜｜ parameter>\n'),
    text(4, "</｜｜DSML｜｜ calls>"),
    { type: "terminal", sequence_number: 5, state: "complete", stop_reason: "stop", provider_stop_reason: "stop" } as CanonicalEvent,
  ]);
  const visible = out
    .filter((e) => e.type === "content_delta")
    .map((e) => (e.type === "content_delta" && e.content.kind === "text" ? e.content.text : ""))
    .join("");
  expect(visible).not.toContain("DSML");
  expect(visible).toContain("Let me read it.");
  const calls = out.filter((e) => e.type === "tool_call_delta");
  expect(calls).toHaveLength(1);
  const call = calls[0] as Extract<CanonicalEvent, { type: "tool_call_delta" }>;
  expect(call.name).toBe("read");
  expect(JSON.parse(call.arguments_delta ?? "{}")).toEqual({ path: "a.txt" });
  const terminal = out.at(-1) as Extract<CanonicalEvent, { type: "terminal" }>;
  expect(terminal.type).toBe("terminal");
  expect(terminal.stop_reason).toBe("tool_use");
  // Inserted events keep the sequence strictly increasing.
  const seqs = out.map((e) => e.sequence_number);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
});

test("a stream with no DSML passes through untouched", async () => {
  const input = [
    { type: "response_start", sequence_number: 1, model: "dmodel" } as CanonicalEvent,
    text(2, "Hello "),
    text(3, "world"),
    { type: "terminal", sequence_number: 4, state: "complete", stop_reason: "stop" } as CanonicalEvent,
  ];
  expect(await collect(input)).toEqual(input);
});
