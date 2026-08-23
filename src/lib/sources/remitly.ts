import type { ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  REMITLY JAPAN RATE ADAPTER (promo-flagged converter page)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET https://www.remitly.com/jp/ja/currency-converter/jpy-to-idr-rate
 *
 * Server-rendered HTML with an embedded JSON merchandising block. The page's
 * own rate fields (2026-08-23, IDR corridor):
 *
 *   "merchandisingFacts": {
 *     "everydayRateAsLowAs":  "106.85",   ← standard ("everyday") rate RANGE
 *     "everydayRateAsHighAs": "110.87",      (varies by pay/delivery config)
 *     "effectiveRateAsLowAs": "111.42",    ← the NEW-CUSTOMER promo rate
 *     "effectiveRateAsHighAs":"111.42",      (promo code: FXBOOST … 15BPS,
 *                                            capped at first ¥100,000)
 *
 * ⚠️  `effectiveRate*` is the promo rate — ABOVE mid-market (111.42 vs mid
 *     111.37 → +0.04%): a loss-leader no repeat customer can durably get.
 *     Per plan "Approach" §9 the extracted rate is ALWAYS marked
 *     `isPromo: true`: it ranks and displays ("Promo — new customers only")
 *     but can never win the `best-value` tag (fixture test proves the
 *     exclusion end-to-end through `simulate`).
 *
 * ⚠️  There is a SECOND block, `secondaryMerchandisingFacts`, carrying the
 *     site-wide default corridor (~0.006 = USD-shaped numbers) — parsing must
 *     bind to the `merchandisingFacts` block only (the resolver's sanity
 *     bound backstops a mis-bind: 0.006 vs mid 111.37 fails instantly).
 *
 * BONUS DATA (not stored, recorded in the source label): the everyday range
 * IS public on this page (P2's "standard rate is login-walled" held only for
 * the exact per-config rate) — surfaced as provenance context.
 */

export const REMITLY_ENDPOINT =
  'https://www.remitly.com/jp/ja/currency-converter/jpy-to-idr-rate';

/** Human label base; the everyday range is appended dynamically. */
export const REMITLY_SOURCE_LABEL =
  'remitly.com/jp converter page (new-customer PROMO rate — everyday range shown for context)';

/** Extract of the merchandisingFacts fields this adapter reads. */
export interface RemitlyMerchandising {
  /** Promo ("effective") rate — per-1-JPY, stored with isPromo. */
  promoRate: number;
  /** Standard ("everyday") rate range, when present (label context only). */
  everydayLow?: number;
  everydayHigh?: number;
}

/** Descriptive UA — we are a comparison site reading a public rate page. */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 info-jp-remittance-simulator/0.1';

/** Read one `"<key>":"<number>"` field out of a JSON fragment string. */
function numberField(fragment: string, key: string): number | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"([0-9][0-9.,]*)"`, 'g').exec(fragment);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const finitePositive = (n: number | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Parse the page's `merchandisingFacts` block into the promo rate (+ everyday
 * range), or `undefined` when the block/values are missing or malformed.
 * The `secondaryMerchandisingFacts` block is never read.
 */
export function parseRemitlyPage(html: string): RemitlyMerchandising | undefined {
  // Bind to the corridor block: everything from "merchandisingFacts" up to
  // the next top-level key ("secondaryMerchandisingFacts" follows it).
  const start = html.indexOf('"merchandisingFacts"');
  if (start === -1) return undefined;
  const rest = html.slice(start);
  const end = rest.indexOf('"secondaryMerchandisingFacts"');
  const block = end === -1 ? rest.slice(0, 2_000) : rest.slice(0, end);
  const low = numberField(block, 'effectiveRateAsLowAs');
  const high = numberField(block, 'effectiveRateAsHighAs');
  if (!finitePositive(low)) return undefined;
  // low === high for IDR; if they ever diverge, store the LOW (the weakest
  // promise the page makes about the promo rate).
  const promoRate = finitePositive(high) ? Math.min(low, high) : low;
  return {
    promoRate,
    everydayLow: numberField(block, 'everydayRateAsLowAs'),
    everydayHigh: numberField(block, 'everydayRateAsHighAs'),
  };
}

/**
 * Fetch Remitly Japan's live promo rate for the IDR corridor.
 * HTTP error / unusable payload → one provider-level reject (the read-through
 * resolver catches it and the row falls to modeled).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchRemitlyRates(
  fetchImpl: typeof fetch = fetch,
): Promise<ObservedRateSet> {
  let parsed: RemitlyMerchandising | undefined;
  try {
    const res = await fetchImpl(REMITLY_ENDPOINT, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'ja,en;q=0.8' },
    });
    if (!res.ok) throw new Error(`converter page HTTP ${res.status}`);
    parsed = parseRemitlyPage(await res.text());
    if (parsed === undefined) throw new Error('merchandisingFacts promo rate not found');
  } catch (err) {
    throw new Error(`Remitly: page fetch failed (${(err as Error).message})`);
  }

  const everyday =
    parsed.everydayLow !== undefined && parsed.everydayHigh !== undefined
      ? ` — everyday ${parsed.everydayLow}–${parsed.everydayHigh}`
      : '';

  return {
    providerId: 'remitly',
    rates: { IDR: parsed.promoRate },
    fetchedAt: new Date().toISOString(),
    source: `${REMITLY_SOURCE_LABEL}${everyday}`,
    method: 'live',
    // §9: the public page shows ONLY the new-customer promo rate — always
    // flagged, never eligible for `best-value`.
    isPromo: true,
  };
}
