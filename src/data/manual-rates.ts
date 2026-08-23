import type { ObservedRateSet } from '../types/remittance';

/**
 * ============================================================================
 *  MANUAL RATE ENTRIES (fallback-ladder middle rung — tasks.md task 21)
 * ============================================================================
 *
 * Providers whose rates cannot be fetched by an adapter but HAVE a genuinely
 * captured value get a checked-in entry here. The read-through resolver uses
 * these for any provider that came back with no observed set; entries are
 * NEVER cached in KV (they ride in the deploy bundle instead).
 *
 * Staleness policy: a manual entry behaves like any other rate — fresh
 * (< 12 h), stale 12–24 h (amber badge, still served), expired ≥ 24 h
 * (dropped → the provider renders modeled until a human refreshes this file).
 *
 * ENTRY RULES (honesty over coverage):
 *   • Only genuinely observed values — a value read with own eyes in a
 *     browser or fetched from the provider's own page/API. Never invented.
 *   • `fetchedAt` = the capture moment (date-precision captures use JST
 *     midnight of the capture day — the conservative reading).
 *
 * Not here, by design (see docs/rate-sources.md spike notes):
 *   • Brastel — spike task 19 failed AND no browser-captured value exists →
 *     stays modeled.
 *   • JRF — spike task 20 succeeded → live adapter (src/lib/sources/jrf.ts).
 *   • Revolut — Cloudflare-walled, no capturable board → stays modeled,
 *     relabeled "per published terms" (providers.ts).
 */
export const MANUAL_RATES: readonly ObservedRateSet[] = [
  {
    providerId: 'kyodai',
    rates: {
      // 1 JPY → 111.1000 IDR, read off the Kyodai rate page in a browser on
      // 2026-08-23 (their board is Blazor Server + digit-image digits —
      // confirmed not HTTP-automatable, research pass 2).
      IDR: 111.1,
    },
    fetchedAt: '2026-08-23T00:00:00+09:00', // capture date, JST midnight (day precision)
    source: 'https://www.kyodai.co.jp/ rate page — browser-captured (Blazor Server + digit-image rates)',
    method: 'manual',
  },
];
