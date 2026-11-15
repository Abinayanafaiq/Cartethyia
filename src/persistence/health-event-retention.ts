/**
 * Bounded, incremental deletes of `health_events`.
 *
 * Health events are written on every account/pool status transition and were
 * never pruned, so a frequently rate-limited account held tens of thousands
 * of rows (54k measured on one CodeBuddy CN account). Deleting such an account
 * cascaded every row in one statement, and on the lite backend bun:sqlite runs
 * on the event loop: the whole gateway stalled until it finished.
 *
 * Both helpers delete in small batches and yield to the event loop between
 * them, so requests keep being served while a large backlog drains. A batch
 * selects ids first and deletes by id: SQLite only supports `DELETE … LIMIT`
 * behind a compile flag, and the two-step form is identical on PostgreSQL.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import type { CartethyiaDatabase } from "./db-handle";
import { healthEvents, networkPools, providerAccounts } from "./schema";

/** Rows per delete statement: small enough that one batch blocks for tens of ms. */
const HEALTH_EVENT_DELETE_BATCH = 2000;
/** Retention passes stop after this many batches and resume on the next run. */
const MAX_RETENTION_BATCHES_PER_RUN = 500;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function deleteInBatches(
  db: CartethyiaDatabase,
  nextIds: () => Promise<readonly string[]>,
  maxBatches: number,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const ids = await nextIds();
    if (ids.length === 0) break;
    await db.delete(healthEvents).where(inArray(healthEvents.id, [...ids]));
    total += ids.length;
    if (ids.length < HEALTH_EVENT_DELETE_BATCH) break;
    await yieldToEventLoop();
  }
  return total;
}

/**
 * Deletes health events older than `before`, in bounded batches.
 *
 * `health_events` has no index led by `created_at`, so a table-wide
 * `created_at < ?` probe scans every row when nothing has expired yet
 * (~1.1 s for 588k rows, blocking). Every event belongs to exactly one account
 * or one pool (a CHECK constraint), and both have a `(owner, created_at)`
 * index, so the sweep walks owners and lets those indexes find expired rows.
 */
export async function pruneHealthEvents(
  db: CartethyiaDatabase,
  before: Date,
  maxBatches = MAX_RETENTION_BATCHES_PER_RUN,
): Promise<number> {
  const [accounts, pools] = await Promise.all([
    db.select({ id: providerAccounts.id }).from(providerAccounts),
    db.select({ id: networkPools.id }).from(networkPools),
  ]);
  const owners: { readonly column: typeof healthEvents.accountId | typeof healthEvents.networkPoolId; readonly id: string }[] = [
    ...accounts.map((row) => ({ column: healthEvents.accountId, id: row.id })),
    ...pools.map((row) => ({ column: healthEvents.networkPoolId, id: row.id })),
  ];
  let total = 0;
  let budget = maxBatches;
  for (const owner of owners) {
    if (budget <= 0) break;
    const deleted = await deleteInBatches(
      db,
      async () =>
        (
          await db
            .select({ id: healthEvents.id })
            .from(healthEvents)
            .where(and(eq(owner.column, owner.id), lt(healthEvents.createdAt, before)))
            .limit(HEALTH_EVENT_DELETE_BATCH)
        ).map((row) => row.id),
      budget,
    );
    total += deleted;
    // Only delete batches spend the budget; an owner with nothing expired is
    // one index probe and must not stop the sweep before later owners.
    budget -= Math.ceil(deleted / HEALTH_EVENT_DELETE_BATCH);
    await yieldToEventLoop();
  }
  return total;
}

/**
 * Deletes every health event of the given accounts in bounded batches.
 *
 * Callers run this right before deleting the account rows, after they have
 * confirmed the caller may delete those accounts: the FK cascade then has
 * nothing left to do, and the rows go without one long blocking statement.
 */
export async function purgeHealthEventsForAccounts(
  db: CartethyiaDatabase,
  accountIds: readonly string[],
): Promise<number> {
  if (accountIds.length === 0) return 0;
  return deleteInBatches(
    db,
    async () =>
      (
        await db
          .select({ id: healthEvents.id })
          .from(healthEvents)
          .where(inArray(healthEvents.accountId, [...accountIds]))
          .limit(HEALTH_EVENT_DELETE_BATCH)
      ).map((row) => row.id),
    Number.POSITIVE_INFINITY,
  );
}
