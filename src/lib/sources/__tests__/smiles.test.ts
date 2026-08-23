import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SMILES_ENDPOINT, fetchSmilesRates, parseExchangeRates } from '../smiles';

/**
 * Fixture-driven tests for the Smiles adapter (tasks.md task 11).
 * Fixture is the verbatim server-rendered exchange-rates page captured
 * 2026-08-23 from our own egress (THB absent from the live board).
 */

const FIXTURE_DIR = new URL('../fixtures/smiles/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- board parsing ---------------------------------------------------------------

describe('smiles: parseExchangeRates', () => {
  it('parses every country block of the pinned live page', () => {
    const rates = parseExchangeRates(fixture('exchange-rates.html'));
    expect(rates).toEqual({
      USD: 0.0062,
      PHP: 0.388,
      INR: 0.598,
      BDT: 0.766,
      NPR: 0.96,
      IDR: 111.1,
      VND: 164.2,
    });
  });

  it('THB is absent from the live board (pinned 2026-08-23) — not declared', () => {
    const rates = parseExchangeRates(fixture('exchange-rates.html'));
    expect(rates.THB).toBeUndefined();
  });

  it('accepts both quote styles and strips comma grouping', () => {
    const html = `
      <a class="exchange_rate">111,100.5 IDR</a>
      <a class='exchange_rate'>0.388 PHP</a>`;
    expect(parseExchangeRates(html)).toEqual({ IDR: 111_100.5, PHP: 0.388 });
  });

  it('guards against malformed markup without throwing', () => {
    expect(parseExchangeRates('<html>no anchors here</html>')).toEqual({});
    const junk = `
      <a class='exchange_rate'>see details</a>
      <a class='exchange_rate'>-- IDR</a>
      <a class='exchange_rate'></a>
      <a class='exchange_rate'>0.5</a>
      <a class='other'>111.1 IDR</a>
      <a class='exchange_rate'>-3.0 THB</a>`;
    expect(parseExchangeRates(junk)).toEqual({});
  });
});

// --- full fetch against fixtures ----------------------------------------------

describe('smiles: fetchSmilesRates', () => {
  it('fetches the page URL and declares the quoted registry corridors', async () => {
    const impl = vi.fn(async () =>
      new Response(fixture('exchange-rates.html'), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const set = await fetchSmilesRates(impl as unknown as typeof fetch);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(String(impl.mock.calls[0][0])).toBe(SMILES_ENDPOINT);

    expect(set.providerId).toBe('smiles');
    expect(set.method).toBe('live');
    expect(set.source).toContain('smileswallet.com');
    expect(set.fetchedAt).toBeTruthy();

    // 6 of the 7 registry corridors quote today (THB absent, USD not a
    // registry corridor for Smiles → not declared).
    expect(Object.keys(set.rates).sort()).toEqual(['BDT', 'IDR', 'INR', 'NPR', 'PHP', 'VND']);
    expect(set.rates.IDR).toBe(111.1);
    expect(set.rates.VND).toBe(164.2);
  });

  it('skips a missing block but keeps the set (partial board)', async () => {
    const pruned = fixture('exchange-rates.html').replace(
      /<a href='https:\/\/www\.smileswallet\.com\/japan\/exchange-rates\/jpy-to-idr\/'[^>]*class='exchange_rate'>111\.1 IDR<\/a>/,
      '',
    );
    expect(pruned).not.toContain('111.1 IDR');
    const impl = vi.fn(async () => new Response(pruned, { status: 200 }));
    const set = await fetchSmilesRates(impl as unknown as typeof fetch);
    expect(set.rates.IDR).toBeUndefined(); // block missing → corridor skipped
    expect(set.rates.PHP).toBe(0.388);
  });

  it('rejects (provider-level failure) on HTTP error', async () => {
    const failing = vi.fn(async () => new Response('rate limited', { status: 429 }));
    await expect(fetchSmilesRates(failing as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 429/,
    );
  });

  it('rejects when the markup changed and nothing parses', async () => {
    const redesigned = vi.fn(
      async () =>
        new Response('<!DOCTYPE html><html><body>client-rendered now</body></html>', {
          status: 200,
        }),
    );
    await expect(fetchSmilesRates(redesigned as unknown as typeof fetch)).rejects.toThrow(
      /no corridors parsed/i,
    );
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchSmilesRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /page fetch failed/i,
    );
  });
});
