import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  WISE_QUOTE_AMOUNT_JPY,
  WISE_QUOTE_ENDPOINT,
  fetchWiseRates,
  parseQuote,
  quoteUrl,
} from '../wise';

/**
 * Fixture-driven tests for the Wise adapter (tasks.md task 9).
 * Fixtures are verbatim quote-gateway responses captured 2026-08-23 from our
 * own egress (fixtures/wise/IDR.json, PHP.json).
 */

const FIXTURE_DIR = new URL('../fixtures/wise/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- raw parsing ---------------------------------------------------------------

describe('wise: parseQuote', () => {
  it('parses a happy-path FIXED quote', () => {
    const idr = JSON.parse(fixture('IDR.json'));
    expect(parseQuote(idr)).toBe(idr.rate);
    expect(parseQuote(idr)).toBe(111.001);
    expect(parseQuote(JSON.parse(fixture('PHP.json')))).toBe(0.388131);
  });

  it('rejects a non-FIXED rateType payload (API drift guard)', () => {
    expect(parseQuote({ rate: 111.0, rateType: 'REFERENCE' })).toBeUndefined();
    expect(parseQuote({ rate: 111.0, rateType: 'NOMINAL' })).toBeUndefined();
    expect(parseQuote({ rate: 111.0 })).toBeUndefined();
  });

  it('skips malformed payloads without throwing', () => {
    expect(parseQuote(null)).toBeUndefined();
    expect(parseQuote('string')).toBeUndefined();
    expect(parseQuote({})).toBeUndefined();
    expect(parseQuote({ rateType: 'FIXED' })).toBeUndefined();
    expect(parseQuote({ rate: '111.0', rateType: 'FIXED' })).toBeUndefined(); // string, not number
    expect(parseQuote({ rate: -1, rateType: 'FIXED' })).toBeUndefined();
    expect(parseQuote({ rate: Number.NaN, rateType: 'FIXED' })).toBeUndefined();
  });
});

// --- request shape (the rateType=FIXED pitfall) ---------------------------------

describe('wise: request shape', () => {
  it('always requests rateType=FIXED (REFERENCE/NOMINAL answer HTTP 400)', () => {
    const url = quoteUrl('IDR');
    expect(url).toBe(
      'https://wise.com/gateway/v1/quotes/?source=JPY&target=IDR&rateType=FIXED&sourceAmount=10000',
    );
    expect(url).not.toContain('rateType=REFERENCE');
    expect(url).not.toContain('rateType=NOMINAL');
    expect(url.endsWith(`sourceAmount=${WISE_QUOTE_AMOUNT_JPY}`)).toBe(true);
  });
});

// --- full fetch against fixtures ----------------------------------------------

/** Build a mock fetch serving fixture bodies by the queried target currency. */
function fixtureFetch(overrides: Record<string, Response> = {}) {
  const calls: string[] = [];
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    calls.push(u);
    const target = /target=([A-Z]{3})/.exec(u)?.[1] ?? '???';
    const override = overrides[target];
    if (override) return override;
    const text = target === 'IDR' || target === 'PHP' ? fixture(`${target}.json`) : JSON.stringify({
      source: 'JPY',
      target,
      sourceAmount: 10000,
      targetAmount: 100000,
      rate: 1.0,
      rateType: 'FIXED',
      fee: 100,
    });
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('wise: fetchWiseRates', () => {
  it('quotes every probe corridor at the canonical amount and parses the board', async () => {
    const { impl, calls } = fixtureFetch();
    const set = await fetchWiseRates(impl);

    expect(set.providerId).toBe('wise');
    expect(set.method).toBe('live');
    expect(set.source).toContain('wise.com');
    expect(set.quoteAmountJPY).toBe(10_000); // §8 provenance
    expect(set.isPromo).toBeUndefined();

    // All 11 registry corridors quoted.
    expect(Object.keys(set.rates).sort()).toEqual(
      ['BDT', 'CNY', 'EUR', 'IDR', 'INR', 'KRW', 'NPR', 'PHP', 'THB', 'USD', 'VND'],
    );
    expect(set.rates.IDR).toBe(111.001); // fixture verbatim
    expect(set.rates.PHP).toBe(0.388131);

    // Request shape: 11 GETs to the quote endpoint, every one rateType=FIXED.
    expect(calls.length).toBe(11);
    for (const url of calls) {
      expect(url.startsWith(WISE_QUOTE_ENDPOINT)).toBe(true);
      expect(url).toContain('source=JPY');
      expect(url).toContain('rateType=FIXED');
      expect(url).toContain('sourceAmount=10000');
    }
  });

  it('skips a corridor on HTTP 400/5xx without failing the set', async () => {
    const { impl } = fixtureFetch({
      KRW: new Response('{"errors":["rateType invalid"]}', { status: 400 }),
      THB: new Response('server error', { status: 503 }),
    });
    const set = await fetchWiseRates(impl);
    expect(set.rates.KRW).toBeUndefined();
    expect(set.rates.THB).toBeUndefined();
    expect(set.rates.IDR).toBe(111.001);
    expect(set.rates.USD).toBe(1.0);
  });

  it('skips a corridor whose payload drifted to a non-FIXED rateType', async () => {
    const drifted = new Response(JSON.stringify({ rate: 111.0, rateType: 'REFERENCE' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { impl } = fixtureFetch({ IDR: drifted });
    const set = await fetchWiseRates(impl);
    expect(set.rates.IDR).toBeUndefined();
    expect(set.rates.PHP).toBe(0.388131);
  });

  it('rejects (provider-level failure) when nothing parses', async () => {
    const garbage = vi.fn(async () => new Response('<html>login</html>', { status: 200 }));
    await expect(fetchWiseRates(garbage as unknown as typeof fetch)).rejects.toThrow(
      /no corridors parsed/i,
    );
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchWiseRates(dead as unknown as typeof fetch)).rejects.toThrow();
  });
});
