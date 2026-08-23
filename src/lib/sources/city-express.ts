import type { CurrencyCode, ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  CITY EXPRESS RATE ADAPTER (clean JSON rate board)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET https://exchange.city-remit.net/api/rates
 *
 *   {"updated_at":"2026-08-23T10:00:55.375Z","rates":[
 *      {"name":"NEPAL","iso2":"np","currency":"NPR","rate":0.954},
 *      {"name":"GOLDENRATE","iso2":"np","currency":"NPR","rate":0.9605},  ← promo
 *      {"name":"INDONESIA","iso2":"id","currency":"IDR","rate":111.2},
 *      … 20 rows …]}
 *
 * ⚠️  GOLDENRATE rows are PROMO rates (live 2026-08-23: NPR promo 0.9605 vs
 *     standard 0.954 — the promo is *better*, so keeping it would let a
 *     non-durable rate win comparisons). Per plan "Approach" §9 they are
 *     DROPPED ENTIRELY — the board also carries the standard row for the
 *     same currency, so no information is lost. A `name === 'GOLDENRATE'`
 *     row can never reach an ObservedRateSet or a `best-value` tag
 *     (fixture-proven).
 *
 * QUOTING UNITS: `rate` is per-1-JPY (IDR 111.2 vs mid 111.37 → −0.15%).
 *
 * FEES: the payload carries NO fee/commission fields (verified 2026-08-23) —
 * the registry keeps placeholder tiers flagged UNVERIFIED in
 * docs/rate-sources.md (plan gap list).
 */

export const CITY_EXPRESS_ENDPOINT = 'https://exchange.city-remit.net/api/rates';

/** Human label carried on the ObservedRateSet. */
export const CITY_EXPRESS_SOURCE_LABEL =
  'exchange.city-remit.net/api/rates JSON board (GOLDENRATE promo rows dropped)';

/** The promo row marker — dropped before any rate is stored. */
export const PROMO_ROW_NAME = 'GOLDENRATE';

/**
 * Corridors declared by this adapter — the registry's supportedCurrencies
 * for City Express (each verified live 2026-08-23). The board also quotes
 * currencies outside our union (LKR, MNT, PKR, MMK, MYR, AED, AUD, SGD) and
 * USD rows for non-US payout countries (KH/NA) — not declared.
 */
const DECLARED_CURRENCIES: readonly CurrencyCode[] = [
  'IDR',
  'NPR',
  'VND',
  'PHP',
  'INR',
  'BDT',
  'THB',
  'KRW',
];

/** Minimal shape of one board row. */
interface CityRateRow {
  name?: string;
  currency?: string;
  rate?: number;
}

/** Descriptive UA — we are a comparison site reading a public rate board. */
const USER_AGENT = 'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Parse the board into per-1-JPY rates for our declared corridors.
 * GOLDENRATE rows are dropped; a standard row later in the array still wins
 * its corridor (first non-promo row per currency is kept). Malformed rows
 * are skipped, never thrown.
 */
export function parseRatesBoard(body: unknown): Partial<Record<CurrencyCode, number>> {
  if (typeof body !== 'object' || body === null) return {};
  const rows = (body as { rates?: unknown }).rates;
  if (!Array.isArray(rows)) return {};
  const rates: Partial<Record<CurrencyCode, number>> = {};
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as CityRateRow;
    if (r.name === PROMO_ROW_NAME) continue; // promo — dropped entirely (§9)
    const currency = typeof r.currency === 'string' ? r.currency : '';
    if (!(DECLARED_CURRENCIES as readonly string[]).includes(currency)) continue;
    if (typeof r.rate !== 'number' || !Number.isFinite(r.rate) || r.rate <= 0) continue;
    if (rates[currency as CurrencyCode] === undefined) {
      rates[currency as CurrencyCode] = r.rate;
    }
  }
  return rates;
}

/**
 * Fetch City Express's live board.
 * HTTP error / unusable payload → one provider-level reject (the read-through
 * resolver catches it and the row falls to modeled).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchCityExpressRates(
  fetchImpl: typeof fetch = fetch,
): Promise<ObservedRateSet> {
  let rates: Partial<Record<CurrencyCode, number>>;
  try {
    const res = await fetchImpl(CITY_EXPRESS_ENDPOINT, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`rates API HTTP ${res.status}`);
    rates = parseRatesBoard(await res.json());
    if (Object.keys(rates).length === 0) {
      throw new Error('no declared corridors parsed from board');
    }
  } catch (err) {
    throw new Error(`City Express: board fetch failed (${(err as Error).message})`);
  }

  return {
    providerId: 'city-express',
    rates,
    fetchedAt: new Date().toISOString(),
    source: CITY_EXPRESS_SOURCE_LABEL,
    method: 'live',
  };
}
