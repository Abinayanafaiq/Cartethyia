/**
 * Day × model usage for one provider, with every finished day cached.
 *
 * The matrix aggregates every telemetry event the provider served over the
 * window. On a lite (SQLite) install that is a synchronous scan of millions of
 * rows — measured at ~2.5 s warm and ~14 s cold on a 3M-event database — and
 * because bun:sqlite runs on the event loop, the whole gateway stalls for the
 * duration. The dashboard re-reads the matrix after every provider/account
 * mutation, so deleting one account froze the router for seconds.
 *
 * Days before today never change, so they are read once per UTC day and kept;
 * each call only re-reads today's events, which the `(tenant, provider,
 * created_at)` index serves in milliseconds. The window is aligned to whole
 * UTC days (`days` buckets ending with today), which is also what the calendar
 * card draws.
 */
import type { ProviderUsageDayRow } from "../../../observability/event-query";

const DAY_MS = 86_400_000;
/** Distinct (tenant, provider, days) entries kept; old ones are evicted first. */
const MAX_ENTRIES = 256;

export type ProviderUsageMatrixReader = (
  tenantId: string,
  providerId: string,
  since: Date,
  until?: Date,
) => Promise<readonly ProviderUsageDayRow[]>;

interface PastEntry {
  readonly dayKey: string;
  readonly rows: Promise<readonly ProviderUsageDayRow[]>;
}

export function createCachedProviderUsageMatrix(
  read: ProviderUsageMatrixReader,
  now: () => number = Date.now,
): (tenantId: string, providerId: string, days: number) => Promise<readonly ProviderUsageDayRow[]> {
  const past = new Map<string, PastEntry>();
  return async (tenantId, providerId, days) => {
    const todayStartMs = Math.floor(now() / DAY_MS) * DAY_MS;
    const todayStart = new Date(todayStartMs);
    const dayKey = todayStart.toISOString().slice(0, 10);
    const span = Math.max(1, Math.trunc(days));
    const since = new Date(todayStartMs - (span - 1) * DAY_MS);
    const key = `${tenantId}\u0000${providerId}\u0000${span}`;
    let entry = past.get(key);
    if (entry === undefined || entry.dayKey !== dayKey) {
      // The promise is cached, not the rows, so concurrent callers share one
      // scan; a failed scan is dropped so the next call retries it.
      const rows = span > 1 ? read(tenantId, providerId, since, todayStart) : Promise.resolve([]);
      entry = { dayKey, rows };
      past.delete(key);
      past.set(key, entry);
      rows.catch(() => {
        if (past.get(key) === entry) past.delete(key);
      });
      while (past.size > MAX_ENTRIES) {
        const oldest = past.keys().next();
        if (oldest.done === true) break;
        past.delete(oldest.value);
      }
    }
    const [before, today] = await Promise.all([entry.rows, read(tenantId, providerId, todayStart)]);
    return [...before, ...today];
  };
}
