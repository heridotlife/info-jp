import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { withinSanityBound } from '../../observedRates';
import {
  COUNTRY_CODES,
  SEVEN_BANK_ENDPOINT,
  fetchSevenBankRates,
  parseFxList,
  pickRate,
} from '../seven-bank-wu';

/**
 * Fixture-driven tests for the Seven Bank / WU adapter (tasks.md task 10).
 * Fixture is the verbatim CurrentFXList.xml captured 2026-08-23 from our own
 * egress (191 country blocks; VN carries USD+VND, PH carries PHP+USD).
 */

const FIXTURE_DIR = new URL('../fixtures/seven-bank-wu/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- board parsing ---------------------------------------------------------------

describe('seven-bank-wu: parseFxList', () => {
  it('parses the pinned live board, keyed by countrycode', () => {
    const board = parseFxList(fixture('CurrentFXList.xml'));
    expect(board.size).toBeGreaterThan(150);
    expect(board.get('ID')).toEqual({ IDR: 110.9163283 });
  });

  it('keeps every currency of a multi-currency country block', () => {
    const board = parseFxList(fixture('CurrentFXList.xml'));
    expect(board.get('VN')).toEqual({ USD: 0.0062692, VND: 163.7151341 });
    expect(board.get('PH')).toEqual({ PHP: 0.3797186, USD: 0.0061529 });
  });

  it('skips malformed rows instead of throwing', () => {
    const board = parseFxList(`
      <fxrateinfo><countries>
        <country><countrycode>ID</countrycode>
          <currency><currencycode>IDR</currencycode><fxrate>NOT_A_NUMBER</fxrate></currency>
          <currency><currencycode>USD</currencycode><fxrate>0.006</fxrate></currency>
        </country>
        <country><countryname>No country code</countryname>
          <currency><currencycode>THB</currencycode><fxrate>0.2</fxrate></currency>
        </country>
        <country><countrycode>TH</countrycode></country>
        <garbage>totally malformed</garbage>
      </countries></fxrateinfo>`);
    expect(board.size).toBe(1);
    expect(board.get('ID')).toEqual({ USD: 0.006 });
    expect(board.has('TH')).toBe(false);
  });
});

// --- countrycode mapping (the ID≠IDR pitfall) ------------------------------------

describe('seven-bank-wu: countrycode mapping', () => {
  it('maps every declared corridor to its two-letter country code', () => {
    expect(COUNTRY_CODES.IDR).toBe('ID'); // the pitfall
    expect(COUNTRY_CODES.PHP).toBe('PH');
    expect(COUNTRY_CODES.VND).toBe('VN');
    expect(COUNTRY_CODES.INR).toBe('IN');
    expect(COUNTRY_CODES.NPR).toBe('NP');
    expect(COUNTRY_CODES.BDT).toBe('BD');
    expect(COUNTRY_CODES.THB).toBe('TH');
    expect(COUNTRY_CODES.USD).toBe('US');
  });

  it('picks the corridor currency, not a sibling USD row', () => {
    const board = parseFxList(fixture('CurrentFXList.xml'));
    // VN block has BOTH USD 0.0062692 and VND 163.7151341 — VND must win for VND.
    expect(pickRate(board, 'VND')).toBe(163.7151341);
    // USD corridor reads the US block (0.0060008), never VN/PH/AS USD rows.
    expect(pickRate(board, 'USD')).toBe(0.0060008);
    expect(pickRate(board, 'IDR')).toBe(110.9163283);
  });

  it('skips a corridor whose country or currency row is missing', () => {
    const board = parseFxList(fixture('CurrentFXList.xml'));
    // KRW: Korea is not a WU corridor on this board → undefined, no throw.
    expect(pickRate(board, 'KRW')).toBeUndefined();
    const empty = new Map<string, Record<string, number>>();
    expect(pickRate(empty, 'IDR')).toBeUndefined();
  });
});

// --- sanity bound (unit-regression backstop) -------------------------------------

describe('seven-bank-wu: sanity bound', () => {
  it('fixture rates pass the resolver sanity bound vs live mid-market', () => {
    // Live mid-market (open.er-api.com, 2026-08-23) for the fixture's rates.
    const mid = {
      IDR: 111.37,
      PHP: 0.388716,
      VND: 164.366096,
      INR: 0.602907,
      NPR: 0.96465,
      BDT: 0.769137,
      THB: 0.20586,
      USD: 0.006294,
    } as const;
    const board = parseFxList(fixture('CurrentFXList.xml'));
    for (const [ccy, midRate] of Object.entries(mid)) {
      const rate = pickRate(board, ccy as keyof typeof mid)!;
      expect(withinSanityBound(rate, midRate), `${ccy} ${rate} vs mid ${midRate}`).toBe(true);
    }
  });

  it('a unit regression (per-¥10,000 quoting) is caught by the bound', () => {
    // If the board ever switched IDR to per-¥10,000 units, ~1,109,163 must be
    // rejected against mid 111.37 — this is the backstop the resolver applies.
    expect(withinSanityBound(1_109_163.283, 111.37)).toBe(false);
    expect(withinSanityBound(110.9163283, 111.37)).toBe(true);
  });
});

// --- full fetch against fixtures ----------------------------------------------

describe('seven-bank-wu: fetchSevenBankRates', () => {
  it('fetches the board URL and declares every live-verified corridor', async () => {
    const impl = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(fixture('CurrentFXList.xml'), {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      }),
    );
    const set = await fetchSevenBankRates(impl as unknown as typeof fetch);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(String(impl.mock.calls[0][0])).toBe(SEVEN_BANK_ENDPOINT);

    expect(set.providerId).toBe('seven-bank-wu');
    expect(set.method).toBe('live');
    expect(set.source).toContain('CurrentFXList.xml');
    expect(set.fetchedAt).toBeTruthy();

    // All 8 registry corridors were on the board 2026-08-23.
    expect(Object.keys(set.rates).sort()).toEqual(
      ['BDT', 'IDR', 'INR', 'NPR', 'PHP', 'THB', 'USD', 'VND'],
    );
    expect(set.rates.IDR).toBe(110.9163283);
    expect(set.rates.VND).toBe(163.7151341);
  });

  it('skips missing corridors but keeps the set (partial board)', async () => {
    const pruned = fixture('CurrentFXList.xml').replace(
      /<country>\s*<countrycode>ID<\/countrycode>[\s\S]*?<\/country>/,
      '',
    );
    const impl = vi.fn(async () => new Response(pruned, { status: 200 }));
    const set = await fetchSevenBankRates(impl as unknown as typeof fetch);
    expect(set.rates.IDR).toBeUndefined(); // corridor skipped
    expect(set.rates.PHP).toBe(0.3797186);
  });

  it('rejects (provider-level failure) on HTTP error', async () => {
    const failing = vi.fn(async () => new Response('gone', { status: 404 }));
    await expect(fetchSevenBankRates(failing as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('rejects when nothing parses', async () => {
    const garbage = vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 }));
    await expect(fetchSevenBankRates(garbage as unknown as typeof fetch)).rejects.toThrow(
      /no corridors parsed/i,
    );
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchSevenBankRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /board fetch failed/i,
    );
  });
});
