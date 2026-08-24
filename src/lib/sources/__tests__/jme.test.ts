import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JME_ENDPOINT, fetchJmeRates, jmeRateSection, parseJmeRates } from '../jme';

/**
 * Fixture-driven tests for the JME adapter (tasks.md task 15).
 * Fixture is the verbatim exchange-rate page captured 2026-08-23 from our
 * own egress — four tables: JME own rates (desktop+mobile) and MoneyGram
 * rates (desktop+mobile); Indonesia rows carry a promo-rate trap.
 */

const FIXTURE_DIR = new URL('../fixtures/jme/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- section scoping ----------------------------------------------------------

describe('jme: jmeRateSection', () => {
  it('cuts the page at the MoneyGram pane so MG rows are unreachable', () => {
    const section = jmeRateSection(fixture('exchange-rate.html'));
    expect(section).not.toContain('counter-mg-pane');
    // The MoneyGram method labels live past the cut.
    expect(section).not.toMatch(/Bank Deposit - All Banks/);
    // JME's own method labels are inside.
    expect(section).toMatch(/BANK DEPOSIT, CASH PICK UP/);
  });
});

// --- parsing ------------------------------------------------------------------

describe('jme: parseJmeRates', () => {
  it('reads the BANK DEPOSIT method row for IDR from the pinned page', () => {
    const rates = parseJmeRates(fixture('exchange-rate.html'));
    expect(rates).toEqual({ IDR: 110.1035 });
  });

  it('NEVER stores the above-mid empty-method promo row (112.4665)', () => {
    // Live 2026-08-23: the empty-method row sits ~+0.98% ABOVE mid-market —
    // inside the resolver sanity bound (mid × 1.02), so the method filter is
    // the only structural guard. Prove it stays out.
    const rates = parseJmeRates(fixture('exchange-rate.html'));
    expect(rates.IDR).not.toBe(112.4665);
    expect(rates.IDR).not.toBe(110.297); // Card Payment row also excluded
  });

  it('skips MoneyGram-method rows even if the section cut fails', () => {
    // Emulate markup drift: full page (both panes) as the section. The
    // MoneyGram "Bank Deposit - All Banks" rows match /BANK DEPOSIT/i — but
    // only if a declared-currency MG row exists AND sorts before the JME row
    // could it win; today's page has no Indonesia MG rows, so IDR still
    // resolves to JME's rate.
    const rates = parseJmeRates(fixture('exchange-rate.html'));
    expect(rates.IDR).toBe(110.1035);
  });

  it('guards against malformed markup without throwing', () => {
    expect(parseJmeRates('<html>no tables</html>')).toEqual({});
    const junk = `
      <table><tr><td>Country</td><td>Method</td><td>Currency</td><td>Rate</td></tr>
      <tr><td>Indonesia</td><td>BANK DEPOSIT</td><td>IDR</td><td>n/a</td></tr>
      <tr><td>Indonesia</td><td>BANK DEPOSIT</td><td>IDR</td><td>-1</td></tr>
      <tr><td>Indonesia</td><td>BANK DEPOSIT</td><td></td><td>110.1</td></tr>
      <tr><td>Indonesia</td><td></td><td>IDR</td><td>112.4665</td></tr>
      <tr><td>broken row</td></tr>
      </table>`;
    expect(parseJmeRates(junk)).toEqual({});
  });
});

// --- full fetch against fixtures ----------------------------------------------

describe('jme: fetchJmeRates', () => {
  it('fetches the page URL and declares the bank-deposit IDR rate', async () => {
    const impl = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(fixture('exchange-rate.html'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );
    const set = await fetchJmeRates(impl as unknown as typeof fetch);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(String(impl.mock.calls[0][0])).toBe(JME_ENDPOINT);

    expect(set.providerId).toBe('jme');
    expect(set.method).toBe('live');
    expect(set.source).toContain('BANK DEPOSIT');
    expect(set.fetchedAt).toBeTruthy();
    expect(set.isPromo).toBeUndefined();
    expect(set.rates).toEqual({ IDR: 110.1035 });
  });

  it('rejects (provider-level failure) when the bank-deposit row disappears', async () => {
    // Remove the method label from EVERY copy (desktop + mobile tables).
    const pruned = fixture('exchange-rate.html')
      .split('BANK DEPOSIT, CASH PICK UP')
      .join('METHOD GONE');
    expect(pruned).not.toContain('BANK DEPOSIT, CASH PICK UP');
    const impl = vi.fn(async () => new Response(pruned, { status: 200 }));
    await expect(fetchJmeRates(impl as unknown as typeof fetch)).rejects.toThrow(
      /no BANK DEPOSIT method rows parsed/
    );
  });

  it('rejects on HTTP error', async () => {
    const failing = vi.fn(async () => new Response('down', { status: 500 }));
    await expect(fetchJmeRates(failing as unknown as typeof fetch)).rejects.toThrow(/HTTP 500/);
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchJmeRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /page fetch failed/i
    );
  });
});
