import type { CurrencyCode, ObservedRateSet, SourceStatusInfo } from '../types/remittance';
import type { RateAdapter } from './sources';
import { RATE_ADAPTERS } from './sources';
import { MANUAL_RATES } from '../data/manual-rates';
import { isTransientNetworkError, withinCorridorBand } from './sources/shared';

/**
 * ============================================================================
 *  OBSERVED-RATE READ-THROUGH RESOLVER (rev 4 — no cron anywhere)
 * ============================================================================
 *
 * The ONLY fetch path for per-provider observed rates. Every fetch happens
 * inside a user-facing request:
 *
 *   request → per provider: KV get observed:<providerId>:v1
 *     ├─ hit  (present ⇒ age < 12 h by construction — KV TTL deletes it) →
 *     │        use it; ZERO outbound fetches
 *     └─ miss → fetch the adapter live NOW (all due adapters in parallel,
 *              each under an ~8 s per-adapter timeout, together under an
 *              ~10 s overall budget) → kv.put(..., 12 h TTL) → use the
 *              fetched value directly (never re-read KV in the same request)
 *
 * Partial failure is success: a provider that fails (network, timeout,
 * sanity-bound reject, no adapter) resolves `undefined` and its row falls
 * down the fallback ladder manual → modeled. Failures are collected in
 * `fetchErrors` — this resolver NEVER throws past itself.
 *
 * Ladder (plan "Approach" §5): observed (KV hit or live adapter fetch) →
 * manual (checked-in `src/data/manual-rates.ts`, never KV-cached; entries
 * older than 24 h are expired and fall through) → modeled (no entry).
 *
 * Mid-market rates are a separate read-through (src/lib/rates.ts, 10-min
 * TTL). When a mid-market table is available, fetched observed rates get a
 * cheap sanity check (below) before being cached.
 */

/** Observed-rate cache lifetime: 12 h (`expirationTtl` for every KV put). */
export const OBSERVED_TTL_SECONDS = 12 * 60 * 60; // 43 200 s

/** Per-adapter fetch timeout (one shared deadline across both attempts). */
export const PER_ADAPTER_TIMEOUT_MS = 8_000;

/** Overall cold-start budget; adapters unsettled at expiry are abandoned. */
export const OVERALL_BUDGET_MS = 10_000;

/** Retry only while at least this much of the adapter deadline remains. */
export const RETRY_FLOOR_MS = 1_500;

/**
 * Max single-retries per cold request (task 22). Caps the worst-case
 * subrequest count under the free plan's 50/request limit — see the math in
 * src/lib/sources/index.ts.
 */
export const MAX_RETRIES_PER_REQUEST = 5;

/** How long a recorded fetch failure stays readable in KV (`status` keys). */
export const STATUS_TTL_SECONDS = 7 * 24 * 60 * 60; // 604 800 s

const kvKey = (providerId: string): string => `observed:${providerId}:v1`;
const statusKey = (providerId: string): string => `observed:${providerId}:status:v1`;

// ---------------------------------------------------------------------------
// Staleness classification (plan "Approach" §11)
// ---------------------------------------------------------------------------

export type Staleness = 'fresh' | 'stale' | 'expired';

/** Age < 12 h. Any observed entry present in KV is fresh by construction. */
export const FRESH_MS = 12 * 60 * 60 * 1000;
/** Age 12–24 h: amber "stale" marker (in practice reachable only for manual
 *  rates — observed entries self-delete from KV before entering this band). */
export const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Classify a rate's staleness from its `fetchedAt` timestamp.
 * Absent/unparseable timestamps classify as `expired` (fall down the ladder).
 */
export function classifyStaleness(fetchedAt: string | undefined, now = Date.now()): Staleness {
  if (!fetchedAt) return 'expired';
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return 'expired';
  const age = now - t;
  if (age < FRESH_MS) return 'fresh';
  if (age < STALE_MS) return 'stale';
  return 'expired';
}

// ---------------------------------------------------------------------------
// Sanity bound (plan "Verification" §3)
// ---------------------------------------------------------------------------

/**
 * Observed corridor rates must sit within [mid × 0.85, mid × 1.02] — wide
 * enough for honest provider spreads, tight enough to catch quoting-unit
 * bugs (e.g. a CNY rate quoted per ¥10,000) — AND inside the corridor's
 * absolute band (src/lib/sources/shared.ts). Corridors without a mid-market
 * value still get the absolute-band check (closes the "no mid → unchecked"
 * gap).
 */
