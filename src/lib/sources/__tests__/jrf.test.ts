import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JRF_ENDPOINT, JRF_SOURCE_LABEL, fetchJrfRates, parseRates } from '../jrf';
import type { ObservedRateSet } from '../../../types/remittance';

/**
 * JRF adapter tests (task 20 spike outcome: endpoint reachable from node +
 * workerd egress 2026-08-23). Fixture pinned verbatim from the live board.
 */

const fixtureBody = readFileSync(
  new URL('../fixtures/jrf/extended.json', import.meta.url),
  'utf-8'
);

/** fetch stub serving the pinned fixture. */
function fixtureFetch(status = 200): typeof fetch {
  return (async (_url: URL | RequestInfo, _init?: RequestInit): Promise<Response> =>
    new Response(fixtureBody, {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('parseRates', () => {
  it('parses every JRF corridor from the pinned live board with per-1-JPY values', () => {
    const rates = parseRates(JSON.parse(fixtureBody));
    // Values captured live 2026-08-23 (vs mid-market in the same window).
    expect(rates).toEqual({
      IDR: 111.2, //   mid 111.37 → −0.15%
      PHP: 0.3878, //  mid 0.38872 → −0.24%
      VND: 164.1, //   mid 164.37 → −0.16%
      INR: 0.5991, //  mid ≈0.5866 → above mid; resolver's sanity bound may
      //               drop this corridor on a given day — adapter still reports it.
      NPR: 0.957, //   mid 0.96465 → −0.79%
      THB: 0.2032, //  mid 0.20586 → −1.29%
    });
  });

  it('skips empty-string fx_rate rows (unquoted payment variants) instead of throwing', () => {
    // A "" row (like the BDT headline variant on the live board) must not
    // throw nor poison the currency — the next numeric row for that currency
    // is used.
    const rates = parseRates([
      { currency: 'IDR', fx_rate: '' }, // unquoted variant for a probe currency
      { currency: 'IDR', fx_rate: 111.2, payment_type_text: '- Account Deposit' },
      { currency: 'IDR', fx_rate: 999 }, // duplicate — first numeric wins
      { currency: 'BDT', fx_rate: 0.7661 }, // non-corridor currency — ignored
    ]);
    expect(rates).toEqual({ IDR: 111.2 });
  });

  it('ignores non-finite / non-positive rates and non-array payloads', () => {
    expect(parseRates([{ currency: 'IDR', fx_rate: 0 }])).toEqual({});
    expect(parseRates([{ currency: 'IDR', fx_rate: 'abc' }])).toEqual({});
    expect(parseRates([{ currency: 'IDR' }])).toEqual({});
    expect(parseRates({ not: 'an array' })).toEqual({});
    expect(parseRates(null)).toEqual({});
  });
});

describe('fetchJrfRates', () => {
  it('GETs the extended board with the SPA-expected header and returns an observed set', async () => {
    const spy = vi.fn(fixtureFetch());
    const set: ObservedRateSet = await fetchJrfRates(spy as unknown as typeof fetch);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(JRF_ENDPOINT);
    expect((init?.headers as Record<string, string>)['x-requested-with']).toBe('XMLHttpRequest');

    expect(set.providerId).toBe('jrf');
    expect(set.method).toBe('live');
    expect(set.source).toBe(JRF_SOURCE_LABEL);
    expect(set.fetchedAt).toBeTruthy();
    expect(set.rates.IDR).toBeCloseTo(111.2, 8);
  });

  it('rejects (provider-level) when the board is unreachable', async () => {
    const failing = (async () =>
      new Response('openresty 403', { status: 403 })) as unknown as typeof fetch;
    await expect(fetchJrfRates(failing)).rejects.toThrow(/HTTP 403/);
  });

  it('rejects when no corridor could be parsed', async () => {
    const empty = (async (_u: unknown, _i?: unknown) =>
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await expect(fetchJrfRates(empty)).rejects.toThrow(/no currencies parsed/);
  });
});
