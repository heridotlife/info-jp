import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CITY_EXPRESS_ENDPOINT,
  PROMO_ROW_NAME,
  fetchCityExpressRates,
  parseRatesBoard,
} from '../city-express';

/**
 * Fixture-driven tests for the City Express adapter (tasks.md task 14).
 * Fixture is the verbatim /api/rates board captured 2026-08-23 from our own
 * egress (includes the NPR GOLDENRATE promo row).
 */

const FIXTURE_DIR = new URL('../fixtures/city-express/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- board parsing ---------------------------------------------------------------

describe('city-express: parseRatesBoard', () => {
  it('parses the pinned live board for every declared corridor', () => {
    const rates = parseRatesBoard(JSON.parse(fixture('rates.json')));
    expect(rates).toEqual({
      NPR: 0.954,
      IDR: 111.2,
      VND: 164,
      PHP: 0.388,
      INR: 0.5996,
      BDT: 0.767,
      THB: 0.204209,
      KRW: 8.63,
    });
  });

  it('DROPS GOLDENRATE promo rows — they can never reach the observed set', () => {
    // Live shape: the NPR promo (0.9605) is BETTER than standard (0.954).
    // If it leaked, a non-durable rate would win comparisons.
    const rates = parseRatesBoard(JSON.parse(fixture('rates.json')));
    expect(rates.NPR).toBe(0.954); // standard, not the 0.9605 promo

    // Synthetic worst case: ONLY a promo row exists for a currency → the
    // corridor is simply absent (skipped), never promo-priced.
    const promoOnly = parseRatesBoard({
      rates: [{ name: PROMO_ROW_NAME, iso2: 'id', currency: 'IDR', rate: 999 }],
    });
    expect(promoOnly.IDR).toBeUndefined();
    expect(promoOnly).toEqual({});
  });

  it('keeps the standard row when the promo row comes first', () => {
    const board = parseRatesBoard({
      rates: [
        { name: PROMO_ROW_NAME, iso2: 'np', currency: 'NPR', rate: 0.9605 },
        { name: 'NEPAL', iso2: 'np', currency: 'NPR', rate: 0.954 },
      ],
    });
    expect(board.NPR).toBe(0.954);
  });

  it('skips malformed rows and non-declared currencies without throwing', () => {
    const board = parseRatesBoard({
      rates: [
        null,
        'junk',
        { name: 'MONGOLIA', currency: 'MNT', rate: 22.452 }, // not a declared corridor
        { name: 'CAMBODIA', currency: 'USD', rate: 0.006245 }, // USD payout in KH — not declared
        { name: 'INDONESIA', currency: 'IDR' }, // missing rate
        { name: 'INDONESIA', currency: 'IDR', rate: -5 }, // invalid rate
        { name: 'INDONESIA', currency: 'IDR', rate: '111.2' }, // string rate
        { name: 'VIET NAM', currency: 'VND', rate: 164 },
      ],
    });
    expect(board).toEqual({ VND: 164 });
  });

  it('returns {} for malformed payloads', () => {
    expect(parseRatesBoard(null)).toEqual({});
    expect(parseRatesBoard('ok')).toEqual({});
    expect(parseRatesBoard({})).toEqual({});
    expect(parseRatesBoard({ rates: 'nope' })).toEqual({});
  });
});

// --- full fetch against fixtures ----------------------------------------------

describe('city-express: fetchCityExpressRates', () => {
  it('fetches the board URL and declares the verified corridors', async () => {
    const impl = vi.fn(async () =>
      new Response(fixture('rates.json'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const set = await fetchCityExpressRates(impl as unknown as typeof fetch);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(String(impl.mock.calls[0][0])).toBe(CITY_EXPRESS_ENDPOINT);

    expect(set.providerId).toBe('city-express');
    expect(set.method).toBe('live');
    expect(set.source).toContain('GOLDENRATE');
    expect(set.fetchedAt).toBeTruthy();
    expect(set.isPromo).toBeUndefined(); // standard rates only, no promo flag
    expect(Object.keys(set.rates).sort()).toEqual(
      ['BDT', 'IDR', 'INR', 'KRW', 'NPR', 'PHP', 'THB', 'VND'],
    );
    expect(set.rates.IDR).toBe(111.2);
  });

  it('rejects (provider-level failure) on HTTP error', async () => {
    const failing = vi.fn(async () => new Response('down', { status: 502 }));
    await expect(fetchCityExpressRates(failing as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 502/,
    );
  });

  it('rejects when the board shape changed and nothing parses', async () => {
    const changed = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'renamed endpoint' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(fetchCityExpressRates(changed as unknown as typeof fetch)).rejects.toThrow(
      /no declared corridors parsed/,
    );
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchCityExpressRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /board fetch failed/i,
    );
  });
});
