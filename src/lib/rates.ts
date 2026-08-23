import type { CurrencyCode } from '../types/remittance';
import { CURRENCY_CODES } from './currencies';

/**
 * Mid-market FX rate table, expressed as: 1 JPY → `rates[code]` of that currency.
 */
export interface RateTable {
  base: 'JPY';
  rates: Partial<Record<CurrencyCode, number>>;
  /** ISO timestamp when the table was produced. */
  fetchedAt: string;
  /** `'open.er-api.com'` on success, `'fallback'` if the upstream failed. */
  source: string;
}

const CACHE_KEY = 'midmarket:JPY:v1';

/**
 * KV cache lifetime. The brief asks for 5–15 minutes to stay fast while
 * avoiding upstream rate limits. 10 minutes is a good middle ground.
 */
export const RATE_TTL_SECONDS = 10 * 60;

/**
 * Upstream mid-market provider. open.er-api.com is free, keyless, and returns
 * rates with `base=JPY` where each value is "units of X per 1 JPY" — exactly
 * our model. Swap this for a paid feed (e.g. OpenExchangeRates, Fixer) by
 * editing `fetchFromUpstream()` only.
 */
const UPSTREAM_URL = 'https://open.er-api.com/v6/latest/JPY';

/**
 * Static fallback so the simulator NEVER hard-fails if the upstream is down.
 * Rough 1 JPY → X values; refresh occasionally. These are only used when both
 * KV and the live fetch are unavailable.
 */
const FALLBACK_RATES: Record<CurrencyCode, number> = {
  IDR: 108.0,
  PHP: 0.382,
  VND: 168.0,
  INR: 0.564,
  NPR: 0.902,
  BDT: 0.788,
  CNY: 0.0463,
  THB: 0.233,
  KRW: 8.92,
  USD: 0.00641,
  EUR: 0.00592,
};

function fallbackTable(): RateTable {
  return {
    base: 'JPY',
    rates: { ...FALLBACK_RATES },
    fetchedAt: new Date().toISOString(),
    source: 'fallback',
  };
}

/** Keep only the currencies we care about from the upstream payload. */
function pickSupported(raw: Record<string, number>): Partial<Record<CurrencyCode, number>> {
  const out: Partial<Record<CurrencyCode, number>> = {};
  for (const code of CURRENCY_CODES) {
    const value = raw[code];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[code] = value;
    }
  }
  return out;
}

async function fetchFromUpstream(): Promise<RateTable> {
  try {
    const res = await fetch(UPSTREAM_URL, {
      // Let Cloudflare's edge cache help too; KV is the primary cache.
      cf: { cacheTtl: RATE_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) throw new Error(`Upstream ${res.status}`);

    const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (data.result !== 'success' || !data.rates) throw new Error('Malformed upstream payload');

    const rates = pickSupported(data.rates);
    // Guard against a partial payload wiping out corridors we rely on.
    if (Object.keys(rates).length < CURRENCY_CODES.length) {
      for (const code of CURRENCY_CODES) {
        if (rates[code] === undefined) rates[code] = FALLBACK_RATES[code];
      }
    }
    return { base: 'JPY', rates, fetchedAt: new Date().toISOString(), source: 'open.er-api.com' };
  } catch {
    return fallbackTable();
  }
}

/**
 * Get the current mid-market rate table, using KV as a read-through cache.
 *
 * Flow:
 *   1. Try KV (`RATES_KV`). On a hit, return immediately — fast + free.
 *   2. On a miss, fetch the live rates and write them to KV with a TTL so the
 *      next 10 minutes of requests are served from cache.
 *   3. If everything fails, fall back to the static table so the UI still works.
 *
 * `kv` is optional so the calculator remains usable in plain Node/tests where
 * no Cloudflare binding exists.
 */
export async function getRates(kv?: KVNamespace): Promise<RateTable> {
  if (kv) {
    try {
      const cached = await kv.get<RateTable>(CACHE_KEY, 'json');
      if (cached && cached.rates && Object.keys(cached.rates).length > 0) {
        return cached;
      }
    } catch {
      // Ignore KV read errors and fall through to a live fetch.
    }
  }

  const fresh = await fetchFromUpstream();

  if (kv && fresh.source !== 'fallback') {
    try {
      await kv.put(CACHE_KEY, JSON.stringify(fresh), { expirationTtl: RATE_TTL_SECONDS });
    } catch {
      // A failed cache write is non-fatal; the caller still gets fresh rates.
    }
  }

  return fresh;
}

/**
 * Force-refresh the cache, bypassing any existing KV entry. Intended for a
 * scheduled Cron Worker (see workers/rate-refresh/) so the KV cache is kept
 * warm and user requests never pay the upstream latency.
 */
export async function refreshRates(kv: KVNamespace): Promise<RateTable> {
  const fresh = await fetchFromUpstream();
  if (fresh.source !== 'fallback') {
    await kv.put(CACHE_KEY, JSON.stringify(fresh), { expirationTtl: RATE_TTL_SECONDS });
  }
  return fresh;
}