export function withinSanityBound(rate: number, mid: number): boolean {
  return rate >= mid * 0.85 && rate <= mid * 1.02;
}

function applySanityBound(
  set: ObservedRateSet,
  mid: Partial<Record<CurrencyCode, number>>,
): ObservedRateSet {
  const rates: Partial<Record<CurrencyCode, number>> = {};
  for (const [code, rate] of Object.entries(set.rates) as Array<[CurrencyCode, number]>) {
    const midRate = mid[code];
    const relativeOk = midRate === undefined || withinSanityBound(rate, midRate);
    if (relativeOk && withinCorridorBand(rate, code)) {
      rates[code] = rate;
    }
    // else: corridor rejected (dropped silently — recorded as an error below
    // when nothing survives)
  }
  return { ...set, rates };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ObservedRatesResolution {
  /** Successfully resolved sets (KV hits + live fetches), keyed by providerId. */
  byProvider: Record<string, ObservedRateSet>;
  /** Provider-level failure messages for `meta.fetchErrors` (never thrown). */
  fetchErrors: Record<string, string>;
  /** Per-source health surfaced as `meta.sourceStatus` (task 22). */
  sourceStatus: Record<string, SourceStatusInfo>;
}

export interface ResolveOptions {
  /** Adapter map override (tests). Defaults to the global registry. */
  adapters?: Readonly<Record<string, RateAdapter>>;
  /** Mid-market table for the cheap sanity check, when available. */
  midMarketRates?: Partial<Record<CurrencyCode, number>>;
  perAdapterTimeoutMs?: number;
  overallBudgetMs?: number;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Is a KV entry shaped enough to use as an ObservedRateSet? */
function isUsableSet(value: unknown): value is ObservedRateSet {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ObservedRateSet).providerId === 'string' &&
    typeof (value as ObservedRateSet).fetchedAt === 'string' &&
    typeof (value as ObservedRateSet).rates === 'object' &&
    Object.keys((value as ObservedRateSet).rates ?? {}).length > 0
  );
}

/**
 * Resolve observed rate sets for the given providers, read-through KV.
 * Never rejects — failures land in `fetchErrors` and the provider simply has
 * no entry here (callers fall back manual → modeled).
 */
