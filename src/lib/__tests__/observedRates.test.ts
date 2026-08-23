import { describe, expect, it, vi } from 'vitest';
import {
  OBSERVED_TTL_SECONDS,
  classifyStaleness,
  resolveObservedRates,
  withinSanityBound,
} from '../observedRates';
import type { RateAdapter } from '../sources';
import { simulate } from '../remittanceCalculator';
import type { ObservedRateSet } from '../../types/remittance';
import type { RateTable } from '../rates';
import { readFileSync } from 'node:fs';

/**
 * Read-through observed-rate resolver tests (tasks.md task 4) — KV + fetch
 * fully mocked; SBI's real adapter drives the simulate() integration cases.
 */

// --- mock KV -------------------------------------------------------------------

interface MockKV {
  kv: KVNamespace;
  store: Map<string, string>;
  puts: Array<{ key: string; value: string; opts: Record<string, unknown> }>;
}

function mockKV(seed: Record<string, unknown> = {}): MockKV {
  const store = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const puts: MockKV['puts'] = [];
  const kv = {
    async get(key: string, type?: string): Promise<unknown> {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string, opts?: Record<string, unknown>): Promise<void> {
      puts.push({ key, value, opts: opts ?? {} });
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

// --- helpers --------------------------------------------------------------------

function setId(rates: ObservedRateSet['rates']): ObservedRateSet {
  return {
    providerId: 'sbi-remit',
    rates,
    fetchedAt: '2026-08-23T09:00:00Z',
    source: 'test-adapter',
    method: 'live',
  };
}

const adapterReturning = (set: ObservedRateSet) => ({
  fetchRates: vi.fn(async () => set),
});

const adapterRejecting = (message: string): RateAdapter => ({
  fetchRates: vi.fn(async () => {
    throw new Error(message);
  }),
});

// --- staleness classifier ---------------------------------------------------------

describe('classifyStaleness', () => {
  const now = Date.parse('2026-08-23T12:00:00Z');

  it('classifies fresh / stale / expired bands', () => {
    const at = (hoursAgo: number) =>
      new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();

    expect(classifyStaleness(at(3), now)).toBe('fresh'); // < 12 h
    expect(classifyStaleness(at(11.9), now)).toBe('fresh');
    expect(classifyStaleness(at(12.1), now)).toBe('stale'); // 12–24 h band
    expect(classifyStaleness(at(23.9), now)).toBe('stale');
    expect(classifyStaleness(at(24.1), now)).toBe('expired'); // ≥ 24 h
  });

  it('treats absent or unparseable timestamps as expired', () => {
    expect(classifyStaleness(undefined, now)).toBe('expired');
    expect(classifyStaleness('', now)).toBe('expired');
    expect(classifyStaleness('not-a-date', now)).toBe('expired');
  });
});

// --- sanity bound ------------------------------------------------------------------

describe('withinSanityBound', () => {
  const mid = 105;
  it('accepts honest spreads and rejects unit bugs', () => {
    expect(withinSanityBound(103, mid)).toBe(true); // ~2% below mid
    expect(withinSanityBound(105, mid)).toBe(true);
    expect(withinSanityBound(106, mid)).toBe(true); // just past mid, inside ×1.02
    expect(withinSanityBound(107.2, mid)).toBe(false); // > mid × 1.02
    expect(withinSanityBound(89, mid)).toBe(false); // < mid × 0.85
    expect(withinSanityBound(1050, mid)).toBe(false); // decimal-shift bug
    expect(withinSanityBound(0.105, mid)).toBe(false); // quoting-unit bug
  });
});

// --- resolver ----------------------------------------------------------------------

describe('resolveObservedRates', () => {
  it('warm KV hit: uses the cached set and makes ZERO fetches', async () => {
    const cached = setId({ IDR: 103.2 });
    const { kv } = mockKV({ 'observed:sbi-remit:v1': cached });
    const adapter = adapterReturning(setId({ IDR: 999 }));

    const { byProvider, fetchErrors } = await resolveObservedRates(['sbi-remit'], kv, {
      adapters: { 'sbi-remit': adapter },
    });

    expect(adapter.fetchRates).not.toHaveBeenCalled();
    expect(byProvider['sbi-remit']).toEqual(cached);
    expect(fetchErrors).toEqual({});
  });

  it('cold miss: fetches the adapter, puts with 12 h TTL, returns the fetched set directly', async () => {
    const { kv, puts } = mockKV();
    const fresh = setId({ IDR: 103.2 });
    const adapter = adapterReturning(fresh);

    const { byProvider, fetchErrors } = await resolveObservedRates(['sbi-remit'], kv, {
      adapters: { 'sbi-remit': adapter },
    });

    expect(adapter.fetchRates).toHaveBeenCalledTimes(1);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe('observed:sbi-remit:v1');
    expect(puts[0].opts).toEqual({ expirationTtl: OBSERVED_TTL_SECONDS }); // 43 200
    expect(OBSERVED_TTL_SECONDS).toBe(43_200);
    expect(JSON.parse(puts[0].value)).toEqual(fresh);
    // Fetched value returned to the requester directly (no same-request KV re-read).
    expect(byProvider['sbi-remit']).toEqual(fresh);
    expect(fetchErrors).toEqual({});
  });

  it('partial failure: one rejecting adapter → others observed, it is absent + reported', async () => {
    const { kv } = mockKV();
    const ok = adapterReturning(setId({ IDR: 103.2 }));
    const bad = adapterRejecting('connection reset');

    const { byProvider, fetchErrors } = await resolveObservedRates(
      ['sbi-remit', 'jrf'],
      kv,
      { adapters: { 'sbi-remit': ok, jrf: bad } },
    );

    expect(byProvider['sbi-remit']).toBeDefined();
    expect(byProvider.jrf).toBeUndefined();
    expect(fetchErrors.jrf).toBe('connection reset');
  });

  it('slow adapter: truncated by the overall budget, reported, resolver still resolves', async () => {
    const { kv } = mockKV();
    const slow: RateAdapter = {
      fetchRates: vi.fn(
        () => new Promise<ObservedRateSet>(() => { /* never settles */ }),
      ),
    };
    const started = Date.now();
    const { byProvider, fetchErrors } = await resolveObservedRates(['sbi-remit'], kv, {
      adapters: { 'sbi-remit': slow },
      overallBudgetMs: 40,
      perAdapterTimeoutMs: 30,
    });

    expect(Date.now() - started).toBeLessThan(2_000); // did not hang
    expect(byProvider['sbi-remit']).toBeUndefined();
    expect(fetchErrors['sbi-remit']).toMatch(/abandoned|budget/i);
  });

  it('never rejects: KV get throwing, KV put throwing, sync adapter crash', async () => {
    const brokenKV = {
      get: async () => {
        throw new Error('KV down');
      },
      put: async () => {
        throw new Error('KV write denied');
      },
    } as unknown as KVNamespace;

    const crashy: RateAdapter = {
      fetchRates: (() => {
        throw new Error('sync boom');
      }) as unknown as RateAdapter['fetchRates'],
    };

    await expect(
      resolveObservedRates(['sbi-remit'], brokenKV, { adapters: { 'sbi-remit': crashy } }),
    ).resolves.toMatchObject({ fetchErrors: { 'sbi-remit': 'sync boom' } });

    // KV put fails but the fetched set is still returned.
    const { byProvider } = await resolveObservedRates(['sbi-remit'], brokenKV, {
      adapters: { 'sbi-remit': adapterReturning(setId({ IDR: 103.2 })) },
    });
    expect(byProvider['sbi-remit']).toBeDefined();
  });

  it('providers without adapters resolve undefined (modeled fallback), no error', async () => {
    const { kv } = mockKV();
    const { byProvider, fetchErrors } = await resolveObservedRates(['brastel'], kv, {});
    expect(byProvider).toEqual({});
    expect(fetchErrors).toEqual({});
  });

  // --- manual rung (task 21) -------------------------------------------------

  it('manual entry fills a provider with no observed set (kyodai ladder)', async () => {
    // Pin the wall clock to the capture window: MANUAL_RATES entries expire
    // 24 h after their fetchedAt, so real-date runs of this suite would rot.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00+09:00'));
    try {
    const { kv, puts } = mockKV();
    const { byProvider, fetchErrors } = await resolveObservedRates(['kyodai'], kv, {
      midMarketRates: { IDR: 111.37 },
    });
    // withinSanityBound(111.1 vs 111.37) → passes; never KV-cached.
    expect(byProvider.kyodai).toMatchObject({
      providerId: 'kyodai',
      method: 'manual',
      rates: { IDR: 111.1 },
    });
    expect(puts).toHaveLength(0);
    expect(fetchErrors).toEqual({});
    } finally {
      vi.useRealTimers();
    }
    });

  it('observed beats manual when an adapter/KV entry exists for the same provider', async () => {
    const { kv } = mockKV();
    const live = {
      providerId: 'kyodai',
      rates: { IDR: 103.2 },
      fetchedAt: '2026-08-23T09:00:00Z',
      source: 'live-adapter',
      method: 'live' as const,
    };
    const { byProvider } = await resolveObservedRates(['kyodai'], kv, {
      adapters: { kyodai: adapterReturning(live) },
    });
    expect(byProvider.kyodai).toEqual(live); // observed, not the manual entry
  });

  it('a manual rate outside the sanity band is dropped (typo guard)', async () => {
    // Mid 111.37 × 10 (a decimal-shift typo) → far above ×1.02 → dropped.
    const { kv } = mockKV();
    const { byProvider } = await resolveObservedRates(['kyodai'], kv, {
      midMarketRates: { IDR: 11.137 }, // makes 111.1 read as ×10 of mid
    });
    expect(byProvider.kyodai).toBeUndefined();
  });

  it('expired manual entries fall through to modeled; fresh manual survives', async () => {
    // The checked-in entry ages in real time — pin the clock with vi.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
    try {
      const fresh = await resolveObservedRates(['kyodai'], mockKV().kv, {});
      expect(fresh.byProvider.kyodai?.method).toBe('manual'); // captured < 24 h ago

      vi.setSystemTime(new Date('2026-08-25T12:00:00Z')); // +2 days
      const expired = await resolveObservedRates(['kyodai'], mockKV().kv, {});
      expect(expired.byProvider.kyodai).toBeUndefined(); // → modeled downstream
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanity bound: out-of-band corridors dropped; fully-rejected set is an error', async () => {
    // IDR far below mid×0.85 (mid 105) → dropped; PHP has no mid → kept.
    const mixed = adapterReturning(setId({ IDR: 10, PHP: 0.39 }));
    const r1 = await resolveObservedRates(['sbi-remit'], mockKV().kv, {
      adapters: { 'sbi-remit': mixed },
      midMarketRates: { IDR: 105 },
    });
    expect(r1.byProvider['sbi-remit']?.rates).toEqual({ PHP: 0.39 });

    // Fresh KV: an all-out-of-band set rejects at provider level, no cache.
    const { kv, puts } = mockKV();
    const allBad = adapterReturning(setId({ IDR: 10 }));
    const r2 = await resolveObservedRates(['sbi-remit'], kv, {
      adapters: { 'sbi-remit': allBad },
      midMarketRates: { IDR: 105 },
    });
    expect(r2.byProvider['sbi-remit']).toBeUndefined();
    expect(r2.fetchErrors['sbi-remit']).toMatch(/sanity/);
    expect(puts.filter((p) => !p.key.includes(':status:'))).toHaveLength(0);
  });

  it('absolute corridor band applies even with NO mid-market table (unit-bug guard)', async () => {
    // No midMarketRates: the relative bound cannot run, but the absolute
    // IDR band [80, 150] still rejects a decimal-shift bug (task 22).
    const { kv } = mockKV();
    const shifted = adapterReturning(setId({ IDR: 1111 }));
    const r = await resolveObservedRates(['sbi-remit'], kv, {
      adapters: { 'sbi-remit': shifted },
    });
    expect(r.byProvider['sbi-remit']).toBeUndefined();
    expect(r.fetchErrors['sbi-remit']).toMatch(/sanity/);
  });

  // --- retry-once on transient failure (task 22) ----------------------------

  it('retries a transient failure exactly once, then succeeds', async () => {
    const { kv } = mockKV();
    let calls = 0;
    const flaky: RateAdapter = {
      fetchRates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return setId({ IDR: 103.2 });
      }),
    };
    const r = await resolveObservedRates(['sbi-remit'], kv, {
      adapters: { 'sbi-remit': flaky },
      midMarketRates: { IDR: 105 },
    });
    expect(flaky.fetchRates).toHaveBeenCalledTimes(2);
    expect(r.byProvider['sbi-remit']?.rates.IDR).toBeCloseTo(103.2, 6);
    expect(r.fetchErrors).toEqual({});
  });

  it('does NOT retry deterministic parse failures', async () => {
    const { kv } = mockKV();
    const parseFail: RateAdapter = {
      fetchRates: vi.fn(async () => {
        throw new Error('SBI Remit: no currencies parsed from rate board');
      }),
    };
    await resolveObservedRates(['sbi-remit'], kv, { adapters: { 'sbi-remit': parseFail } });
    expect(parseFail.fetchRates).toHaveBeenCalledTimes(1);
  });

  it('caps retries per request (subrequest budget guard)', async () => {
    const { kv } = mockKV();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `net-fail-${n}`);
    const adapters: Record<string, RateAdapter> = {};
    for (const id of ids) {
      adapters[id] = {
        fetchRates: vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      };
    }
    await resolveObservedRates(ids, kv, { adapters, overallBudgetMs: 6_000 });
    const totalCalls = Object.values(adapters).reduce(
      (sum, a) => sum + (a.fetchRates as ReturnType<typeof vi.fn>).mock.calls.length,
      0,
    );
    // 7 first attempts + at most MAX_RETRIES_PER_REQUEST retries.
    expect(totalCalls).toBeLessThanOrEqual(ids.length + 5);
  });

  // --- per-source status (task 22) ------------------------------------------

  it('records lastSuccessAt on live success and surfaces it on warm requests', async () => {
    const { kv } = mockKV();
    const fresh = setId({ IDR: 103.2 });
    const r1 = await resolveObservedRates(['sbi-remit'], kv, {
      adapters: { 'sbi-remit': adapterReturning(fresh) },
    });
    expect(r1.sourceStatus['sbi-remit']?.lastSuccessAt).toBe(fresh.fetchedAt);

    // Warm: KV hit carries the same lastSuccessAt forward.
    const r2 = await resolveObservedRates(['sbi-remit'], kv, {
      adapters: { 'sbi-remit': adapterReturning(fresh) },
    });
    expect(r2.sourceStatus['sbi-remit']?.lastSuccessAt).toBe(fresh.fetchedAt);
  });

  it('persists lastFailureAt to a 7-day status key and reads it back next request', async () => {
    const { kv, puts } = mockKV();
    const failing = adapterRejecting('connection reset by peer');
    const adapters = { 'sbi-remit': failing };
    const r1 = await resolveObservedRates(['sbi-remit'], kv, { adapters });
    expect(r1.sourceStatus['sbi-remit']?.lastFailureAt).toBeTruthy();
    expect(r1.sourceStatus['sbi-remit']?.lastError).toBe('connection reset by peer');

    const statusPut = puts.find((p) => p.key === 'observed:sbi-remit:status:v1');
    expect(statusPut?.opts).toEqual({ expirationTtl: 604_800 });

    // Next request (still failing, fresh KV): status key present from before.
    const r2 = await resolveObservedRates(['sbi-remit'], kv, { adapters });
    expect(r2.sourceStatus['sbi-remit']?.lastError).toBe('connection reset by peer');
  });
});

// --- simulate() integration: SBI observed warm/cold/fail -----------------------------

/** Drive the REAL SBI adapter through fixture bodies (see sbi-remit tests). */
function sbiFixtureFetch(): typeof fetch {
  const dir = new URL('../sources/fixtures/sbi-remit/', import.meta.url);
  return (async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body ?? '');
    const ccy = /currency=([A-Z]{3})/.exec(body)?.[1];
    const text = ccy ? readFileSync(new URL(`${ccy}.json`, dir), 'utf-8') : '{}';
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const RATES: RateTable = {
  base: 'JPY',
  rates: { IDR: 111.37, PHP: 0.38872, VND: 164.37, NPR: 0.96465, CNY: 0.042399, THB: 0.20586 },
  fetchedAt: '2026-08-23T09:00:00Z',
  source: 'test',
};

describe('simulate integration with resolver (SBI observed rate)', () => {
  const input = { amountJPY: 100_000, targetCurrency: 'IDR' as const, deliveryType: 'all' as const };

  async function runResolved(kv: KVNamespace) {
    const { byProvider, fetchErrors } = await resolveObservedRates(
      ['sbi-remit', 'wise', 'kyodai'],
      kv,
      { midMarketRates: RATES.rates },
    );
    const payload = simulate(input, RATES, byProvider);
    if (Object.keys(fetchErrors).length) payload.meta.fetchErrors = fetchErrors;
    return payload;
  }

  it('COLD: SBI fetch succeeds → rateSource.kind "observed" with live timestamp', async () => {
    // Pin the wall clock: the Kyodai manual entry (fetchedAt 2026-08-23 JST)
    // must still be inside its 24 h freshness window for the manual rung.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00+09:00'));
    const { kv } = mockKV();
    const original = globalThis.fetch;
    globalThis.fetch = sbiFixtureFetch(); // adapter's wrapped fetch reads fixtures
    try {
      const payload = await runResolved(kv);
      const sbi = payload.results.find((r) => r.providerId === 'sbi-remit')!;
      expect(sbi.rateSource.kind).toBe('observed');
      expect(sbi.rateSource.fetchedAt).toBeTruthy();
      expect(sbi.rateSource.sourceLabel).toContain('remit.co.jp');
      // Fixture IDR rate 111.11 vs mid 111.37 → observed markup ≈ 0.23%.
      expect(sbi.appliedRate).toBeCloseTo(111.11, 6);
      expect(sbi.markupPct).toBeCloseTo((111.37 - 111.11) / 111.37, 6);
      // Others stay modeled; Kyodai rides the manual rung; coverage agrees.
      const kyodai = payload.results.find((r) => r.providerId === 'kyodai')!;
      expect(kyodai.rateSource.kind).toBe('manual');
      expect(kyodai.rateSource.sourceLabel).toContain('kyodai.co.jp');
      expect(kyodai.rateSource.fetchedAt).toBeTruthy();
      expect(payload.meta.observedCoverage.observed).toBe(1);
      expect(payload.meta.observedCoverage.manual).toBe(1);
      expect(payload.meta.observedCoverage.modeled).toBe(payload.results.length - 2);
    } finally {
      globalThis.fetch = original;
      vi.useRealTimers();
    }
  });

  it('WARM: second resolve makes no fetch and still renders observed', async () => {
    const { kv } = mockKV();
    const original = globalThis.fetch;
    globalThis.fetch = sbiFixtureFetch();
    try {
      await runResolved(kv); // cold: fills KV from fixtures
      const payload = await runResolved(kv); // warm: pure KV
      const sbi = payload.results.find((r) => r.providerId === 'sbi-remit')!;
      expect(sbi.rateSource.kind).toBe('observed');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('FAILURE: SBI unreachable → modeled row + meta.fetchErrors entry, page still works', async () => {
    const { kv } = mockKV();
    // Block all outbound fetch: the adapter's per-call fetch throws immediately.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network unreachable');
    }) as typeof fetch;
    try {
      const payload = await runResolved(kv);
      const sbi = payload.results.find((r) => r.providerId === 'sbi-remit')!;
      expect(sbi.rateSource.kind).toBe('modeled');
      expect(payload.meta.fetchErrors?.['sbi-remit']).toBeTruthy();
      expect(payload.meta.observedCoverage.observed).toBe(0);
      expect(payload.results.length).toBeGreaterThan(0); // page still renders
    } finally {
      globalThis.fetch = original;
    }
  });
});
