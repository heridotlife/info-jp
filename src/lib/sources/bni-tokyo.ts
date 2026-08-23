import type { ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  BNI TOKYO RATE ADAPTER (FAQ rate board, TTS row)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET http://www.ptbni.co.jp/faq-et/?lang=ja      ⚠️ PLAIN HTTP
 *
 * The page server-renders two rate cards ("psr-card"):
 *
 *   1. 対円為替レート（送金）— the REMITTANCE (TTS) card, with a board
 *      timestamp (e.g. 2026-08-21 09:20 — boards update on business days
 *      ~09:20 JST; a weekend fetch shows Friday's board, accepted under the
 *      uniform 12 h TTL policy):
 *
 *        通貨   | TTS
 *        USD    | 160.01            ← JPY per 1 USD
 *        IDR    | 0.00926           ← JPY per 1 IDR
 *        ( IDR per JPY ) | 107.99   ← THE per-1-JPY send rate (1/0.00926 ✓)
 *
 *   2. TTB card — the RECEIVE direction. ⚠️ EXPLICITLY IGNORED: the fixture
 *      carries both cards and the tests assert only TTS is read.
 *
 * The adapter prefers the explicit "( IDR per JPY )" row; if it ever
 * disappears, it inverts the IDR TTS row (1 / JPY-per-IDR) — same canonical
 * per-1-JPY unit either way.
 *
 * Sanity anchor 2026-08-23: 107.99 vs mid 111.37 → −3.09% (inside the
 * resolver bound [mid × 0.85, mid × 1.02]).
 *
 * PLAIN-HTTP NOTE: the fetch runs server-side only (Pages Function request
 * path — `verify:rates`, the read-through resolver); the browser never
 * contacts ptbni.co.jp, so there is no mixed-content concern.
 */

export const BNI_TOKYO_ENDPOINT = 'http://www.ptbni.co.jp/faq-et/?lang=ja';

/** Human label base; the board timestamp is appended dynamically. */
export const BNI_TOKYO_SOURCE_LABEL =
  'ptbni.co.jp express-remittance board (TTS send card — TTB ignored)';

/** Slice the page down to the TTS (remittance) card, before the TTB card. */
export function ttsSection(html: string): string {
  // The TTS card is anchored by its caption (送金 = remittance); fall back
  // to the TTS table header. Everything from there to the TTB card is ours.
  const anchor =
    html.indexOf('対円為替レート（送金）') !== -1
      ? html.indexOf('対円為替レート（送金）')
      : html.indexOf('<th>TTS</th>');
  if (anchor === -1) return '';
  const rest = html.slice(anchor);
  const ttb = rest.search(/TTB/);
  return ttb === -1 ? rest : rest.slice(0, ttb);
}

export interface BniTokyoParse {
  /** Per-1-JPY IDR send rate. */
  rate: number;
  /** Board timestamp as written on the card (e.g. "2026-08-21 09:20"). */
  boardTimestamp?: string;
}

/**
 * Parse the TTS card into the per-1-JPY send rate, or `undefined` when the
 * card/rows are missing or malformed. The TTB card is never in scope (the
 * section slice ends before it).
 */
export function parseBniTokyoRates(html: string): BniTokyoParse | undefined {
  const section = ttsSection(html);
  if (section === '') return undefined;

  // Explicit per-1-JPY row: "( IDR per JPY ) | 107.99"
  const perJpy = /<td[^>]*>\(\s*IDR\s*per\s*JPY\s*\)<\/td>\s*<td[^>]*>\s*([0-9][0-9.,]*)\s*<\/td>/i.exec(
    section,
  );
  // JPY-per-IDR row: "IDR | 0.00926" → invert for the canonical unit.
  const perIdr = /<td[^>]*>\s*IDR\s*<\/td>\s*<td[^>]*>\s*([0-9][0-9.,]*)\s*<\/td>/i.exec(section);

  let rate: number | undefined;
  if (perJpy) {
    const n = Number(perJpy[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) rate = n;
  }
  if (rate === undefined && perIdr) {
    const n = Number(perIdr[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) rate = 1 / n;
  }
  if (rate === undefined) return undefined;

  const date = /\d{4}-\d{2}-\d{2}/.exec(section)?.[0];
  const time = /\d{2}:\d{2}/.exec(section)?.[0];
  return {
    rate,
    boardTimestamp: date && time ? `${date} ${time}` : date,
  };
}

/** Descriptive UA — we are a comparison site reading a public rate board. */
const USER_AGENT = 'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Fetch BNI Tokyo's live remittance (TTS) rate for the IDR corridor.
 * HTTP error / unusable payload → one provider-level reject (the read-through
 * resolver catches it and the row falls to modeled).
 *
 * The board updates on business days ~09:20 JST; the standard 12 h observed
 * TTL applies (rev 4 uniform policy — a served rate can predate the day's
 * board by up to 12 h; the staleness classifier surfaces the age in the UI).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchBniTokyoRates(
  fetchImpl: typeof fetch = fetch,
): Promise<ObservedRateSet> {
  let parsed: BniTokyoParse | undefined;
  try {
    const res = await fetchImpl(BNI_TOKYO_ENDPOINT, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'ja,en;q=0.8' },
    });
    if (!res.ok) throw new Error(`faq-et page HTTP ${res.status}`);
    parsed = parseBniTokyoRates(await res.text());
    if (parsed === undefined) throw new Error('TTS rate card not parsable');
  } catch (err) {
    throw new Error(`BNI Tokyo: board fetch failed (${(err as Error).message})`);
  }

  return {
    providerId: 'bni-tokyo',
    rates: { IDR: parsed.rate },
    fetchedAt: new Date().toISOString(),
    source: parsed.boardTimestamp
      ? `${BNI_TOKYO_SOURCE_LABEL} — board ${parsed.boardTimestamp} JST`
      : BNI_TOKYO_SOURCE_LABEL,
    method: 'live',
  };
}
