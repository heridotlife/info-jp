import type { CurrencyCode, ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  WISE RATE ADAPTER (public quote gateway)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET https://wise.com/gateway/v1/quotes/?source=JPY&target=<CCY>&rateType=FIXED&sourceAmount=10000
 *
 * One GET per corridor. Response (2026-08-23, IDR):
 *   {"source":"JPY","target":"IDR","sourceAmount":10000,"targetAmount":1077931,
 *    "type":"REGULAR","rate":111.001,"createdTime":"...","rateType":"FIXED",
 *    "deliveryEstimate":"...","fee":289.0,"feeDetails":{...},"ofSourceAmount":true}
 *
 * ⚠️  rateType MUST be FIXED — REFERENCE / NOMINAL answer HTTP 400 (asserted
 *     by fixture test + live-reverified 2026-08-23). api.wise.com/v1/rates
 *     stays token-gated (`missing_token`); this gateway is anonymous.
 *
 * QUOTING UNITS: `rate` is the per-1-JPY rate Wise applies (their claimed
 * mid-market). Arithmetic check, IDR 2026-08-23:
 *   (sourceAmount − fee) × rate = (10 000 − 289) × 111.001 = 1 077 931 =
 *   targetAmount ✓ — so `rate` is canonical per-1-JPY, no normalization
 *   needed, and the quote's `fee` (¥289 at ¥10k) is amount-aware → the fee
 *   model stays percentage (documented gap, docs/rate-sources.md).
 *
 * AMOUNT-AWARE QUOTES (plan "Approach" §8): the gateway prices a specific
 * send amount; we quote at the canonical reference amount (¥10,000) and
 * record it as `quoteAmountJPY` — the UI footnotes "quoted at ¥10,000".
 *
 * Wise is the mid-market sanity anchor: observed markup ≈ 0 expected
 * (live 2026-08-23: IDR 111.001 vs mid 111.370 → −0.33%, all 11 corridors
 * within ±0.5%), printed by `npm run verify:rates`.
 */

export const WISE_QUOTE_ENDPOINT = 'https://wise.com/gateway/v1/quotes/';

/** Human label carried on the ObservedRateSet. */
export const WISE_SOURCE_LABEL = 'wise.com quote gateway (gateway/v1/quotes/, rateType=FIXED, ¥10,000 quote)';

/** Canonical reference amount for amount-aware quote APIs (plan §8). */
export const WISE_QUOTE_AMOUNT_JPY = 10_000;

/**
 * Corridors probed by this adapter — Wise's `supportedCurrencies` in the
 * provider registry. All 11 answered live on 2026-08-23.
 */
const PROBE_CURRENCIES: readonly CurrencyCode[] = [
  'USD',
  'EUR',
  'INR',
  'PHP',
  'IDR',
  'VND',
  'CNY',
  'NPR',
  'BDT',
  'THB',
  'KRW',
];

/** Minimal shape of one corridor's quote response. */
interface WiseQuoteResponse {
  rate?: number;
  rateType?: string;
  target?: string;
}

/** Descriptive UA — we are a comparison site reading a public quote gateway. */
const USER_AGENT = 'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/** Build the quote URL for one corridor. Exported for the request-shape test. */
export function quoteUrl(target: CurrencyCode): string {
  const params = new URLSearchParams({
    source: 'JPY',
    target,
    rateType: 'FIXED', // ⚠️ REFERENCE / NOMINAL → HTTP 400 (pinned pitfall)
    sourceAmount: String(WISE_QUOTE_AMOUNT_JPY),
  });
  return `${WISE_QUOTE_ENDPOINT}?${params.toString()}`;
}

/**
 * Parse one quote body into a usable rate, or `undefined` to skip.
 * The response `rateType` must still say FIXED — a silent API change to a
 * reference/nominal rate would not be the applied rate.
 */
export function parseQuote(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = body as WiseQuoteResponse;
  if (data.rateType !== 'FIXED') return undefined;
  if (typeof data.rate !== 'number' || !Number.isFinite(data.rate) || data.rate <= 0) {
    return undefined;
  }
  return data.rate;
}

/**
 * Fetch Wise's live quote rates for every probe corridor.
 *
 * Per-corridor problems (HTTP 400/5xx, malformed payload) skip that corridor;
 * the adapter only rejects when NOTHING parsed (so the read-through resolver
 * can record a provider-level failure). A corridor Wise stops quoting simply
 * falls down the fallback ladder.
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchWiseRates(fetchImpl: typeof fetch = fetch): Promise<ObservedRateSet> {
  const rates: Partial<Record<CurrencyCode, number>> = {};

  await Promise.all(
    PROBE_CURRENCIES.map(async (currency) => {
      try {
        const res = await fetchImpl(quoteUrl(currency), {
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        });
        if (!res.ok) return; // per-corridor skip (400 = wrong rateType, 5xx, …)
        const json: unknown = await res.json();
        const rate = parseQuote(json);
        if (rate !== undefined) {
          rates[currency] = rate;
        }
      } catch {
        // Network/parse failure for one corridor — skip it, never throw.
      }
    }),
  );

  if (Object.keys(rates).length === 0) {
    throw new Error('Wise: no corridors parsed from quote gateway');
  }

  return {
    providerId: 'wise',
    rates,
    fetchedAt: new Date().toISOString(),
    source: WISE_SOURCE_LABEL,
    method: 'live',
    quoteAmountJPY: WISE_QUOTE_AMOUNT_JPY,
  };
}
