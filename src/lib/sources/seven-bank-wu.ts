import type { CurrencyCode, ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  SEVEN BANK / WESTERN UNION RATE ADAPTER (CurrentFXList.xml)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET https://www.sevenbank.co.jp/t/html/file/CurrentFXList.xml
 *
 * One XML board, ~191 `<country>` blocks, each keyed by a TWO-LETTER
 * countrycode with one or more `<currency>` children:
 *
 *   <country>
 *     <countrycode>ID</countrycode>          ⚠️ country code, NOT "IDR"
 *     <countryname>Indonesia</countryname>
 *     <currency>
 *       <currencycode>IDR</currencycode>
 *       <currencyname>Indonesian Rupiah</currencyname>
 *       <fxrate>110.9163283</fxrate>          ← per 1 JPY, canonical
 *     </currency>
 *   </country>
 *
 * ⚠️  Rows are keyed by COUNTRY code (`ID`, `PH`, `VN`, `IN`, `NP`, `BD`,
 *     `TH`, `US`) — the classic `ID`≠`IDR` pitfall — and several countries
 *     carry MULTIPLE currencies (live 2026-08-23: VN quotes USD *and* VND;
 *     PH quotes PHP and USD; AS/AI… quote USD too). A corridor is therefore
 *     declared only when BOTH the countrycode block and the matching
 *     `<currencycode>` are found inside it — the US-block USD row is the USD
 *     corridor, never the VN/PH/AS USD rows.
 *
 * QUOTING UNITS: `fxrate` is per-1-JPY (IDR 110.916 vs mid 111.370 → −0.41%
 * on 2026-08-23; unit errors are caught by the resolver's sanity bound).
 *
 * Sendcharge.xml (fee tiers): P2-researched cross-check for task 8's IDR
 * tiers is NO LONGER POSSIBLE — the URL now serves the bank's HTML homepage
 * (endpoint removed). Tiers stay verified-by-research; noted in
 * docs/rate-sources.md.
 */

export const SEVEN_BANK_ENDPOINT = 'https://www.sevenbank.co.jp/t/html/file/CurrentFXList.xml';

/** Human label carried on the ObservedRateSet. */
export const SEVEN_BANK_SOURCE_LABEL =
  'sevenbank.co.jp WU rate board (CurrentFXList.xml — daily board, countrycode-keyed)';

/**
 * CurrencyCode → Seven Bank countrycode (the `ID`-not-`IDR` mapping, pinned
 * live 2026-08-23). Partial: Seven Bank quotes 8 of the simulator's 11
 * corridors — EUR/CNY/KRW are not offered and map to no country code.
 */
export const COUNTRY_CODES: Readonly<Partial<Record<CurrencyCode, string>>> = {
  IDR: 'ID',
  PHP: 'PH',
  VND: 'VN',
  INR: 'IN',
  NPR: 'NP',
  BDT: 'BD',
  THB: 'TH',
  USD: 'US',
};

/** Corridors declared by this adapter (Seven Bank's supportedCurrencies). */
const PROBE_CURRENCIES: readonly CurrencyCode[] = Object.keys(COUNTRY_CODES) as CurrencyCode[];

/** Descriptive UA — we are a comparison site reading a public rate board. */
const USER_AGENT = 'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Minimal dependency-free parse of the country/currency structure.
 * Returns countrycode → { currencycode → per-1-JPY rate } for every block
 * with a parseable pair; malformed numbers/rows are skipped, never thrown.
 */
export function parseFxList(xml: string): Map<string, Record<string, number>> {
  const byCountry = new Map<string, Record<string, number>>();
  for (const block of xml.split(/<country>/).slice(1)) {
    const countrycode = /<countrycode>([A-Z]{2})<\/countrycode>/.exec(block)?.[1];
    if (!countrycode) continue;
    const rates: Record<string, number> = {};
    // Pair currencycode + fxrate INSIDE one <currency> sub-block — a malformed
    // rate for one currency must never bleed into a sibling's number.
    for (const currencyBlock of block.split(/<currency>/).slice(1)) {
      const code = /<currencycode>([A-Z]{2,4})<\/currencycode>/.exec(currencyBlock)?.[1];
      const raw = /<fxrate>([0-9.]+)<\/fxrate>/.exec(currencyBlock)?.[1];
      if (!code || raw === undefined) continue;
      const rate = Number(raw);
      if (Number.isFinite(rate) && rate > 0) rates[code] = rate;
    }
    if (Object.keys(rates).length > 0) byCountry.set(countrycode, rates);
  }
  return byCountry;
}

/** Pick one corridor's rate out of a parsed board, or `undefined` to skip. */
export function pickRate(
  board: Map<string, Record<string, number>>,
  currency: CurrencyCode,
): number | undefined {
  const code = COUNTRY_CODES[currency];
  const block = code === undefined ? undefined : board.get(code);
  if (!block) return undefined; // country not on the board → corridor skipped
  const rate = block[currency];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/**
 * Fetch Seven Bank / WU live rates.
 *
 * Per-corridor problems (country row absent, currency row absent, malformed
 * rate) skip that corridor; the adapter only rejects when NOTHING parsed.
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchSevenBankRates(fetchImpl: typeof fetch = fetch): Promise<ObservedRateSet> {
  let xml: string;
  try {
    const res = await fetchImpl(SEVEN_BANK_ENDPOINT, {
      headers: { 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`CurrentFXList.xml HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    throw new Error(`Seven Bank: board fetch failed (${(err as Error).message})`);
  }

  const board = parseFxList(xml);
  const rates: Partial<Record<CurrencyCode, number>> = {};
  for (const currency of PROBE_CURRENCIES) {
    const rate = pickRate(board, currency);
    if (rate !== undefined) rates[currency] = rate;
  }

  if (Object.keys(rates).length === 0) {
    throw new Error('Seven Bank: no corridors parsed from CurrentFXList.xml');
  }

  return {
    providerId: 'seven-bank-wu',
    rates,
    fetchedAt: new Date().toISOString(),
    source: SEVEN_BANK_SOURCE_LABEL,
    method: 'live',
  };
}
