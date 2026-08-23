import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DCOM_ENDPOINT, fetchDcomRates, parseDcomRates } from '../dcom';

/**
 * Fixture-driven tests for the DCOM adapter (tasks.md task 16).
 * Fixture is the verbatim fx-rate page captured 2026-08-23 from our own
 * egress (19-currency table with send + inverse rate columns).
 */

const FIXTURE_DIR = new URL('../fixtures/dcom/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- parsing ----------------------------------------------------------------

describe('dcom: parseDcomRates', () => {
  it('reads the SEND column (JPY = X) for IDR from the pinned page', () => {
    const rates = parseDcomRates(fixture('fx-rate.html'));
    expect(rates).toEqual({ IDR: 111.0 });
  });

  it('never confuses the send cell with the inverse (X = JPY) cell', () => {
    // Live page: send "IDR 111.0000", inverse "JPY 0.009009" (1/111).
    // If the parser grabbed the inverse cell, IDR would be 0.009009 —
    // ~12,000× off and rejected by any sanity check.
    const rates = parseDcomRates(fixture('fx-rate.html'));
    expect(rates.IDR).toBe(111.0);
    expect(rates.IDR).not.toBe(0.009009);

    const synthetic = `<td>IDR 110.5</td><td>JPY 0.00905</td>`;
    expect(parseDcomRates(synthetic)).toEqual({ IDR: 110.5 });
  });

  it('strips comma grouping and skips malformed cells without throwing', () => {
    const html = `
      <td>Indonesia Rupiah (IDR)</td><td>IDR 10,900.5</td><td>JPY 0.00009</td>`;
    expect(parseDcomRates(html)).toEqual({ IDR: 10_900.5 });

    expect(parseDcomRates('<td>IDR n/a</td>')).toEqual({});
    expect(parseDcomRates('<td>IDR -1</td>')).toEqual({});
    expect(parseDcomRates('<td>IDR 0</td>')).toEqual({});
    expect(parseDcomRates('<html>no table</html>')).toEqual({});
    expect(parseDcomRates('')).toEqual({});
  });
});

// --- full fetch against fixtures ----------------------------------------------

describe('dcom: fetchDcomRates', () => {
  it('fetches the page URL and declares the IDR send rate', async () => {
    const impl = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(fixture('fx-rate.html'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );
    const set = await fetchDcomRates(impl as unknown as typeof fetch);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(String(impl.mock.calls[0][0])).toBe(DCOM_ENDPOINT);

    expect(set.providerId).toBe('dcom');
    expect(set.method).toBe('live');
    expect(set.source).toContain('sendmoney.co.jp');
    expect(set.fetchedAt).toBeTruthy();
    expect(set.isPromo).toBeUndefined();
    expect(set.rates).toEqual({ IDR: 111.0 });
  });

  it('rejects (provider-level failure) when the IDR cell disappears', async () => {
    const pruned = fixture('fx-rate.html').split('IDR 111.0000').join('—');
    expect(pruned).not.toContain('IDR 111.0000');
    const impl = vi.fn(async () => new Response(pruned, { status: 200 }));
    await expect(fetchDcomRates(impl as unknown as typeof fetch)).rejects.toThrow(
      /no declared-corridor rate cells parsed/
    );
  });

  it('rejects on HTTP error', async () => {
    const failing = vi.fn(async () => new Response('down', { status: 503 }));
    await expect(fetchDcomRates(failing as unknown as typeof fetch)).rejects.toThrow(/HTTP 503/);
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchDcomRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /page fetch failed/i
    );
  });
});
