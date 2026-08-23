import type { CurrencyCode, ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  JRF (Japan Remit Finance) RATE ADAPTER
 * ============================================================================
 *
 * Source (spike task 20, reverse-engineered from the Vue SPA's axios calls in
 * /js/app.js, live-verified from node AND workerd egress 2026-08-23):
 *   GET https://www.jpremit.com/api/fetch/country/fx/rates/extended
 *   headers: X-Requested-With: XMLHttpRequest (axios default the SPA sets)
 *
 * The /today-rates SPA renders exactly this board: one row per currency with
 * a per-1-JPY `fx_rate` (IDR 111.2 vs mid 111.37 → −0.15%), plus per-payment
 * variants sharing a currency (only Bangladesh: "" headline + Account
 * Deposit + Wallet rows). Rows with an EMPTY fx_rate are unquoted variants —
 * skipped per-currency, never thrown.
 *
 * No session, no CSRF — a plain anonymous GET (their Laravel API even
 * returns its fee schedule on /api/country/service/fee/all, used to verify
 * the IDR fee tiers checked in with this task).
 */

export const JRF_ENDPOINT = 'https://www.jpremit.com/api/fetch/country/fx/rates/extended';

export const JRF_SOURCE_LABEL =
  'jpremit.com today-rates board (api/fetch/country/fx/rates/extended)';

/** Corridors this adapter extracts — JRF's `supportedCurrencies` in the registry. */
const PROBE_CURRENCIES: readonly CurrencyCode[] = ['PHP', 'VND', 'IDR', 'INR', 'NPR', 'THB'];

/** Minimal shape of one extended-board row. */
export interface JrfRateRow {
  currency?: string | null;
  /** Per-1-JPY rate; `""` marks an unquoted payment variant (e.g. BDT headline). */
  fx_rate?: number | string | null;
}

/** Descriptive UA — we are a comparison site reading a public rate board. */
const USER_AGENT =
  'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Parse the extended board into per-corridor rates. First numeric row per
 * currency wins (the headline row; per-payment variants are ignored — for
 * BDT the headline is empty so its Account Deposit row would win, but BDT is
 * not a JRF corridor here). Empty-string / non-finite / non-positive rates
 * skip the corridor.
 */
export function parseRates(body: unknown): Partial<Record<CurrencyCode, number>> {
  if (!Array.isArray(body)) return {};
  const wanted = new Set<string>(PROBE_CURRENCIES);
  const rates: Partial<Record<CurrencyCode, number>> = {};

  for (const row of body as JrfRateRow[]) {
    const code = typeof row?.currency === 'string' ? row.currency : null;
    if (!code || !wanted.has(code)) continue;
    const raw = row.fx_rate;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    if (rates[code as CurrencyCode] === undefined) {
      rates[code as CurrencyCode] = parsed; // headline row first-wins
    }
  }
  return rates;
}

/**
 * Fetch JRF's live rates. Only rejects when NOTHING could be parsed (so the
 * read-through resolver can record a provider-level failure); per-currency
 * gaps are skipped.
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchJrfRates(fetchImpl: typeof fetch = fetch): Promise<ObservedRateSet> {
  const res = await fetchImpl(JRF_ENDPOINT, {
    headers: {
      'user-agent': USER_AGENT,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`JRF: extended board HTTP ${res.status}`);
  }

  const json: unknown = await res.json();
  const rates = parseRates(json);
  if (Object.keys(rates).length === 0) {
    throw new Error('JRF: no currencies parsed from extended rate board');
  }

  return {
    providerId: 'jrf',
    rates,
    fetchedAt: new Date().toISOString(),
    source: JRF_SOURCE_LABEL,
    method: 'live',
  };
}
