import { expect, test } from "bun:test";
import { qoderBodyToCanonicalEvents } from "../../../src/providers/integrations/qoder/qoder";

/**
 * COSY echoes a fixed "auto" in every chunk whatever `model_config.key` asked
 * for. That opaque echo must not replace the requested key in the response,
 * while a real echo (the IDE surface's roster key) and an actual `auto`
 * request still pass through.
 */
function body(model: string): ReadableStream<Uint8Array> {
  const chunk = JSON.stringify({
    id: "c1",
    model,
    choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
  });
  const sse = `data: ${chunk}\n\ndata: [DONE]\n\n`;
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
}

async function startModel(echo: string, requested: string): Promise<string | undefined> {
  for await (const e of qoderBodyToCanonicalEvents(body(echo), new AbortController().signal, requested)) {
    if (e.type === "response_start") return e.model;
  }
  return undefined;
}

test("COSY's opaque 'auto' echo keeps the requested key", async () => {
  expect(await startModel("auto", "dfmodel")).toBe("dfmodel");
  expect(await startModel("auto", "qoder/dfmodel")).toBe("qoder/dfmodel");
});

test("a requested 'auto' and a real roster echo pass through", async () => {
  expect(await startModel("auto", "auto")).toBe("auto");
  expect(await startModel("dfmodel", "qoder-virtual-x")).toBe("dfmodel");
});
