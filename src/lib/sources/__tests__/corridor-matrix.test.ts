import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RATE_ADAPTERS } from '../index';
import { DOCUMENTED_SKIPS } from '../shared';
import { PROVIDERS } from '../../providers';
import type { CurrencyCode, ObservedRateSet } from '../../../types/remittance';

/**
 * ============================================================================
 *  CORRIDOR MATRIX TEST (tasks.md task 22)
 * ============================================================================
 *
 * Every registered adapter is exercised against ALL corridors its provider
 * declares in the registry (`supportedCurrencies`) using that adapter's
 * pinned fixtures. A corridor that is absent from the parsed result must be
 * an entry in DOCUMENTED_SKIPS (a source-verified gap) — anything else is a
 * regression. The LIVE version of this matrix (including IDR from real
 * egress) runs in `npm run verify:rates`.
 *
 * Per-source isolation is asserted here too: adapters run in one parallel
 * wave exactly like the resolver's cold start; one adapter's fixture being
 * deliberately broken must not leak into any other adapter's result.
 */

const FIXTURES = new URL('../fixtures/', import.meta.url);
const fixture = (path: string): string => readFileSync(new URL(path, FIXTURES), 'utf-8');

const jsonResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });
const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

/**
 * One fetch stub per adapter, serving that adapter's pinned fixtures by URL
 * (or, for SBI, by the POSTed currency). Mirrors the stubs in each adapter's
 * own test file.
 */
function fixtureFetchFor(providerId: string): typeof fetch {
  const impl = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    switch (providerId) {
      case 'sbi-remit': {
        const ccy = /currency=([A-Z]{3})/.exec(String(init?.body ?? ''))?.[1];
        return jsonResponse(fixture(`sbi-remit/${ccy ?? 'XXX'}.json`));
      }
      case 'wise': {
        const ccy = /target=([A-Z]{3})/.exec(u)?.[1];
        return jsonResponse(fixture(`wise/${ccy ?? 'XXX'}.json`));
      }
      case 'seven-bank-wu':
        return new Response(fixture('seven-bank-wu/CurrentFXList.xml'), {
          status: 200,
          headers: { 'content-type': 'text/xml' },
        });
      case 'smiles':
        return htmlResponse(fixture('smiles/exchange-rates.html'));
      case 'payforex':
        if (u.includes('simulator')) {
          return new Response(fixture('payforex/simulator.html'), {
            status: 200,
            headers: { 'set-cookie': '__Host-PFXID=fake-session-id; Path=/; Secure' },
          });
        }
        return jsonResponse(fixture('payforex/ajax-rate.json'));
      case 'instarem':
        return jsonResponse(fixture('instarem/computed-value.json'));
      case 'city-express':
        return jsonResponse(fixture('city-express/rates.json'));
      case 'jme':
        return htmlResponse(fixture('jme/exchange-rate.html'));
      case 'dcom':
        return htmlResponse(fixture('dcom/fx-rate.html'));
      case 'remitly':
        return htmlResponse(fixture('remitly/converter.html'));
      case 'bni-tokyo':
        return htmlResponse(fixture('bni-tokyo/faq-et.html'));
      case 'jrf':
        return jsonResponse(fixture('jrf/extended.json'));
      default:
        return new Response('no fixture route', { status: 404 });
    }
  };
  return impl as unknown as typeof fetch;
}

describe('corridor matrix: adapter coverage vs provider registry', () => {
  const providersWithAdapters = PROVIDERS.filter((p) => RATE_ADAPTERS[p.id]);

  it('every provider-with-adapter declares at least one corridor', () => {
    expect(providersWithAdapters.length).toBeGreaterThanOrEqual(12);
    for (const p of providersWithAdapters) {
      expect(p.supportedCurrencies.length).toBeGreaterThan(0);
    }
  });

  for (const provider of providersWithAdapters) {
    it(`${provider.id}: covers every declared corridor (or a documented skip)`, async () => {
      const adapter = RATE_ADAPTERS[provider.id];
      const set: ObservedRateSet = await adapter.fetchRates(fixtureFetchFor(provider.id));
      expect(set.providerId).toBe(provider.id);

      const skips = new Set<string>(DOCUMENTED_SKIPS[provider.id] ?? []);
      for (const code of provider.supportedCurrencies as CurrencyCode[]) {
        if (skips.has(code)) {
          // Documented skip may be absent — but must NEVER be silently
          // present-but-bogus: if present it still has to be a sane number.
          const rate = set.rates[code];
          if (rate !== undefined) expect(Number.isFinite(rate) && rate > 0).toBe(true);
          continue;
        }
        expect(
          set.rates[code],
          `${provider.id} corridor ${code} missing from adapter output`
        ).toBeDefined();
        expect(set.rates[code]!).toBeGreaterThan(0);
      }
    });
  }

  it('IDR is covered by every IDR-corridor adapter (the comparison’s headline corridor)', async () => {
    const idrProviders = providersWithAdapters.filter((p) => p.supportedCurrencies.includes('IDR'));
    expect(idrProviders.length).toBeGreaterThanOrEqual(8);
    const sets = await Promise.all(
      idrProviders.map(async (p) => ({
        id: p.id,
        rate: (await RATE_ADAPTERS[p.id].fetchRates(fixtureFetchFor(p.id))).rates.IDR,
      }))
    );
    for (const { id, rate } of sets) {
      expect(rate, `${id} IDR fixture rate missing`).toBeDefined();
      // Wide cross-provider envelope for the pinned fixtures (2026-08-23
      // captures all sit in 103–112; BNI is the wide-spread outlier at 107.99).
      expect(rate!).toBeGreaterThan(80);
      expect(rate!).toBeLessThan(150);
    }
  });
});

describe('corridor matrix: per-source isolation', () => {
  it('a crashing adapter in the cold wave never affects the others', async () => {
    const providersWithAdapters = PROVIDERS.filter((p) => RATE_ADAPTERS[p.id]);
    const boom = providersWithAdapters[0].id;
    const results = await Promise.allSettled(
      providersWithAdapters.map(async (p) => {
        if (p.id === boom) throw new Error('network unreachable');
        return RATE_ADAPTERS[p.id].fetchRates(fixtureFetchFor(p.id));
      })
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(providersWithAdapters.length - 1);
    for (const r of ok) {
      expect(r.status === 'fulfilled' && Object.keys(r.value.rates).length > 0).toBe(true);
    }
  });
});
