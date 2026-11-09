import { expect, test } from "bun:test";
import { isUpstreamQueued, queueRetryAfterMs } from "../../src/transport/failure-policy";

/**
 * Live COSY answer (2026-11-10): the queue verdict is JSON text nested two
 * levels inside `message`. Read as a plain 403 it became authentication_failed,
 * which cools the account down instead of waiting the stated interval.
 */
const inner = JSON.stringify({
  errorCode: 0,
  isQueued: true,
  modelKey: "dfmodel",
  queueCount: 1,
  queueType: "p4",
  retryAfterSeconds: 60,
});
const live = { code: "403", message: JSON.stringify({ code: "10605", message: inner }) };

test("a nested Qoder 10605 queue body is recognized as queued", () => {
  expect(isUpstreamQueued(live)).toBe(true);
});

test("the nested retryAfterSeconds is honoured", () => {
  expect(queueRetryAfterMs(live)).toBe(60_000);
});

test("an ordinary 403 with a JSON-looking message is not a queue", () => {
  expect(isUpstreamQueued({ code: "403", message: JSON.stringify({ code: "101", message: "Signature invalid" }) })).toBe(false);
  expect(isUpstreamQueued({ code: "403", message: "{not json" })).toBe(false);
});