export async function resolveObservedRates(
  providerIds: readonly string[],
  kv?: KVNamespace,
  options: ResolveOptions = {},
): Promise<ObservedRatesResolution> {
  const adapters = options.adapters ?? RATE_ADAPTERS;
  const perAdapterTimeoutMs = options.perAdapterTimeoutMs ?? PER_ADAPTER_TIMEOUT_MS;
  const overallBudgetMs = options.overallBudgetMs ?? OVERALL_BUDGET_MS;

  const byProvider: Record<string, ObservedRateSet> = {};
  const fetchErrors: Record<string, string> = {};
  const sourceStatus: Record<string, SourceStatusInfo> = {};
  const due: Array<{ providerId: string; adapter: RateAdapter }> = [];

  // 1. KV read-through check: a present entry is fresh by construction. The
  //    per-source `status` key (last failure) is read in the same pass for
  //    adapter providers so `meta.sourceStatus` survives warm requests.
  for (const providerId of providerIds) {
    let cached: unknown;
    try {
      cached = kv ? await kv.get<unknown>(kvKey(providerId), 'json') : null;
    } catch {
      cached = null; // KV read error → treat as miss, fetch the adapter
    }
    if (isUsableSet(cached)) {
      byProvider[providerId] = cached;
      if (adapters[providerId]) {
        sourceStatus[providerId] = { lastSuccessAt: cached.fetchedAt };
      }
    } else {
      const adapter = adapters[providerId];
      if (adapter) {
        due.push({ providerId, adapter });
        let status: unknown;
        try {
          status = kv ? await kv.get<unknown>(statusKey(providerId), 'json') : null;
        } catch {
          status = null;
        }
        if (typeof status === 'object' && status !== null) {
          const s = status as SourceStatusInfo;
          if (s.lastFailureAt || s.lastError) sourceStatus[providerId] = { ...s };
        }
      }
      // No adapter → stays absent (modeled). Not an error: expected state.
    }
  }

  // 2. Cold-start fan-out: every due adapter fetches in parallel, each under
  //    its own deadline, all under the overall budget. Results are collected
  //    as they settle so a budget expiry keeps whatever landed. A TRANSIENT
  //    failure (network/timeout/5xx) gets one retry inside the SAME adapter
  //    deadline, while a per-request retry budget caps worst-case
  //    subrequests (task 22). One adapter's failure never touches another.
  if (due.length > 0) {
    const pending = new Set(due.map((d) => d.providerId));
    let retryBudget = MAX_RETRIES_PER_REQUEST;

    const timedFetchFor = (deadline: number): typeof fetch =>
      (<typeof fetch>(<unknown>((url: unknown, init?: RequestInit) =>
        fetch(url as RequestInfo, {
          ...init,
          signal: AbortSignal.timeout(Math.max(200, deadline - Date.now())),
        }))));

    const worker = (async () => {
      await Promise.allSettled(
        due.map(async ({ providerId, adapter }) => {
          const deadline = Date.now() + perAdapterTimeoutMs;
          const attempt = (): Promise<ObservedRateSet> => adapter.fetchRates(timedFetchFor(deadline));
          try {
            let fetched: ObservedRateSet;
            try {
              fetched = await attempt();
            } catch (first) {
              const transient = isTransientNetworkError(first);
              const room = deadline - Date.now() >= RETRY_FLOOR_MS;
              if (!transient || !room || retryBudget <= 0) throw first;
              retryBudget -= 1;
              fetched = await attempt(); // the single retry
            }
            const bounded = applySanityBound(fetched, options.midMarketRates ?? {});
            if (Object.keys(bounded.rates).length === 0) {
              throw new Error(
                'sanity-bound reject: no corridor rates within [mid×0.85, mid×1.02] / corridor band',
              );
            }
            byProvider[providerId] = bounded;
            sourceStatus[providerId] = { lastSuccessAt: bounded.fetchedAt };
            pending.delete(providerId);
            // Cache for the next 12 h; a failed write is non-fatal.
            try {
              await kv?.put(kvKey(providerId), JSON.stringify(bounded), {
                expirationTtl: OBSERVED_TTL_SECONDS,
              });
            } catch {
              /* keep the fetched set, skip the cache */
            }
          } catch (err) {
            pending.delete(providerId);
            const message = errorMessage(err);
            fetchErrors[providerId] = message;
            sourceStatus[providerId] = { lastFailureAt: new Date().toISOString(), lastError: message };
            // Persist the failure for warm-request visibility (7 d TTL);
            // a failed write is non-fatal.
            try {
              await kv?.put(
                statusKey(providerId),
                JSON.stringify(sourceStatus[providerId]),
                { expirationTtl: STATUS_TTL_SECONDS },
              );
            } catch {
              /* status is best-effort */
            }
          }
        }),
      );
    })();

    // 3. Overall budget: whatever has not settled by expiry is abandoned to
    //    the fallback ladder (reported as an error, never awaited past it).
    const budget = new Promise<void>((resolve) => setTimeout(resolve, overallBudgetMs));
    await Promise.race([worker, budget]);
    for (const providerId of pending) {
      const message = 'abandoned: overall fetch budget exceeded';
      fetchErrors[providerId] = message;
      sourceStatus[providerId] = { lastFailureAt: new Date().toISOString(), lastError: message };
    }
  }

  // 4. Manual rung: checked-in rates fill providers with no observed set.
  //    Never KV-cached (they ship in the bundle); expired entries (> 24 h)
  //    fall through to modeled. `stale` (12–24 h) still serves — the UI
  //    shows the amber badge + update date. The same sanity bound guards
  //    against checked-in typos when a mid-market table is available.
  for (const providerId of providerIds) {
    if (byProvider[providerId] !== undefined) continue;
    const manual = MANUAL_RATES.find((entry) => entry.providerId === providerId);
    if (!manual || !isUsableSet(manual)) continue;
    if (classifyStaleness(manual.fetchedAt) === 'expired') continue;
    const bounded = applySanityBound(manual, options.midMarketRates ?? {});
    if (Object.keys(bounded.rates).length > 0) {
      byProvider[providerId] = bounded;
    }
  }

  return { byProvider, fetchErrors, sourceStatus };
}
