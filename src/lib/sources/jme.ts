import type { CurrencyCode, ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  JME (Japan Money Express) RATE ADAPTER (server-rendered HTML tables)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET https://japanremit.com/exchange-rate
 *
 * The page server-renders FOUR <table>s (two tabs × desktop/mobile copies):
 *   tables 0/2 — JME's OWN rates ("Exchange rate" tab, `counter-exrate-pane`)
 *   tables 1/3 — MONEYGRAM's rates (`counter-mg-pane`) ⚠️ never read — they
 *                are MoneyGram's board, not JME's send rates.
 *
 * JME table row shape: Country | Payment Method | Currency | Rate, e.g.
 *   Indonesia | BANK DEPOSIT, CASH PICK UP | IDR | 110.1035   ← standard rate
 *   Indonesia | Card Payment              | IDR | 110.297     (card-funded)
 *   Indonesia | (empty method)            | IDR | 112.4665    ⚠️ ABOVE mid
 *
 * ⚠️  THE EMPTY-METHOD ROW IS A TRAP (pinned live 2026-08-23): 112.4665 sits
 *     ~1% ABOVE mid-market (111.37) — a paying customer cannot durably get a
 *     better-than-mid send rate; it is a campaign/promo display rate, and it
 *     would even pass the resolver's sanity bound (mid × 1.02). The adapter
 *     therefore selects ONLY the "BANK DEPOSIT" method row per corridor —
 *     the standard, durably-attainable bank rate — and ignores empty-method,
 *     Card-Payment, and all MoneyGram rows structurally.
 *
 * QUOTING UNITS: `Rate` is per-1-JPY (BANK DEPOSIT IDR 110.1035 vs mid
 * 111.37 → −1.14%, a sane corridor spread).
 *
 * Corridor scope: INDONESIA ONLY for now (`supportedCurrencies: ['IDR']` in
 * the registry — grown as corridors verify; the board does quote more).
 */

export const JME_ENDPOINT = 'https://japanremit.com/exchange-rate';

/** Human label carried on the ObservedRateSet. */
export const JME_SOURCE_LABEL =
  'japanremit.com/exchange-rate (server-rendered table — BANK DEPOSIT method row)';

/** The standard, durably-attainable method we price. */
export const JME_METHOD_SELECTOR = /BANK\s*DEPOSIT/i;

/** Corridors declared by this adapter (registry supportedCurrencies). */
const DECLARED_CURRENCIES: readonly CurrencyCode[] = ['IDR'];

/** Descriptive UA — we are a comparison site reading a public rate page. */
const USER_AGENT =
  'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/** Cell-text cleaner for a `<td>…</td>` capture. */
const cellText = (raw: string): string =>
  raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

/**
 * Slice the HTML down to JME's own pane (before the MoneyGram pane starts),
 * so MoneyGram rows can never be parsed as JME rates. Falls back to the full
 * page (which then parses nothing MoneyGram-specific for our method filter
 * is stricter than MG's method labels).
 */
export function jmeRateSection(html: string): string {
  // Anchor on the pane DIV id — `counter-exrate-pane` also appears earlier in
  // the tab-nav's data-bs-target, which would slice out only the nav bar.
  const start = html.indexOf('id="counter-exrate-pane"');
  if (start === -1) return html;
  const rest = html.slice(start);
  const next = rest.indexOf('id="counter-mg-pane"');
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Parse the page into per-1-JPY rates for declared corridors, selecting only
 * the BANK DEPOSIT method row. Malformed rows / missing method rows are
 * skipped, never thrown.
 */
export function parseJmeRates(html: string): Partial<Record<CurrencyCode, number>> {
  const rates: Partial<Record<CurrencyCode, number>> = {};
  for (const rowMatch of jmeRateSection(html).matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) =>
      cellText(m[1])
    );
    if (cells.length < 4) continue;
    const [, method, currency, rateText] = cells;
    if (!(DECLARED_CURRENCIES as readonly string[]).includes(currency)) continue;
    if (!JME_METHOD_SELECTOR.test(method)) continue; // drops promo/card/MG rows
    const rate = Number(rateText.replace(/,/g, ''));
    if (Number.isFinite(rate) && rate > 0 && rates[currency as CurrencyCode] === undefined) {
      rates[currency as CurrencyCode] = rate;
    }
  }
  return rates;
}

/**
 * Fetch JME's live rates.
 * HTTP error / unusable payload → one provider-level reject (the read-through
 * resolver catches it and the row falls to modeled).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchJmeRates(fetchImpl: typeof fetch = fetch): Promise<ObservedRateSet> {
  let rates: Partial<Record<CurrencyCode, number>>;
  try {
    const res = await fetchImpl(JME_ENDPOINT, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'ja,en;q=0.8' },
    });
    if (!res.ok) throw new Error(`exchange-rate page HTTP ${res.status}`);
    rates = parseJmeRates(await res.text());
    if (Object.keys(rates).length === 0) {
      throw new Error('no BANK DEPOSIT method rows parsed for declared corridors');
    }
  } catch (err) {
    throw new Error(`JME: page fetch failed (${(err as Error).message})`, { cause: err });
  }

  return {
    providerId: 'jme',
    rates,
    fetchedAt: new Date().toISOString(),
    source: JME_SOURCE_LABEL,
    method: 'live',
  };
}
