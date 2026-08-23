import type { CurrencyCode, ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  SMILES RATE ADAPTER (server-rendered rates page)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET https://www.smileswallet.com/japan/exchange-rates/
 *
 * The MAIN page is server-rendered (the P1 "client-rendered" verdict applied
 * only to the per-corridor sub-pages). Each country block carries its rate as
 * an anchor whose text is `<rate> <CCY>`:
 *
 *   <a href='…/jpy-to-idr/' title='currency exchange page'
 *      class='exchange_rate'>111.1 IDR</a>
 *
 * Live board 2026-08-23: USD 0.0062 · PHP 0.388 · INR 0.598 · BDT 0.766 ·
 * NPR 0.96 · IDR 111.1 · VND 164.2 — **THB is absent** even though the
 * provider registry lists it (Smiles is not quoting THB today) → that
 * corridor is skipped and stays modeled.
 *
 * QUOTING UNITS: the displayed value is per-1-JPY (IDR 111.1 vs mid 111.37
 * → −0.24%). Display precision is ~3–4 significant digits (111.1, 0.0062) —
 * coarser than the JSON/XML boards; acceptable for a comparison site and
 * caught by the resolver's sanity bound if it ever regresses.
 */

export const SMILES_ENDPOINT = 'https://www.smileswallet.com/japan/exchange-rates/';

/** Human label carried on the ObservedRateSet. */
export const SMILES_SOURCE_LABEL =
  'smileswallet.com/japan/exchange-rates (server-rendered rate anchors)';

/**
 * Corridors probed by this adapter — Smiles' `supportedCurrencies` in the
 * provider registry. THB answered absent on 2026-08-23 (skipped at runtime).
 */
const PROBE_CURRENCIES: readonly CurrencyCode[] = ['NPR', 'INR', 'PHP', 'VND', 'IDR', 'BDT', 'THB'];

/** Descriptive UA — we are a comparison site reading a public rate page. */
const USER_AGENT =
  'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Parse the server-rendered board: every `class='exchange_rate'` anchor whose
 * text is `<number> <CCY>`. Returns currencycode → per-1-JPY rate; malformed
 * anchors (wrong text shape, unparsable number) are skipped, never thrown.
 * Commas are stripped defensively in case the board starts grouping digits.
 */
export function parseExchangeRates(html: string): Partial<Record<CurrencyCode, number>> {
  const rates: Partial<Record<CurrencyCode, number>> = {};
  // The board uses single quotes today; accept either quote style.
  for (const m of html.matchAll(
    /class=(['"])exchange_rate\1>\s*([0-9][0-9.,]*)\s+([A-Z]{2,4})\s*</g
  )) {
    const rate = Number(m[2].replace(/,/g, ''));
    const currency = m[3] as CurrencyCode;
    if (Number.isFinite(rate) && rate > 0 && !(currency in rates)) {
      rates[currency] = rate;
    }
  }
  return rates;
}

/**
 * Fetch Smiles' live rates.
 *
 * Corridors whose block is missing (THB today) are skipped; the adapter only
 * rejects when NOTHING parsed (so the read-through resolver can record a
 * provider-level failure).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchSmilesRates(fetchImpl: typeof fetch = fetch): Promise<ObservedRateSet> {
  let html: string;
  try {
    const res = await fetchImpl(SMILES_ENDPOINT, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`exchange-rates page HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw new Error(`Smiles: page fetch failed (${(err as Error).message})`, { cause: err });
  }

  const board = parseExchangeRates(html);
  const rates: Partial<Record<CurrencyCode, number>> = {};
  for (const currency of PROBE_CURRENCIES) {
    const rate = board[currency];
    if (typeof rate === 'number') rates[currency] = rate;
  }

  if (Object.keys(rates).length === 0) {
    throw new Error('Smiles: no corridors parsed from exchange-rates page');
  }

  return {
    providerId: 'smiles',
    rates,
    fetchedAt: new Date().toISOString(),
    source: SMILES_SOURCE_LABEL,
    method: 'live',
  };
}
