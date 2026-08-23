import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  SBI_REMIT_ENDPOINT,
  fetchSbiRemitRates,
  parseRate,
  toPerJPY,
} from '../sbi-remit';

/**
 * Fixture-driven tests for the SBI Remit adapter (tasks.md task 3).
 * Fixtures are the verbatim POST responses captured 2026-08-23 from our own
 * egress (see fixtures/sbi-remit/ — .json per currency + page-options.html).
 */

const FIXTURE_DIR = new URL('../fixtures/sbi-remit/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- raw parsing ---------------------------------------------------------------

describe('sbi-remit: parseRate', () => {
  it('parses a happy-path payload', () => {
    expect(parseRate(JSON.parse(fixture('IDR.json')))).toBe(111.11);
    expect(parseRate(JSON.parse(fixture('PHP.json')))).toBe(0.3885);
    expect(parseRate(JSON.parse(fixture('VND.json')))).toBe(164.5);
    expect(parseRate(JSON.parse(fixture('NPR.json')))).toBe(0.954);
  });

  it('skips unquoted currencies (rate:null / last_update:0)', () => {
    expect(parseRate(JSON.parse(fixture('INR.json')))).toBeUndefined();
    expect(parseRate(JSON.parse(fixture('BDT.json')))).toBeUndefined();
  });

  it('skips malformed payloads without throwing', () => {
    expect(parseRate(null)).toBeUndefined();
    expect(parseRate('string')).toBeUndefined();
    expect(parseRate({})).toBeUndefined();
    expect(parseRate({ rate: 'abc', last_update: '2026-08-23 10:00:00' })).toBeUndefined();
    expect(parseRate({ rate: '-1', last_update: '2026-08-23 10:00:00' })).toBeUndefined();
    expect(parseRate({ rate: '105.0', last_update: 0 })).toBeUndefined();
    expect(parseRate({ rate: '105.0' })).toBeUndefined();
  });
});

// --- quoting-unit normalization -------------------------------------------------

describe('sbi-remit: quoting units', () => {
  it('CNY/THB API values are canonical per-1-JPY (pinned live 2026-08-23)', () => {
    // If these were the page's display units, CNY would be ~419 (per ¥10,000).
    // Pinned against live mid-market: CNY 0.04240, THB 0.20586 (open.er-api.com,
    // 2026-08-23) → implied markups of −1.2% / −1.1%, i.e. sane per-1-JPY rates.
    const cny = parseRate(JSON.parse(fixture('CNY.json')))!;
    const thb = parseRate(JSON.parse(fixture('THB.json')))!;

    expect(cny).toBe(0.0419);
    expect(thb).toBe(0.2035);
    expect(Math.abs(cny / 0.0424 - 1)).toBeLessThan(0.05);
    expect(Math.abs(thb / 0.20586 - 1)).toBeLessThan(0.05);

    // toPerJPY is the single seam for any future quoting-unit change.
    expect(toPerJPY(cny, 'CNY')).toBe(cny);
    expect(toPerJPY(thb, 'THB')).toBe(thb);
  });
});

// --- full fetch against fixtures ---------------------------------------------

/** Build a mock fetch that serves fixture bodies by the POSTed currency. */
function fixtureFetch(overrides: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = String(init?.body ?? '');
    const ccy = /currency=([A-Z]{3})/.exec(body)?.[1] ?? '???';
    const text = overrides[ccy] ?? fixture(`${ccy}.json`);
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('sbi-remit: fetchSbiRemitRates', () => {
  it('builds the documented POST per currency and parses the board', async () => {
    const { impl, calls } = fixtureFetch();
    const set = await fetchSbiRemitRates(impl);

    expect(set.providerId).toBe('sbi-remit');
    expect(set.method).toBe('live');
    expect(set.source).toContain('remit.co.jp');
    expect(set.fetchedAt).toBeTruthy();

    // Six of the eight probed corridors quote rates today.
    expect(Object.keys(set.rates).sort()).toEqual(['CNY', 'IDR', 'NPR', 'PHP', 'THB', 'VND']);
    expect(set.rates.IDR).toBe(111.11);
    expect(set.rates.CNY).toBe(0.0419);

    // Request shape: one POST per probe currency, form-encoded, right URL.
    expect(calls.length).toBe(8);
    for (const call of calls) {
      expect(call.url).toBe(SBI_REMIT_ENDPOINT);
      expect(call.init.method).toBe('POST');
      const headers = call.init.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    }
    const bodies = calls.map((c) => String(c.init.body));
    expect(bodies).toContain('currency=IDR&mode=receive&base=JPY');
    expect(bodies).toContain('currency=THB&mode=receive&base=JPY');
    expect(bodies.every((b) => /^currency=[A-Z]{3}&mode=receive&base=JPY$/.test(b))).toBe(true);
  });

  it('skips a currency on HTTP error without failing the set', async () => {
    // Emulate a 500 for PHP on top of the fixture fetch.
    const { impl } = fixtureFetch();
    const failing = async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes('currency=PHP')) {
        return new Response('boom', { status: 500 });
      }
      return impl(url, init);
    };
    const set = await fetchSbiRemitRates(failing as unknown as typeof fetch);
    expect(set.rates.PHP).toBeUndefined();
    expect(set.rates.IDR).toBe(111.11);
  });

  it('rejects (provider-level failure) when nothing parses', async () => {
    const garbage = vi.fn(async () => new Response('<html>login</html>', { status: 200 }));
    await expect(fetchSbiRemitRates(garbage as unknown as typeof fetch)).rejects.toThrow(
      /no currencies parsed/i,
    );
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchSbiRemitRates(dead as unknown as typeof fetch)).rejects.toThrow();
  });
});
