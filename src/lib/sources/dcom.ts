import type { CurrencyCode, ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  DCOM MONEY EXPRESS RATE ADAPTER (server-rendered HTML table)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET https://sendmoney.co.jp/jp/fx-rate/
 *
 * One server-rendered table; per currency a row of three cells:
 *
 *   <td>Indonesia Rupiah (IDR)</td>
 *   <td>IDR 111.0000</td>      ← 為替レート "JPY = X": 1 JPY = 111 IDR — SEND rate, USE
 *   <td>JPY 0.009009</td>      ← "X = JPY": 1 IDR = 0.009009 JPY (inverse)
 *
 * Cross-check (2026-08-23): 1 / 0.009009 = 111.0 ✓ — the two columns are
 * exact inverses, and the send column matches mid-market spread (111.0 vs
 * mid 111.37 → −0.33%). Parsing keys on the cell whose text starts with the
 * CORRIDOR code ("IDR 111.0000"), never the inverse "JPY …" cell.
 *
 * Board quotes 19 currencies (AUD BDT BRL EUR IDR INR KHR KRW LKR MMK MYR
 * NPR NZD PHP PKR SGD THB USD VND); this adapter declares the registry's
 * supportedCurrencies — IDR initially, grown as corridors verify.
 */

export const DCOM_ENDPOINT = 'https://sendmoney.co.jp/jp/fx-rate/';

/** Human label carried on the ObservedRateSet. */
export const DCOM_SOURCE_LABEL =
  'sendmoney.co.jp/jp/fx-rate (server-rendered table — send-rate column)';

/** Corridors declared by this adapter (registry supportedCurrencies). */
const DECLARED_CURRENCIES: readonly CurrencyCode[] = ['IDR'];

/** Descriptive UA — we are a comparison site reading a public rate page. */
const USER_AGENT =
  'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Parse the board into per-1-JPY send rates for declared corridors. A rate
 * cell is matched by its `CODE <number>` text shape (the inverse cell starts
 * with `JPY` and can never match). Malformed/missing cells skip the corridor,
 * never thrown.
 */
export function parseDcomRates(html: string): Partial<Record<CurrencyCode, number>> {
  const rates: Partial<Record<CurrencyCode, number>> = {};
  for (const currency of DECLARED_CURRENCIES) {
    const m = new RegExp(
      `>\\s*${currency}\\s+([0-9][0-9.,]*)\\s*<` // send-rate cell: "IDR 111.0000"
    ).exec(html);
    if (!m) continue;
    const rate = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(rate) && rate > 0) rates[currency] = rate;
  }
  return rates;
}

/**
 * Fetch DCOM's live rates.
 * HTTP error / unusable payload → one provider-level reject (the read-through
 * resolver catches it and the row falls to modeled).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchDcomRates(fetchImpl: typeof fetch = fetch): Promise<ObservedRateSet> {
  let rates: Partial<Record<CurrencyCode, number>>;
  try {
    const res = await fetchImpl(DCOM_ENDPOINT, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'ja,en;q=0.8' },
    });
    if (!res.ok) throw new Error(`fx-rate page HTTP ${res.status}`);
    rates = parseDcomRates(await res.text());
    if (Object.keys(rates).length === 0) {
      throw new Error('no declared-corridor rate cells parsed from table');
    }
  } catch (err) {
    throw new Error(`DCOM: page fetch failed (${(err as Error).message})`, { cause: err });
  }

  return {
    providerId: 'dcom',
    rates,
    fetchedAt: new Date().toISOString(),
    source: DCOM_SOURCE_LABEL,
    method: 'live',
  };
}
