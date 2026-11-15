import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { batchDeleteAccounts, refreshAfterAccountsDeleted } from "../../src/hooks/quota";
import { queryKeys } from "../../src/data/query-keys";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("bulk delete is one batch request per lens, not one DELETE per account", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { accountIds: string[] } : undefined;
    calls.push({ url: String(input), method: init?.method ?? "GET", body });
    return new Response(JSON.stringify({ ok: true, deleted: body?.accountIds ?? [], missing: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await batchDeleteAccounts([
    { id: "a1", tenantId: "t" },
    { id: "a2", tenantId: "t" },
    { id: "a3", tenantId: "t" },
    { id: "g1", tenantId: null },
  ]);

  expect(calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual([
    "POST /console/api/accounts/batch-delete",
    "POST /console/api/global/accounts/batch-delete",
  ]);
  expect(calls.find((c) => c.url.endsWith("/console/api/accounts/batch-delete"))?.body).toEqual({ accountIds: ["a1", "a2", "a3"] });
  expect(calls.find((c) => c.url.includes("/global/"))?.body).toEqual({ accountIds: ["g1"] });
  expect([...result.deleted].sort()).toEqual(["a1", "a2", "a3", "g1"]);
});

test("after a delete only the account list, provider list and quota overview refresh", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const keys = [
    queryKeys.providers.all,
    queryKeys.providers.accounts("cbcn"),
    queryKeys.providers.usageMatrix("cbcn"),
    queryKeys.providers.models("cbcn"),
    queryKeys.providers.routing("cbcn"),
    queryKeys.quota.all,
    queryKeys.quota.account("a1"),
  ];
  for (const key of keys) client.setQueryData(key, { seeded: true });

  await refreshAfterAccountsDeleted(client, "cbcn", ["a1"]);

  const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated === true;
  expect(stale(queryKeys.providers.accounts("cbcn"))).toBe(true);
  expect(stale(queryKeys.providers.all)).toBe(true);
  expect(stale(queryKeys.quota.all)).toBe(true);
  // The expensive reads a delete does not change are left alone.
  expect(stale(queryKeys.providers.usageMatrix("cbcn"))).toBe(false);
  expect(stale(queryKeys.providers.models("cbcn"))).toBe(false);
  expect(stale(queryKeys.providers.routing("cbcn"))).toBe(false);
  // The deleted account's own quota entry is dropped.
  expect(client.getQueryState(queryKeys.quota.account("a1"))).toBeUndefined();
});
