import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  PAYFOREX_AJAX_URL,
  PAYFOREX_SIMULATOR_URL,
  fetchPayForexRates,
  parseCsrfToken,
  parsePerJpyRate,
} from '../payforex';

/**
 * Fixture-driven tests for the PayForex adapter (tasks.md task 12).
 * Fixtures captured 2026-08-23 from our own egress:
 *   simulator.html — the page that hands out the session + _csrf token
 *   ajax-rate.json — the GetRemitRateAction response (IDR corridor)
 */

const FIXTURE_DIR = new URL('../fixtures/payforex/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- parsing ----------------------------------------------------------------

describe('payforex: parsePerJpyRate', () => {
  it('parses the live fixture value', () => {
    const json = JSON.parse(fixture('ajax-rate.json'));
    expect(parsePerJpyRate(json.resultData.currencyRate)).toBe(109.0037);
  });

  it('strips comma-grouped numbers (dedicated pitfall test)', () => {
    expect(parsePerJpyRate('1 JPY = 10,900.37 IDR')).toBe(10_900.37);
    expect(parsePerJpyRate(' (1 JPY = 1,234,567 IDR) ')).toBe(1_234_567);
  });

  it('returns undefined for malformed values without throwing', () => {
    expect(parsePerJpyRate(undefined)).toBeUndefined();
    expect(parsePerJpyRate(109)).toBeUndefined();
    expect(parsePerJpyRate('')).toBeUndefined();
    expect(parsePerJpyRate('rate unavailable')).toBeUndefined();
    expect(parsePerJpyRate('1 JPY = IDR')).toBeUndefined();
    expect(parsePerJpyRate('1 JPY = 0 IDR')).toBeUndefined();
    expect(parsePerJpyRate('1 USD = 0.006 IDR')).toBeUndefined(); // wrong pair
  });
});

describe('payforex: parseCsrfToken', () => {
  it('extracts the token from the pinned simulator page', () => {
    const token = parseCsrfToken(fixture('simulator.html'));
    expect(token).toMatch(/^[0-9a-f-]{36}$/); // a UUID, like the live one
  });

  it('returns undefined when the meta tag is missing', () => {
    expect(parseCsrfToken('<html><body>login</body></html>')).toBeUndefined();
  });
});

// --- the two-step flow against fixtures --------------------------------------

/** Mock fetch implementing the two-step flow with swappable responses. */
function flowFetch(overrides: { sim?: Response; ajax?: Response } = {}) {
  const calls: Array<{ url: string; init?: RequestInit; headers: Record<string, string> }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const headers = Object.fromEntries(
      new Headers(init?.headers as HeadersInit | undefined)
    ) as Record<string, string>;
    calls.push({ url: u, init, headers });
    if (u === PAYFOREX_SIMULATOR_URL) {
      if (overrides.sim) return overrides.sim;
      return new Response(fixture('simulator.html'), {
        status: 200,
        headers: { 'set-cookie': '__Host-PFXID=fake-session-id; Path=/; Secure' },
      });
    }
    if (u === PAYFOREX_AJAX_URL) {
      if (overrides.ajax) return overrides.ajax;
      return new Response(fixture('ajax-rate.json'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('payforex: fetchPayForexRates', () => {
  it('runs the session→CSRF→rate dance with the documented request shapes', async () => {
    const { impl, calls } = flowFetch();
    const set = await fetchPayForexRates(impl);

    expect(set.providerId).toBe('payforex');
    expect(set.method).toBe('live');
    expect(set.source).toContain('BR_BRI');
    expect(set.rates).toEqual({ IDR: 109.0037 });

    // Step 1 hit the simulator page.
    expect(calls[0].url).toBe(PAYFOREX_SIMULATOR_URL);

    // Step 2 POSTed /ajax with CSRF + X-Requested-With + cookie + JSON body.
    const ajax = calls[1];
    expect(ajax.url).toBe(PAYFOREX_AJAX_URL);
    expect(ajax.init?.method).toBe('POST');
    expect(ajax.headers['x-csrf-token']).toBe(parseCsrfToken(fixture('simulator.html')));
    expect(ajax.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(ajax.headers.cookie).toContain('__Host-PFXID=');
    const body = JSON.parse(String(ajax.init?.body));
    expect(body.func).toBe('GetRemitRateAction');
    expect(body.args).toMatchObject({
      country: 'Indonesia',
      receiptCode: 'BR_BRI',
      fromFx: 'JPY',
      toFx: 'IDR',
    });
  });

  it('rejects (isolated, single error) when the CSRF token is missing', async () => {
    const { impl } = flowFetch({
      sim: new Response('<html>no meta tag here</html>', { status: 200 }),
    });
    await expect(fetchPayForexRates(impl)).rejects.toThrow(/session\/CSRF step failed.*_csrf/);
  });

  it('rejects when the ajax step answers HTTP error', async () => {
    const { impl } = flowFetch({ ajax: new Response('forbidden', { status: 403 }) });
    await expect(fetchPayForexRates(impl)).rejects.toThrow(/rate-action step failed.*HTTP 403/);
  });

  it('rejects when the ajax result is not OK (expired session shape)', async () => {
    const expired = new Response(JSON.stringify({ result: 'NG', resultMsg: 'session expired' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { impl } = flowFetch({ ajax: expired });
    await expect(fetchPayForexRates(impl)).rejects.toThrow(/rate-action step failed.*result NG/);
  });

  it('rejects when the response carries no parsable currencyRate', async () => {
    const blank = new Response(JSON.stringify({ result: 'OK', resultData: { currencyRate: '' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { impl } = flowFetch({ ajax: blank });
    await expect(fetchPayForexRates(impl)).rejects.toThrow(/currencyRate missing\/unparsable/);
  });

  it('rejects when the network dies mid-flow', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchPayForexRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /session\/CSRF step failed/
    );
  });
});
