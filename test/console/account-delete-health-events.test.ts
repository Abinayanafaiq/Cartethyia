/**
 * Deleting an account removes its health events incrementally (in yielding
 * batches before the row goes) instead of through one long FK cascade, and the
 * retention task prunes events past the window. A tenant can never reach
 * another tenant's events through either path.
 */
import { expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createWorld } from "../helpers/fixtures";
import { createTestGateway } from "../helpers/gateway";
import { dbDescribe } from "../helpers/database";
import { healthEvents, providerAccounts } from "../../src/persistence/schema";
import { pruneHealthEvents, purgeHealthEventsForAccounts } from "../../src/persistence/health-event-retention";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

async function seedEvents(db: CartethyiaDatabase, accountId: string, count: number, ageMs = 0): Promise<void> {
  const at = new Date(Date.now() - ageMs);
  for (let start = 0; start < count; start += 500) {
    const rows = Array.from({ length: Math.min(500, count - start) }, () => ({
      id: crypto.randomUUID(),
      entityKind: "account" as const,
      accountId,
      toStatus: "cooldown" as const,
      reason: "rate_limited",
      createdAt: at,
    }));
    await db.insert(healthEvents).values(rows);
  }
}

async function eventCount(db: CartethyiaDatabase, accountId: string): Promise<number> {
  return (await db.select({ id: healthEvents.id }).from(healthEvents).where(eq(healthEvents.accountId, accountId))).length;
}

dbDescribe("account delete with a large health-event history", () => {
  test("single and batch tenant deletes clear the history (more than one batch) and the rows", async () => {
    const world = await createWorld({ apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] } });
    const gateway = await createTestGateway();
    try {
      const single = await world.addAccount({ tenantId: world.tenantId, label: "single" });
      const batchA = await world.addAccount({ tenantId: world.tenantId, label: "batch-a" });
      const batchB = await world.addAccount({ tenantId: world.tenantId, label: "batch-b" });
      await seedEvents(gateway.db, single, 4500);
      await seedEvents(gateway.db, batchA, 2100);
      await seedEvents(gateway.db, batchB, 10);

      const one = await gateway.request(`/console/api/accounts/${single}`, { method: "DELETE", headers: { authorization: `Bearer ${world.token}` } });
      expect(one.status).toBe(200);
      expect(await eventCount(gateway.db, single)).toBe(0);

      const many = await gateway.json("/console/api/accounts/batch-delete", { accountIds: [batchA, batchB] }, { token: world.token });
      expect(many.status).toBe(200);
      expect(new Set((await many.json()).deleted)).toEqual(new Set([batchA, batchB]));
      expect(await eventCount(gateway.db, batchA)).toBe(0);
      expect(await eventCount(gateway.db, batchB)).toBe(0);
      const left = await gateway.db
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(inArray(providerAccounts.id, [single, batchA, batchB]));
      expect(left).toHaveLength(0);
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });

  test("a tenant cannot purge another tenant's account history", async () => {
    const owner = await createWorld({ apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] } });
    const other = await createWorld({ apiKeyOptions: { scopes: ["dashboard:read", "dashboard:write"] } });
    const gateway = await createTestGateway();
    try {
      const victim = await owner.addAccount({ tenantId: owner.tenantId, label: "victim" });
      await seedEvents(gateway.db, victim, 30);
      const single = await gateway.request(`/console/api/accounts/${victim}`, { method: "DELETE", headers: { authorization: `Bearer ${other.token}` } });
      expect(single.status).toBe(404);
      const batch = await gateway.json("/console/api/accounts/batch-delete", { accountIds: [victim] }, { token: other.token });
      expect((await batch.json()).missing).toEqual([victim]);
      expect(await eventCount(gateway.db, victim)).toBe(30);
    } finally {
      await gateway.close();
      await other.cleanup();
      await owner.cleanup();
    }
  });

  test("retention prunes only events older than the cutoff, across batches", async () => {
    const world = await createWorld();
    const gateway = await createTestGateway();
    try {
      const account = await world.addAccount({ tenantId: world.tenantId, label: "aged" });
      await seedEvents(gateway.db, account, 2500, 10 * 86_400_000);
      await seedEvents(gateway.db, account, 40, 60_000);
      const pruned = await pruneHealthEvents(gateway.db, new Date(Date.now() - 7 * 86_400_000));
      expect(pruned).toBeGreaterThanOrEqual(2500);
      expect(await eventCount(gateway.db, account)).toBe(40);
      expect(await purgeHealthEventsForAccounts(gateway.db, [account])).toBe(40);
      expect(await purgeHealthEventsForAccounts(gateway.db, [])).toBe(0);
    } finally {
      await gateway.close();
      await world.cleanup();
    }
  });
});
