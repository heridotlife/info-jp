import type { CurrencyCode, ObservedRateSet } from '../types/remittance';
import type { RateAdapter } from './sources';
import { RATE_ADAPTERS } from './sources';

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
 * Mid-market rates are a separate read-through (src/lib/rates.ts, 10-min
 * TTL). When a mid-market table is available, fetched observed rates get a
 * cheap sanity check (below) before being cached.
 */

/** Observed-rate cache lifetime: 12 h (`expirationTtl` for every KV put). */
export const OBSERVED_TTL_SECONDS = 12 * 60 * 60; // 43 200 s

/** Per-adapter fetch timeout (one AbortSignal.timeout per adapter). */
export const PER_ADAPTER_TIMEOUT_MS = 8_000;

/** Overall cold-start budget; adapters unsettled at expiry are abandoned. */
export const OVERALL_BUDGET_MS = 10_000;

const kvKey = (providerId: string): string => `observed:${providerId}:v1`;

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
 * bugs (e.g. a CNY rate quoted per ¥10,000). Corridors without a mid-market
 * value pass through unchecked ("where available").
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
    if (midRate === undefined || withinSanityBound(rate, midRate)) {
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
  const due: Array<{ providerId: string; adapter: RateAdapter }> = [];

  // 1. KV read-through check: a present entry is fresh by construction.
  for (const providerId of providerIds) {
    let cached: unknown;
    try {
      cached = kv ? await kv.get<unknown>(kvKey(providerId), 'json') : null;
    } catch {
      cached = null; // KV read error → treat as miss, fetch the adapter
    }
    if (isUsableSet(cached)) {
      byProvider[providerId] = cached;
    } else {
      const adapter = adapters[providerId];
      if (adapter) due.push({ providerId, adapter });
      // No adapter → stays absent (modeled). Not an error: expected state.
    }
  }

  // 2. Cold-start fan-out: every due adapter fetches in parallel, each under
  //    its own timeout signal, all under the overall budget. Results are
  //    collected as they settle so a budget expiry keeps whatever landed.
  if (due.length > 0) {
    const pending = new Set(due.map((d) => d.providerId));
    const worker = (async () => {
      await Promise.allSettled(
        due.map(async ({ providerId, adapter }) => {
          try {
            // One timeout signal for the WHOLE adapter (all its fetches).
            const signal = AbortSignal.timeout(perAdapterTimeoutMs);
            const timedFetch = (<typeof fetch>(<unknown>((url: unknown, init?: RequestInit) =>
              fetch(url as RequestInfo, { ...init, signal }))));
            const fetched = await adapter.fetchRates(timedFetch);
            const bounded = options.midMarketRates
              ? applySanityBound(fetched, options.midMarketRates)
              : fetched;
            if (Object.keys(bounded.rates).length === 0) {
              throw new Error('sanity-bound reject: no corridor rates within [mid×0.85, mid×1.02]');
            }
            byProvider[providerId] = bounded;
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
            fetchErrors[providerId] = errorMessage(err);
          }
        }),
      );
    })();

    // 3. Overall budget: whatever has not settled by expiry is abandoned to
    //    the fallback ladder (reported as an error, never awaited past it).
    const budget = new Promise<void>((resolve) => setTimeout(resolve, overallBudgetMs));
    await Promise.race([worker, budget]);
    for (const providerId of pending) {
      fetchErrors[providerId] = 'abandoned: overall fetch budget exceeded';
    }
  }

  return { byProvider, fetchErrors };
}
