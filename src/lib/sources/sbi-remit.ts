import type { CurrencyCode, ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  SBI REMIT RATE ADAPTER
 * ============================================================================
 *
 * Source (research P1 + P2, live-reverified from this egress 2026-08-23):
 *   POST https://www.remit.co.jp/kaigaisoukin/exchangeratecommission/exchange/
 *   Content-Type: application/x-www-form-urlencoded
 *   body: currency=<CCY>&mode=receive&base=JPY
 *
 * One POST per currency; the response is JSON:
 *   {"rate":"111.110000","last_update":"2026-08-22 14:30:51",
 *    "rates":{"<date>":"<rate>", ...7-day history...}}
 *
 * A currency the board does not quote (currently INR, BDT) returns
 *   {"rate":null,"last_update":0,...}  →  skipped per-currency, never thrown.
 *
 * QUOTING UNITS — live-verified 2026-08-23 (see fixtures/page-options.html):
 *   The calculator *page* displays some currencies per ¥100/¥10,000 via the
 *   `data-rate` attribute on each <option> (USD ×100, CNY/BRL ×10000 — the
 *   page shows "rate × data-rate" per `data-rate` yen). The POST API,
 *   however, returns `rate` already in the canonical per-1-JPY unit for
 *   EVERY currency, including CNY and THB:
 *     CNY 0.0419 vs live mid-market 0.04240 → −1.2% (sane corridor markup)
 *     THB 0.2035 vs live mid-market 0.20586 → −1.1%
 *   Had the API returned display units, CNY would be ~419. DISPLAY_UNITS is
 *   pinned here for provenance; if the API ever changes quoting, the fix is
 *   `toPerJPY()` in ONE place — and the resolver's sanity bound
 *   [mid × 0.85, mid × 1.02] rejects unit regressions before users see them.
 */

export const SBI_REMIT_ENDPOINT =
  'https://www.remit.co.jp/kaigaisoukin/exchangeratecommission/exchange/';

/** Human label carried on the ObservedRateSet. */
export const SBI_REMIT_SOURCE_LABEL = 'remit.co.jp rate board (kaigaisoukin/exchangeratecommission/exchange/)';

/**
 * Page-display quoting units (`data-rate`), pinned 2026-08-23 — provenance
 * only. Keyed by string: the board lists currencies beyond our CurrencyCode
 * union (GBP, BRL, …), which is exactly the point of the record.
 */
export const DISPLAY_UNITS: Readonly<Record<string, number>> = {
  USD: 100,
  CNY: 10_000,
  BRL: 10_000,
  // All other board currencies (PHP, VND, IDR, THB, NPR, …) display per ¥1.
};

/**
 * Corridors probed by this adapter — SBI Remit's `supportedCurrencies` in the
 * provider registry. INR/BDT currently answer `rate: null` and are skipped.
 */
const PROBE_CURRENCIES: readonly CurrencyCode[] = [
  'IDR',
  'PHP',
  'VND',
  'INR',
  'NPR',
  'BDT',
  'CNY',
  'THB',
];

/** Minimal shape of one currency's POST response. */
interface SbiRateResponse {
  rate?: string | null;
  last_update?: string | number;
}

/** Descriptive UA — we are a comparison site reading a public rate board. */
const USER_AGENT = 'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Normalize a quoted rate into the canonical per-1-JPY unit.
 * The API is verified to already be canonical, so this is the single seam
 * where a future quoting-unit change gets fixed.
 */
export function toPerJPY(quoted: number, _currency: CurrencyCode): number {
  // API values are per-1-JPY (see header). No display-multiplier division.
  return quoted;
}

/** Parse one response body into a usable rate, or `undefined` to skip. */
export function parseRate(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = body as SbiRateResponse;
  if (typeof data.rate !== 'string' || data.rate.trim() === '') return undefined;
  const parsed = Number(data.rate);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  // A numeric/absent last_update (0) marks an unquoted currency — skip those.
  if (typeof data.last_update !== 'string' || data.last_update.trim() === '') return undefined;
  return parsed;
}

/**
 * Fetch SBI Remit's live rates for every probe currency.
 *
 * Per-currency problems (null rate, malformed payload, HTTP error) skip that
 * corridor; the adapter only rejects when NOTHING could be parsed (so the
 * read-through resolver can record a provider-level failure).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchSbiRemitRates(fetchImpl: typeof fetch = fetch): Promise<ObservedRateSet> {
  const rates: Partial<Record<CurrencyCode, number>> = {};

  await Promise.all(
    PROBE_CURRENCIES.map(async (currency) => {
      const body = new URLSearchParams({
        currency,
        mode: 'receive',
        base: 'JPY',
      }).toString();
      try {
        const res = await fetchImpl(SBI_REMIT_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': USER_AGENT,
          },
          body,
        });
        if (!res.ok) return; // per-currency skip
        const json: unknown = await res.json();
        const rate = parseRate(json);
        if (rate !== undefined) {
          rates[currency] = toPerJPY(rate, currency);
        }
      } catch {
        // Network/parse failure for one corridor — skip it, never throw.
      }
    }),
  );

  if (Object.keys(rates).length === 0) {
    throw new Error('SBI Remit: no currencies parsed from rate board');
  }

  return {
    providerId: 'sbi-remit',
    rates,
    fetchedAt: new Date().toISOString(),
    source: SBI_REMIT_SOURCE_LABEL,
    method: 'live',
  };
}
