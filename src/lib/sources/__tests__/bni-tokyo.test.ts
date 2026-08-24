import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { classifyStaleness } from '../../observedRates';
import {
  BNI_TOKYO_ENDPOINT,
  fetchBniTokyoRates,
  parseBniTokyoRates,
  ttsSection,
} from '../bni-tokyo';

/**
 * Fixture-driven tests for the BNI Tokyo adapter (tasks.md task 18).
 * Fixture is the verbatim faq-et board captured 2026-08-23 from our own
 * egress — it contains BOTH the TTS (remittance) card and the TTB card;
 * only TTS may ever be read.
 */

const FIXTURE_DIR = new URL('../fixtures/bni-tokyo/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), 'utf-8');

// --- section scoping ----------------------------------------------------------

describe('bni-tokyo: ttsSection', () => {
  it('cuts the page before the TTB card', () => {
    const section = ttsSection(fixture('faq-et.html'));
    expect(section).toContain('TTS');
    expect(section).not.toMatch(/TTB/);
    expect(section).toContain('( IDR per JPY )');
  });
});

// --- parsing ------------------------------------------------------------------

describe('bni-tokyo: parseBniTokyoRates', () => {
  it('reads the TTS per-1-JPY rate from the pinned page', () => {
    const parsed = parseBniTokyoRates(fixture('faq-et.html'));
    // Live board 2026-08-21 09:20: "( IDR per JPY ) 107.99".
    expect(parsed).toEqual({ rate: 107.99, boardTimestamp: '2026-08-21 09:20' });
  });

  it('NEVER reads the TTB card (fixture carries both)', () => {
    // Craft a page where TTB is wildly different (1 IDR = 999 JPY). If the
    // parser ever touched the TTB card, the rate would be ~1/999, not 107.99.
    const poisoned = fixture('faq-et.html').replace(
      /(<div class="psr-cap">TTB<\/div>[\s\S]*?<tbody>)([\s\S]*?<\/tbody>)/,
      '$1<tr><td>IDR</td><td>999</td></tr><tr><td>( IDR per JPY )</td><td>0.001</td></tr>$2'
    );
    expect(parseBniTokyoRates(poisoned)?.rate).toBe(107.99);
  });

  it('falls back to inverting the JPY-per-IDR TTS row', () => {
    const noPerJpyRow = fixture('faq-et.html').replace(
      /<tr>\s*<td>\(\s*IDR per JPY\s*\)<\/td>\s*<td>[0-9.]+<\/td>\s*<\/tr>/,
      ''
    );
    const parsed = parseBniTokyoRates(noPerJpyRow);
    expect(parsed?.rate).toBeCloseTo(1 / 0.00926, 4); // ≈ 107.99
  });

  it('returns undefined for malformed/missing cards without throwing', () => {
    expect(parseBniTokyoRates('<html>no board</html>')).toBeUndefined();
    expect(parseBniTokyoRates('')).toBeUndefined();
    const junk =
      '<div class="psr-cap">対円為替レート（送金）</div><table><tbody>' +
      '<tr><td>USD</td><td>abc</td></tr>' +
      '<tr><td>IDR</td><td>n/a</td></tr>' +
      '</tbody></table><div class="psr-cap">TTB</div>';
    expect(parseBniTokyoRates(junk)).toBeUndefined();
  });
});

// --- full fetch against fixtures ----------------------------------------------

describe('bni-tokyo: fetchBniTokyoRates', () => {
  it('fetches the plain-HTTP board URL and stores the TTS rate', async () => {
    const impl = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(fixture('faq-et.html'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );
    const set = await fetchBniTokyoRates(impl as unknown as typeof fetch);

    expect(impl).toHaveBeenCalledTimes(1);
    expect(String(impl.mock.calls[0][0])).toBe(BNI_TOKYO_ENDPOINT);
    expect(String(impl.mock.calls[0][0])).toMatch(/^http:\/\//); // plain HTTP, server-side only

    expect(set.providerId).toBe('bni-tokyo');
    expect(set.method).toBe('live');
    expect(set.rates).toEqual({ IDR: 107.99 });
    expect(set.source).toContain('TTS');
    expect(set.source).toContain('2026-08-21 09:20'); // board stamp in the label
    expect(set.isPromo).toBeUndefined();

    // Staleness classifier exercised: a fresh fetch classifies fresh; the
    // BOARD itself is two days old (weekend) and only the label carries it —
    // the 12 h TTL policy (rev 4) accepts that.
    expect(classifyStaleness(set.fetchedAt)).toBe('fresh');
    expect(classifyStaleness('2026-08-21T00:20:00+09:00')).not.toBe('fresh');
  });

  it('rejects (provider-level failure) on HTTP error', async () => {
    const failing = vi.fn(async () => new Response('down', { status: 500 }));
    await expect(fetchBniTokyoRates(failing as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 500/
    );
  });

  it('rejects when the TTS card disappears', async () => {
    const redesigned = vi.fn(
      async () => new Response('<!DOCTYPE html><html><body>new site</body></html>', { status: 200 })
    );
    await expect(fetchBniTokyoRates(redesigned as unknown as typeof fetch)).rejects.toThrow(
      /TTS rate card not parsable/
    );
  });

  it('rejects when the network is unreachable', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchBniTokyoRates(dead as unknown as typeof fetch)).rejects.toThrow(
      /board fetch failed/i
    );
  });
});
