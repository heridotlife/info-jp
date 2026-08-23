import type { CurrencyCode } from '../../types/remittance';

/**
 * ============================================================================
 *  SHARED ADAPTER HARDENING (tasks.md task 22)
 * ============================================================================
 *
 * Cross-cutting guards used by the read-through resolver
 * (src/lib/observedRates.ts) and the corridor matrix tests:
 *
 *   1. Absolute corridor sanity bands — a per-currency [min, max] envelope
 *      on the canonical per-1-JPY rate. These catch decimal-shift and
 *      quoting-unit bugs even when NO mid-market value is available (the
 *      relative bound [mid × 0.85, mid × 1.02] can't run without a mid).
 *      Bands are deliberately wide (~±35 % around 2026 mids): they must
 *      never reject an honest provider spread, only unit errors.
 *
 *   2. Transient-error classification — decides whether a failed adapter
 *      fetch deserves its single retry (network/timeout/5xx yes; a
 *      deterministic parse failure no).
 *
 *   3. Documented corridor skips — corridors a provider's registry entry
 *      declares but whose source verifiably does not quote them today
 *      (SBI INR/BDT `rate:null`, Smiles THB absent from the board). The
 *      corridor matrix test and `verify:rates` treat these as expected
 *      modeled corridors rather than regressions.
 */

/** Absolute per-1-JPY sanity envelope per corridor (unit-bug guard). */
export const CORRIDOR_SANITY_BANDS: Readonly<Record<CurrencyCode, Readonly<{ min: number; max: number }>>> = {
  IDR: { min: 80, max: 150 }, //   brief: 80–150 IDR/JPY (2026 mid ≈ 111)
  PHP: { min: 0.25, max: 0.6 }, // mid ≈ 0.39
  VND: { min: 100, max: 250 }, //  mid ≈ 164
  INR: { min: 0.35, max: 0.75 }, // mid ≈ 0.60
  NPR: { min: 0.6, max: 1.3 }, //  mid ≈ 0.96
  BDT: { min: 0.5, max: 1.2 }, //  mid ≈ 0.77
  CNY: { min: 0.03, max: 0.06 }, // mid ≈ 0.042 (per-¥10,000 ≈ 420 → caught)
  THB: { min: 0.15, max: 0.3 }, // mid ≈ 0.206
  USD: { min: 0.0045, max: 0.009 }, // mid ≈ 0.0063
  EUR: { min: 0.0045, max: 0.0095 }, // mid ≈ 0.0054
  KRW: { min: 8, max: 12.5 }, //  mid ≈ 8.7
};

/** Is `rate` inside the corridor's absolute band? (Always applicable.) */
export function withinCorridorBand(rate: number, code: CurrencyCode): boolean {
  const band = CORRIDOR_SANITY_BANDS[code];
  if (!band) return true; // unknown corridor — nothing to check against
  return rate >= band.min && rate <= band.max;
}

/**
 * Does this failure look transient (worth the single retry)?
 * Network-layer failures (fetch throws TypeError), timeouts, and 5xx-style
 * HTTP statuses qualify; a deterministic adapter parse rejection does not.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch() network failure
  const name = typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name ?? '') : '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const message =
    typeof err === 'object' && err !== null
      ? String((err as { message?: unknown }).message ?? err)
      : String(err);
  return /network|fetch failed|econn|socket|hang up|abandoned|timed? ?out|(^|\D)5\d{2}(\D|$)/i.test(message);
}

/**
 * Corridors declared in the provider registry that the provider's own source
 * verifiably does not quote (verified live 2026-08-23). Anything else missing
 * from an adapter's output IS a regression — the corridor matrix test and
 * `verify:rates` fail on it.
 */
export const DOCUMENTED_SKIPS: Readonly<Record<string, readonly CurrencyCode[]>> = {
  'sbi-remit': ['INR', 'BDT'], // board answers `rate:null` (docs/rate-sources.md)
  smiles: ['THB'], // no Thailand block on the board (docs/rate-sources.md)
  // IDR-only adapter by design: other corridors' receipt codes sit behind a
  // POST fragment that was not reverse-engineered (docs/rate-sources.md).
  payforex: ['PHP', 'VND', 'INR', 'NPR', 'BDT', 'THB', 'CNY'],
};
