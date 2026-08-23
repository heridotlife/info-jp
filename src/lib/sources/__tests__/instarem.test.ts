import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  INSTAREM_ENDPOINT,
  INSTAREM_PROMO_TOLERANCE,
  INSTAREM_QUOTE_AMOUNT_JPY,
  fetchInstaremRates,
  parseComputedValue,
} from '../instarem';

/**
 * Fixture-driven tests for the Instarem adapter (tasks.md task 13).
 * Fixtures captured 2026-08-23 from our own egress:
 *   computed-value.json      — live response (promo quote 110.9719 vs regular 110.8606)
 *   computed-value-agree.json — edited variant where quote == regular (agree branch)
 */

const FIXTURE_DIR = new URL('../fixtures/instarem/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- parsing ----------------------------------------------------------------

describe('instarem: parseComputedValue', () => {
  it('uses instarem_fx_rate — NEVER the reference fx_rate', () => {
    const parsed = parseComputedValue({ data: { instarem_fx_rate: 110.9719, fx_rate: 111.25 } });
    expect(parsed?.rate).toBe(110.9719);
    // A payload with only the reference rate is unusable.
    expect(parseComputedValue({ data: { fx_rate: 111.25 } })).toBeUndefined();
    expect(
      parseComputedValue({ data: { instarem_fx_rate: '110.97', fx_rate: 111.25 } })
    ).toBeUndefined();
  });

  it('promo branch: diverged quote → stores regular_instarem_fx_rate (§9)', () => {
    // Live fixture: quote 110.9719 vs regular 110.8606 → Δ 0.10% > 0.05%.
    const parsed = parseComputedValue(JSON.parse(fixture('computed-value.json')));
    expect(parsed).toEqual({ rate: 110.8606, promoDetected: true });
  });

  it('agreement branch: quote ≈ regular → stores the quoted rate, no promo', () => {
    const parsed = parseComputedValue(JSON.parse(fixture('computed-value-agree.json')));
    expect(parsed).toEqual({ rate: 110.8606, promoDetected: false });

    // Exactly at tolerance → still agreement (inclusive).
    const regular = 100;
    const atTolerance = regular * (1 + INSTAREM_PROMO_TOLERANCE);
    expect(
      parseComputedValue({
        data: { instarem_fx_rate: atTolerance, regular_instarem_fx_rate: regular },
      })
    ).toEqual({ rate: atTolerance, promoDetected: false });
    const beyond = regular * (1 + INSTAREM_PROMO_TOLERANCE * 1.5);
    expect(
      parseComputedValue({ data: { instarem_fx_rate: beyond, regular_instarem_fx_rate: regular } })
    ).toEqual({ rate: regular, promoDetected: true });
  });

  it('skips malformed payloads without throwing', () => {
    expect(parseComputedValue(null)).toBeUndefined();
    expect(parseComputedValue('ok')).toBeUndefined();
    expect(parseComputedValue({ success: true })).toBeUndefined();
    expect(parseComputedValue({ data: {} })).toBeUndefined();
    expect(parseComputedValue({ data: { instarem_fx_rate: -1 } })).toBeUndefined();
    expect(parseComputedValue({ data: { instarem_fx_rate: Number.NaN } })).toBeUndefined();
  });
});

// --- full fetch against fixtures ----------------------------------------------

describe('instarem: fetchInstaremRates', () => {
  it('quotes the canonical amount and stores the standard rate when promo detected', async () => {
    const impl = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(fixture('computed-value.json'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const set = await fetchInstaremRates(impl as unknown as typeof fetch);

    expect(String(impl.mock.calls[0][0])).toBe(
      `${INSTAREM_ENDPOINT}?source_currency=JPY&destination_currency=IDR&source_amount=${INSTAREM_QUOTE_AMOUNT_JPY}`
    );

    expect(set.providerId).toBe('instarem');
    expect(set.method).toBe('live');
    expect(set.quoteAmountJPY).toBe(10_000);
    expect(set.isPromo).toBeUndefined(); // never promo on the standard rate
    expect(set.rates).toEqual({ IDR: 110.8606 });
    expect(set.source).toContain('standard (regular) rate stored');
  });

  it('stores the quoted rate untouched when quote agrees with regular', async () => {
    const impl = vi.fn(
      async () =>
        new Response(fixture('computed-value-agree.json'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const set = await fetchInstaremRates(impl as unknown as typeof fetch);
    expect(set.rates).toEqual({ IDR: 110.8606 });
    expect(set.source).not.toContain('promo');
  });

  it('rejects (provider-level failure) on HTTP error', async () => {
    const failing = vi.fn(async () => new Response('rate limited', { status: 429 }));
    await expect(fetchInstaremRates(failing as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 429/
    );
  });

  it('rejects when the payload shape changed and nothing parses', async () => {
    const changed = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: ['geo blocked'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    await expect(fetchInstaremRates(changed as unknown as typeof fetch)).rejects.toThrow(
      /no parsable instarem_fx_rate/
    );
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchInstaremRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /quote fetch failed/i
    );
  });
});
