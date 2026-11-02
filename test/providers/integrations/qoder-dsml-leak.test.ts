import { expect, test } from "bun:test";
import { qoderBodyToCanonicalEvents } from "../../../src/providers/integrations/qoder/qoder";
import { dsmlPartialTail, parseQoderDsml } from "../../../src/providers/integrations/qoder/qoder-dsml";

/**
 * DeepSeek on Qoder sometimes writes its tool call as DSML markup in the
 * content stream, often malformed (doubled fullwidth separators, closers
 * missing `</`, no `</invoke>`, empty `name=""`). It must become a tool call,
 * never visible text.
 */

const READ_TOOL = {
  name: "read",
  jsonSchema: {
    type: "object",
    properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
    required: ["path"],
  },
};
const BASH_TOOL = {
  name: "bash",
  jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};
const TOOLS = [READ_TOOL, BASH_TOOL];

// The block exactly as it leaked to the client.
const LEAKED =
  "<｜｜DSML｜｜ calls>\n" +
  '<｜｜DSML｜｜ invoke name="">\n' +
  '<｜｜DSML｜｜ parameter name="path" string="true">app/Controllers/Kurikulum.php</｜｜DSML｜｜ parameter>\n' +
  '<｜｜DSML｜｜ parameter name="offset" string="false">2230｜｜DSML｜｜ parameter>\n' +
  '<｜｜DSML｜｜ parameter name="limit" string="false">60</｜｜DSML｜｜ parameter>\n' +
  "</｜｜DSML｜｜ calls>";

function frame(delta: Record<string, unknown>, finishReason?: string): string {
  const chunk = {
    choices: [{ delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  };
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\n`;
}

function body(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function collect(chunks: readonly string[], tools = TOOLS): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const e of qoderBodyToCanonicalEvents(body(chunks), new AbortController().signal, "m", tools)) {
    out.push(e as unknown as Record<string, unknown>);
  }
  return out;
}

const textOf = (ev: readonly Record<string, unknown>[]) =>
  ev
    .filter((e) => e["type"] === "content_delta")
    .map((e) => ((e["content"] as Record<string, unknown>)["text"] as string) ?? "")
    .join("");
const callsOf = (ev: readonly Record<string, unknown>[]) => ev.filter((e) => e["type"] === "tool_call_delta");
const terminal = (ev: readonly Record<string, unknown>[]) => ev.find((e) => e["type"] === "terminal")!;

/** Splits text into small frames so tags straddle frame boundaries. */
function chop(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(frame({ content: text.slice(i, i + size) }));
  return out;
}

test("parser recovers the malformed screenshot block and infers the empty name", () => {
  const r = parseQoderDsml(LEAKED, TOOLS);
  expect(r).not.toBeNull();
  expect(r!.calls).toHaveLength(1);
  expect(r!.calls[0]!.name).toBe("read");
  expect(JSON.parse(r!.calls[0]!.arguments)).toEqual({
    path: "app/Controllers/Kurikulum.php",
    offset: 2230,
    limit: 60,
  });
});

test("parser keeps an explicit name and ASCII separators", () => {
  const text =
    'Checking.\n<|DSML| function_calls>\n<|DSML| invoke name="bash">\n<|DSML| parameter name="command" string="true">ls -la | grep x</|DSML| parameter>\n</|DSML| invoke>\n</|DSML| function_calls>';
  const r = parseQoderDsml(text, TOOLS)!;
  expect(r.before.trim()).toBe("Checking.");
  expect(r.calls[0]!.name).toBe("bash");
  expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ command: "ls -la | grep x" });
});

test("parser recovers several invokes without invoke closers", () => {
  const text =
    '<｜DSML｜ calls><｜DSML｜ invoke name="read"><｜DSML｜ parameter name="path" string="true">a.ts</｜DSML｜ parameter>' +
    '<｜DSML｜ invoke name="bash"><｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter></｜DSML｜ calls>';
  const r = parseQoderDsml(text, TOOLS)!;
  expect(r.calls.map((c) => c.name)).toEqual(["read", "bash"]);
});

test("an empty name that fits no single tool is not guessed", () => {
  const text = '<｜DSML｜ calls><｜DSML｜ invoke name=""><｜DSML｜ parameter name="nope">1</｜DSML｜ parameter></｜DSML｜ calls>';
  expect(parseQoderDsml(text, TOOLS)).toBeNull();
});

test("partial tag tails are held", () => {
  expect(dsmlPartialTail("hello <｜｜DS")).toBe("<｜｜DS");
  expect(dsmlPartialTail("hello <")).toBe("<");
  expect(dsmlPartialTail("a < b")).toBe("");
  expect(dsmlPartialTail("<div>")).toBe("");
});

test("stream: leaked DSML split across frames becomes a tool call, not text", async () => {
  const prose = "Saya pakai tool read dulu. ";
  for (const size of [1, 3, 7, 40, 1000]) {
    const ev = await collect([...chop(prose + LEAKED, size), frame({}, "stop")]);
    expect(textOf(ev)).toBe(prose);
    expect(textOf(ev)).not.toContain("DSML");
    expect(callsOf(ev)).toHaveLength(1);
    expect(callsOf(ev)[0]!["name"]).toBe("read");
    expect(JSON.parse(callsOf(ev)[0]!["arguments_delta"] as string)).toMatchObject({ offset: 2230, limit: 60 });
    expect(terminal(ev)["stop_reason"]).toBe("tool_use");
  }
});

test("stream: unrecoverable DSML call fails closed instead of leaking", async () => {
  const bad = '<｜DSML｜ calls><｜DSML｜ invoke name=""><｜DSML｜ parameter name="zzz">1</｜DSML｜ parameter></｜DSML｜ calls>';
  await expect(collect([frame({ content: bad }), frame({}, "stop")])).rejects.toThrow();
});

test("stream: ordinary text with angle brackets is untouched", async () => {
  const text = "if a < b then <b>bold</b> and x <";
  const ev = await collect([...chop(text, 2), frame({}, "stop")]);
  expect(textOf(ev)).toBe(text);
  expect(callsOf(ev)).toHaveLength(0);
});
