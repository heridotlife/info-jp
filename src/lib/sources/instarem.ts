import type { ObservedRateSet } from '../../types/remittance';

/**
 * ============================================================================
 *  INSTAREM RATE ADAPTER (computed-value quote API)
 * ============================================================================
 *
 * Source (research P2, live-reverified from this egress 2026-08-23):
 *   GET https://www.instarem.com/api/v1/public/transaction/computed-value
 *       ?source_currency=JPY&destination_currency=IDR&source_amount=10000
 *
 * Anonymous, exact per-amount quote. Live response 2026-08-23 (top-level
 * `data` object — NOT the nested `transaction_config`):
 *
 *   instarem_fx_rate:        110.9719   ← applied rate, margin baked in — USE
 *   regular_instarem_fx_rate: 110.8606   ← standard (repeat-customer) pricing
 *   fx_rate:                 111.25      ⚠️ REFERENCE ONLY — never use for
 *                                          payouts (classic pitfall; the two
 *                                          "fx rate" fields differ by margin)
 *   regular_transaction_fee_amount: 0    (verified ¥0 fee, JPY→IDR)
 *   min/max_source_amount_limit: 5000 / 1000000  (corridor ¥5k–¥1M)
 *   destination_amount: 1109719 = 10000 × instarem_fx_rate ✓
 *
 * PROMO CROSS-CHECK (plan "Approach" §9): the anonymous quote prices the
 * FIRST transaction (live 2026-08-23: margin 0.25% vs regular 0.35% → rates
 * 110.9719 vs 110.8606, Δ ≈ 0.10%). Policy:
 *   • quoted ≈ regular (within PROMO_TOLERANCE) → store the quoted rate;
 *   • diverged → the quote is promotional → store `regular_instarem_fx_rate`
 *     (standard, durably-attainable pricing) and flag it in the source label
 *     + provider note. NEVER `isPromo` on the stored standard rate — the
 *     promo policy flag is reserved for rates that are *only* promo
 *     (Remitly); here the standard rate is real and simply better-attainable.
 *
 * AMOUNT-AWARE QUOTE (plan §8): prices a specific amount → canonical
 * reference ¥10,000, recorded as `quoteAmountJPY`.
 */

export const INSTAREM_ENDPOINT =
  'https://www.instarem.com/api/v1/public/transaction/computed-value';

/** Human label base; the promo marker is appended dynamically. */
export const INSTAREM_SOURCE_LABEL =
  'instarem.com computed-value API (JPY→IDR quote at ¥10,000)';

/** Canonical reference amount for the amount-aware quote (plan §8). */
export const INSTAREM_QUOTE_AMOUNT_JPY = 10_000;

/**
 * Relative divergence between `instarem_fx_rate` and
 * `regular_instarem_fx_rate` beyond which the quote is treated as promo.
 * Observed promo margin delta: 0.10% (2026-08-23) — 0.05% sits safely below.
 */
export const INSTAREM_PROMO_TOLERANCE = 0.0005;

/** Minimal shape of the computed-value response. */
interface ComputedValueResponse {
  success?: boolean;
  data?: {
    instarem_fx_rate?: number;
    regular_instarem_fx_rate?: number;
    destination_currency?: string;
  };
}

/** Result of parsing: the rate to store + whether a promo was detected. */
export interface InstaremParse {
  rate: number;
  promoDetected: boolean;
}

const finitePositive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Parse a computed-value body into the rate to store, or `undefined` to skip.
 * Uses `instarem_fx_rate` (NOT the reference `fx_rate`); applies the §9 promo
 * cross-check against `regular_instarem_fx_rate`.
 */
export function parseComputedValue(body: unknown): InstaremParse | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = (body as ComputedValueResponse).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const quoted = data.instarem_fx_rate;
  if (!finitePositive(quoted)) return undefined; // ⚠️ fx_rate is NOT a fallback
  const regular = data.regular_instarem_fx_rate;
  if (!finitePositive(regular)) return { rate: quoted, promoDetected: false };
  const divergence = Math.abs(quoted - regular) / regular;
  if (divergence <= INSTAREM_PROMO_TOLERANCE) return { rate: quoted, promoDetected: false };
  return { rate: regular, promoDetected: true };
}

/** Descriptive UA — we are a comparison site reading a public quote API. */
const USER_AGENT = 'info-jp-remittance-simulator/0.1 (provider rate comparison; contact: mail@heri.life)';

/**
 * Fetch Instarem's live quote for the IDR corridor.
 * A single GET; HTTP error / malformed payload → one provider-level reject
 * (the read-through resolver catches it and the row falls to modeled).
 *
 * @param fetchImpl injectable for tests (defaults to the platform `fetch`)
 */
export async function fetchInstaremRates(fetchImpl: typeof fetch = fetch): Promise<ObservedRateSet> {
  const url =
    `${INSTAREM_ENDPOINT}?source_currency=JPY&destination_currency=IDR&source_amount=${INSTAREM_QUOTE_AMOUNT_JPY}`;

  let parsed: InstaremParse | undefined;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`computed-value HTTP ${res.status}`);
    const json: unknown = await res.json();
    parsed = parseComputedValue(json);
    if (parsed === undefined) throw new Error('no parsable instarem_fx_rate in payload');
  } catch (err) {
    throw new Error(`Instarem: quote fetch failed (${(err as Error).message})`);
  }

  return {
    providerId: 'instarem',
    rates: { IDR: parsed.rate },
    fetchedAt: new Date().toISOString(),
    source:
      parsed.promoDetected
        ? `${INSTAREM_SOURCE_LABEL} — first-transaction promo detected, standard (regular) rate stored`
        : INSTAREM_SOURCE_LABEL,
    method: 'live',
    quoteAmountJPY: INSTAREM_QUOTE_AMOUNT_JPY,
  };
}
