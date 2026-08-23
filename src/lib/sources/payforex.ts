import type { ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  PAYFOREX RATE ADAPTER (session cookie + CSRF two-step)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *
 *   1. GET  https://www.payforex.net/remittance/simulator?ctry=Indonesia
 *      → session cookie `__Host-PFXID` + `<meta name="_csrf" content="…">`
 *   2. POST https://www.payforex.net/ajax
 *      headers: X-CSRF-TOKEN (from the meta) + X-Requested-With + cookie
 *      body:    {"func":"GetRemitRateAction",
 *                "args":{"country":"Indonesia","receiptCode":"BR_BRI",
 *                        "fromFx":"JPY","toFx":"IDR","needVipRateCalc":false}}
 *      → {"result":"OK","resultData":{
 *           "rate":"100 IDR = 0.9174 JPY",          ← display string
 *           "currencyRate":" (1 JPY = 109.0037 IDR)",  ← the per-1-JPY rate
 *           "vipRealRate":"0.9174","originalRate":""}}
 *
 * The flow is their own public simulator replayed verbatim (plan "Risks" ToS
 * line); both steps run inside ONE read-through pass and the session/token
 * are discarded — no cross-request session state anywhere.
 *
 * ⚠️  NUMERIC FIELDS ARE COMMA-FORMATTED STRINGS ("10,900.37") — commas are
 *     stripped before Number() (dedicated fixture test).
 *
 * `payMethod` ("2_JNB" — bank deposit) belongs to their RemitSimulatorAction
 * (fee/amount simulation), NOT to GetRemitRateAction — the rate action's args
 * come straight from their own remittanceSimulator.js.
 *
 * Corridor scope: INDONESIA ONLY. Receipt codes are per-country/per-bank and
 * live behind a POST fragment (`/remittance/frg/method` answers 405 to GET);
 * only the P2-verified `BR_BRI` bank corridor is declared — every other
 * PayForex corridor stays modeled (docs/rate-sources.md).
 *
 * Night/holiday rate modes (their terms): the 2026-08-23 response carries no
 * explicit mode marker; the resolver's sanity bound is the guard — a
 * non-representative mode rate gets rejected → modeled fallback.
 */

export const PAYFOREX_SIMULATOR_URL =
  'https://www.payforex.net/remittance/simulator?ctry=Indonesia';
export const PAYFOREX_AJAX_URL = 'https://www.payforex.net/ajax';

/** Human label carried on the ObservedRateSet. */
export const PAYFOREX_SOURCE_LABEL =
  'payforex.net simulator GetRemitRateAction (Indonesia bank receipt BR_BRI, session+CSRF)';

/** Bank-receipt code for the P2-verified Indonesia corridor. */
export const PAYFOREX_RECEIPT_CODE = 'BR_BRI';

/** Descriptive UA — we are a comparison site replaying their public simulator. */
const USER_AGENT =
  'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Extract the per-1-JPY rate from a `currencyRate` string like
 * `" (1 JPY = 109.0037 IDR)"` — commas stripped, malformed → undefined.
 */
export function parsePerJpyRate(currencyRate: unknown): number | undefined {
  if (typeof currencyRate !== 'string') return undefined;
  const m = /1\s*JPY\s*=\s*([0-9][0-9,.]*)\s*IDR/.exec(currencyRate);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Collect the Set-Cookie pairs of a response into one Cookie header value. */
function cookieHeader(res: Response): string {
  // Headers#getSetCookie is available in workerd + undici; fall back to the
  // combined get() for environments that only expose that.
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof anyHeaders.getSetCookie === 'function' ? anyHeaders.getSetCookie() : [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

/** Extract the `_csrf` token from the simulator page's meta tag. */
export function parseCsrfToken(html: string): string | undefined {
  return /meta\s+name="_csrf"\s+content="([^"]+)"/.exec(html)?.[1];
}

/**
 * Run the two-step PayForex flow and return the observed IDR rate.
 *
 * A failure of EITHER step rejects once (the read-through resolver catches
 * it, records the error, and the row falls to modeled — isolated, never
 * thrown past the resolver).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchPayForexRates(
  fetchImpl: typeof fetch = fetch
): Promise<ObservedRateSet> {
  // Step 1 — session cookie + CSRF token (fresh every pass).
  let csrf: string | undefined;
  let cookie: string;
  try {
    const sim = await fetchImpl(PAYFOREX_SIMULATOR_URL, { headers: { 'user-agent': USER_AGENT } });
    if (!sim.ok) throw new Error(`simulator page HTTP ${sim.status}`);
    cookie = cookieHeader(sim);
    csrf = parseCsrfToken(await sim.text());
    if (!csrf) throw new Error('_csrf meta tag not found on simulator page');
  } catch (err) {
    throw new Error(`PayForex: session/CSRF step failed (${(err as Error).message})`, {
      cause: err,
    });
  }

  // Step 2 — the rate action with the token + cookie.
  let rate: number | undefined;
  try {
    const res = await fetchImpl(PAYFOREX_AJAX_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'x-requested-with': 'XMLHttpRequest',
        ...(cookie ? { cookie } : {}),
        referer: PAYFOREX_SIMULATOR_URL,
        origin: 'https://www.payforex.net',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        func: 'GetRemitRateAction',
        args: {
          country: 'Indonesia',
          receiptCode: PAYFOREX_RECEIPT_CODE,
          fromFx: 'JPY',
          toFx: 'IDR',
          needVipRateCalc: false,
        },
      }),
    });
    if (!res.ok) throw new Error(`ajax HTTP ${res.status}`);
    const json = (await res.json()) as { result?: string; resultData?: { currencyRate?: unknown } };
    if (json.result !== 'OK') throw new Error(`ajax result ${json.result ?? 'missing'}`);
    rate = parsePerJpyRate(json.resultData?.currencyRate);
    if (rate === undefined) throw new Error('currencyRate missing/unparsable');
  } catch (err) {
    throw new Error(`PayForex: rate-action step failed (${(err as Error).message})`, {
      cause: err,
    });
  }

  return {
    providerId: 'payforex',
    rates: { IDR: rate },
    fetchedAt: new Date().toISOString(),
    source: PAYFOREX_SOURCE_LABEL,
    method: 'live',
  };
}
