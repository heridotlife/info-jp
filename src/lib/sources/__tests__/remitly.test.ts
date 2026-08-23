import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { simulate } from '../../remittanceCalculator';
import type { RateTable } from '../../rates';
import type { ObservedRateSet } from '../../types/remittance';
import { REMITLY_ENDPOINT, fetchRemitlyRates, parseRemitlyPage } from '../remitly';

/**
 * Fixture-driven tests for the Remitly adapter (tasks.md task 17).
 * Fixture is the verbatim converter page captured 2026-08-23 from our own
 * egress (merchandisingFacts: promo 111.42, everyday 106.85–110.87).
 */

const FIXTURE_DIR = new URL('../fixtures/remitly/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- parsing ----------------------------------------------------------------

describe('remitly: parseRemitlyPage', () => {
  it('extracts the promo rate and everyday range from the pinned page', () => {
    const parsed = parseRemitlyPage(fixture('converter.html'));
    expect(parsed).toEqual({
      promoRate: 111.42,
      everydayLow: 106.85,
      everydayHigh: 110.87,
    });
  });

  it('NEVER reads the secondaryMerchandisingFacts block (USD-shaped numbers)', () => {
    const parsed = parseRemitlyPage(fixture('converter.html'));
    expect(parsed?.promoRate).toBe(111.42);
    expect(parsed?.promoRate).not.toBe(0.0063);

    // Synthetic page where only the secondary block exists → unusable.
    const secondaryOnly =
      '{"secondaryMerchandisingFacts":{"everydayRateAsLowAs":"0.00604","effectiveRateAsLowAs":"0.00630"}}';
    expect(parseRemitlyPage(secondaryOnly)).toBeUndefined();
  });

  it('takes the lower effective value if low and high ever diverge', () => {
    const html =
      '{"merchandisingFacts":{"effectiveRateAsLowAs":"110.0","effectiveRateAsHighAs":"111.0"},"secondaryMerchandisingFacts":{}}';
    expect(parseRemitlyPage(html)?.promoRate).toBe(110.0);
  });

  it('returns undefined for malformed/missing blocks without throwing', () => {
    expect(parseRemitlyPage('<html>client-rendered now</html>')).toBeUndefined();
    expect(parseRemitlyPage('')).toBeUndefined();
    expect(
      parseRemitlyPage('{"merchandisingFacts":{"effectiveRateAsLowAs":"n/a"}}'),
    ).toBeUndefined();
    expect(parseRemitlyPage('{"merchandisingFacts":{}}')).toBeUndefined();
  });
});

// --- full fetch against fixtures ----------------------------------------------

describe('remitly: fetchRemitlyRates', () => {
  it('fetches the page and stores the promo rate WITH isPromo', async () => {
    const impl = vi.fn(async () =>
      new Response(fixture('converter.html'), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const set = await fetchRemitlyRates(impl as unknown as typeof fetch);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(String(impl.mock.calls[0][0])).toBe(REMITLY_ENDPOINT);

    expect(set.providerId).toBe('remitly');
    expect(set.method).toBe('live');
    expect(set.rates).toEqual({ IDR: 111.42 });
    expect(set.isPromo).toBe(true); // §9 — always
    expect(set.source).toContain('PROMO');
    expect(set.source).toContain('106.85–110.87');
  });

  it('rejects (provider-level failure) on HTTP error', async () => {
    const failing = vi.fn(async () => new Response('blocked', { status: 403 }));
    await expect(fetchRemitlyRates(failing as unknown as typeof fetch)).rejects.toThrow(/HTTP 403/);
  });

  it('rejects when the promo block disappears from the page', async () => {
    const redesigned = vi.fn(
      async () =>
        new Response('<!DOCTYPE html><html><body>new design</body></html>', { status: 200 }),
    );
    await expect(fetchRemitlyRates(redesigned as unknown as typeof fetch)).rejects.toThrow(
      /promo rate not found/,
    );
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchRemitlyRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /page fetch failed/i,
    );
  });
});

// --- §9 end-to-end: promo ranks but never wins best-value ---------------------

describe('remitly: promo policy end-to-end through simulate', () => {
  const rates: RateTable = {
    base: 'JPY',
    rates: { IDR: 111.37 },
    fetchedAt: '2026-08-23T10:00:00Z',
    source: 'open.er-api.com',
  };

  it('a promo rate BETTER than every standard rate still cannot win best-value', async () => {
    const promoSet: ObservedRateSet = {
      providerId: 'remitly',
      rates: { IDR: 111.42 }, // above mid — beats every real rate below
      fetchedAt: '2026-08-23T10:00:00Z',
      source: 'remitly.com/jp converter page (new-customer PROMO rate)',
      method: 'live',
      isPromo: true,
    };
    const standardSet: ObservedRateSet = {
      providerId: 'sbi-remit',
      rates: { IDR: 111.11 },
      fetchedAt: '2026-08-23T10:00:00Z',
      source: 'remit.co.jp rate board',
      method: 'live',
    };

    const response = simulate(
      { amountJPY: 100_000, targetCurrency: 'IDR', deliveryType: 'all' },
      rates,
      { remitly: promoSet, 'sbi-remit': standardSet },
    );

    const remitly = response.results.find((r) => r.providerId === 'remitly');
    const sbi = response.results.find((r) => r.providerId === 'sbi-remit');
    expect(remitly).toBeDefined();
    expect(sbi).toBeDefined();

    // The promo row is present, observed, flagged…
    expect(remitly?.rateSource.kind).toBe('observed');
    expect(remitly?.rateSource.isPromo).toBe(true);
    // …and RANKS on payout (top recipient-get for the promo price)…
    expect(remitly?.receiveAmount).toBeGreaterThan(sbi?.receiveAmount ?? 0);
    // …but the best-value tag goes to the best NON-promo row — and because
    // the promo row out-receives EVERYONE, the exclusion is proven real
    // (not vacuous): the tagged winner is a strictly worse-paying row.
    expect(remitly?.tags).not.toContain('best-value');
    const taggedBest = response.results.filter((r) => r.tags.includes('best-value'));
    expect(taggedBest.length).toBe(1);
    expect(taggedBest[0].rateSource.isPromo).not.toBe(true);
    expect(remitly?.receiveAmount).toBeGreaterThan(taggedBest[0].receiveAmount);
    expect(response.results.every((r) => !r.rateSource.isPromo || !r.tags.includes('best-value'))).toBe(true);
  });
});
