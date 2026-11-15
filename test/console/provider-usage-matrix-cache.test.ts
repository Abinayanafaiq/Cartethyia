import { expect, test } from "bun:test";
import { createCachedProviderUsageMatrix } from "../../src/console/providers/catalog/usage-matrix-cache";
import type { ProviderUsageDayRow } from "../../src/observability/event-query";

const DAY = 86_400_000;
const row = (day: string, requests: number): ProviderUsageDayRow => ({
  day, model: "m", requests, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0,
});

function harness(startMs: number) {
  let nowMs = startMs;
  const calls: { since: string; until?: string }[] = [];
  let todayRequests = 1;
  const matrix = createCachedProviderUsageMatrix(async (_t, _p, since, until) => {
    calls.push({ since: since.toISOString(), ...(until ? { until: until.toISOString() } : {}) });
    return until === undefined
      ? [row(since.toISOString().slice(0, 10), todayRequests)]
      : [row(since.toISOString().slice(0, 10), 100)];
  }, () => nowMs);
  return {
    matrix, calls,
    advance: (ms: number) => { nowMs += ms; },
    setToday: (n: number) => { todayRequests = n; },
  };
}

test("finished days are scanned once per UTC day; today is re-read every call", async () => {
  const h = harness(Date.UTC(2026, 10, 15, 9));
  const first = await h.matrix("t", "cbcn", 30);
  h.setToday(7);
  const second = await h.matrix("t", "cbcn", 30);
  const pastScans = h.calls.filter((c) => c.until !== undefined);
  expect(pastScans).toHaveLength(1);
  expect(pastScans[0]).toEqual({ since: "2026-10-17T00:00:00.000Z", until: "2026-11-15T00:00:00.000Z" });
  expect(h.calls.filter((c) => c.until === undefined)).toHaveLength(2);
  expect(first.at(-1)?.requests).toBe(1);
  expect(second.at(-1)?.requests).toBe(7);
});

test("the cache rolls over when the UTC day changes", async () => {
  const h = harness(Date.UTC(2026, 10, 15, 23, 59));
  await h.matrix("t", "cbcn", 30);
  h.advance(2 * 60_000);
  await h.matrix("t", "cbcn", 30);
  const pastScans = h.calls.filter((c) => c.until !== undefined);
  expect(pastScans.map((c) => c.until)).toEqual(["2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z"]);
});

test("entries are per tenant/provider/window, and a failed scan is retried", async () => {
  let fail = true;
  const seen: string[] = [];
  const matrix = createCachedProviderUsageMatrix(async (t, p, _s, until) => {
    if (until !== undefined) {
      seen.push(`${t}/${p}`);
      if (fail) { fail = false; throw new Error("boom"); }
    }
    return [];
  }, () => Date.UTC(2026, 10, 15, 12));
  await expect(matrix("t", "cbcn", 30)).rejects.toThrow("boom");
  await matrix("t", "cbcn", 30);
  await matrix("t", "cbcn", 30);
  await matrix("t", "qoder", 30);
  expect(seen).toEqual(["t/cbcn", "t/cbcn", "t/qoder"]);
});

test("a one-day window reads only today", async () => {
  const h = harness(Date.UTC(2026, 10, 15, 12));
  await h.matrix("t", "cbcn", 1);
  expect(h.calls).toEqual([{ since: "2026-11-15T00:00:00.000Z" }]);
  void DAY;
});
