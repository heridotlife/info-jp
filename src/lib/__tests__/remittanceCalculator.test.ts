import { describe, expect, it } from 'vitest';
import { computeUpfrontFee, isJapanWeekend, simulate } from '../remittanceCalculator';
import { PROVIDERS } from '../providers';
import type { ObservedRateSet } from '../../types/remittance';
import type { RateTable } from '../rates';

/**
 * Unit tests for the observed-rate calculator support (tasks.md task 2):
 * observed / manual / modeled paths, weekend surcharge on the modeled path
 * only, ranking flips when observed ≠ modeled, and the promo-tag policy.
 */

// Deterministic mid-market table. Only the corridors the tests touch.
const RATES: RateTable = {
  base: 'JPY',
  rates: { IDR: 105, PHP: 0.38 },
  fetchedAt: '2026-08-20T00:00:00Z',
  source: 'test',
};

// 2026-08-20 is a Thursday, 2026-08-22 a Saturday — in JST as well as UTC.
const THURSDAY = '2026-08-20T10:00:00Z';
const SATURDAY = '2026-08-22T10:00:00Z';

const AMOUNT = 100_000;

function runIDR(observed?: Record<string, ObservedRateSet>, at = THURSDAY) {
  return simulate(
    { amountJPY: AMOUNT, targetCurrency: 'IDR', deliveryType: 'all', at },
    RATES,
    observed,
  );
}

function runPHP(observed?: Record<string, ObservedRateSet>, at = THURSDAY) {
  return simulate(
    { amountJPY: AMOUNT, targetCurrency: 'PHP', deliveryType: 'all', at },
    RATES,
    observed,
  );
}

const byId = (results: ReturnType<typeof runIDR>['results'], id: string) =>
  results.find((r) => r.providerId === id)!;

function observedSet(overrides: Partial<ObservedRateSet>): ObservedRateSet {
  return {
    providerId: 'sbi-remit',
    rates: { IDR: 103.5 },
    fetchedAt: '2026-08-20T09:00:00Z',
    source: 'unit-test adapter',
    method: 'live',
    ...overrides,
  };
}

// --- weekend helper sanity ---------------------------------------------------

describe('isJapanWeekend', () => {
  it('classifies the fixed test dates', () => {
    expect(isJapanWeekend(new Date(SATURDAY))).toBe(true);
    expect(isJapanWeekend(new Date(THURSDAY))).toBe(false);
  });
});

// --- modeled path (unchanged default) ----------------------------------------

describe('calculator: modeled path', () => {
  it('applies mid × (1 − markup) and labels the row modeled', () => {
    const { results } = runIDR();
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(r.rateSource.kind).toBe('modeled');
      expect(r.rateSource.sourceLabel).toBeTruthy();
      expect(r.rateSource.isPromo).toBeUndefined();
    }

    const sbi = byId(results, 'sbi-remit');
    // SBI modeled IDR markup is 1.6% → appliedRate = 105 × 0.984 = 103.32
    expect(sbi.appliedRate).toBeCloseTo(105 * (1 - 0.016), 10);
    expect(sbi.markupPct).toBeCloseTo(0.016, 10);
  });

  it('carries a provider-specific modeled-basis label (Revolut published terms)', () => {
    // Revolut is Cloudflare-walled — never observed; its modeled row must
    // disclose the basis instead of the generic label (task 21).
    const rv = byId(runPHP(undefined, THURSDAY).results, 'revolut-jp');
    expect(rv.rateSource.kind).toBe('modeled');
    expect(rv.rateSource.sourceLabel).toBe(
      'per published terms (weekday interbank + 1 % weekend)',
    );
    // Everyone else keeps the generic honest label.
    const sbi = byId(runIDR().results, 'sbi-remit');
    expect(sbi.rateSource.sourceLabel).toBe('estimated from modeled markup');
  });
});

// --- observed path ------------------------------------------------------------

describe('calculator: observed path', () => {
  it('uses the observed rate verbatim and derives the markup vs mid', () => {
    const { results } = runIDR({
      'sbi-remit': observedSet({ rates: { IDR: 103.5 } }),
    });

    const sbi = byId(results, 'sbi-remit');
    expect(sbi.appliedRate).toBe(103.5);
    expect(sbi.markupPct).toBeCloseTo((105 - 103.5) / 105, 10);
    expect(sbi.rateSource).toEqual({
      kind: 'observed',
      fetchedAt: '2026-08-20T09:00:00Z',
      sourceLabel: 'unit-test adapter',
    });

    // Everyone else keeps the modeled behavior.
    const wise = byId(results, 'wise');
    expect(wise.rateSource.kind).toBe('modeled');
    expect(wise.appliedRate).toBe(105); // 0 markup
  });

  it('carries isPromo and quoteAmountJPY onto the row', () => {
    const { results } = runIDR({
      'sbi-remit': observedSet({ rates: { IDR: 107 }, isPromo: true, quoteAmountJPY: 10_000 }),
    });
    const sbi = byId(results, 'sbi-remit');
    expect(sbi.rateSource.isPromo).toBe(true);
    expect(sbi.rateSource.quoteAmountJPY).toBe(10_000);
  });

  it('labels method:"manual" sets as kind:"manual" but still applies the rate', () => {
    const { results } = runIDR({
      'sbi-remit': observedSet({ rates: { IDR: 100 }, method: 'manual', source: 'manual-rates.json' }),
    });
    const sbi = byId(results, 'sbi-remit');
    expect(sbi.rateSource.kind).toBe('manual');
    expect(sbi.rateSource.sourceLabel).toBe('manual-rates.json');
    expect(sbi.appliedRate).toBe(100);
  });

  it('falls back to modeled when the set lacks this corridor', () => {
    const { results } = runIDR({
      'sbi-remit': observedSet({ rates: { PHP: 0.37 } }), // IDR corridor requested
    });
    const sbi = byId(results, 'sbi-remit');
    expect(sbi.rateSource.kind).toBe('modeled');
    expect(sbi.appliedRate).toBeCloseTo(105 * (1 - 0.016), 10);
  });

  it('ignores rateMarkup entirely on the observed path (Revolut weekend)', () => {
    // Revolut's modeled path adds +1% on weekends. With an observed rate the
    // quoted rate is the quoted rate — weekend makes no difference.
    const set: Record<string, ObservedRateSet> = {
      'revolut-jp': {
        providerId: 'revolut-jp',
        rates: { PHP: 0.375 },
        fetchedAt: '2026-08-20T09:00:00Z',
        source: 'unit-test',
        method: 'live',
      },
    };
    const weekday = byId(runPHP(set, THURSDAY).results, 'revolut-jp');
    const weekend = byId(runPHP(set, SATURDAY).results, 'revolut-jp');
    expect(weekday.appliedRate).toBe(0.375);
    expect(weekend.appliedRate).toBe(0.375);
    expect(weekend.markupPct).toBeCloseTo((0.38 - 0.375) / 0.38, 10);
  });
});

// --- weekend surcharge on the modeled path ------------------------------------

describe('calculator: weekend surcharge (modeled only)', () => {
  it('adds Revolut weekendSurcharge on Saturday but leaves others untouched', () => {
    const weekday = runPHP(undefined, THURSDAY).results;
    const weekend = runPHP(undefined, SATURDAY).results;

    const rvWeekday = byId(weekday, 'revolut-jp');
    const rvWeekend = byId(weekend, 'revolut-jp');
    expect(rvWeekday.markupPct).toBe(0);
    expect(rvWeekend.markupPct).toBeCloseTo(0.01, 10);
    expect(rvWeekend.receiveAmount).toBeLessThan(rvWeekday.receiveAmount);
    expect(rvWeekend.rateSource.kind).toBe('modeled');

    // A provider without weekendSurcharge is identical across days.
    const sbiWeekday = byId(weekday, 'sbi-remit');
    const sbiWeekend = byId(weekend, 'sbi-remit');
    expect(sbiWeekend.markupPct).toBeCloseTo(sbiWeekday.markupPct, 12);
    expect(sbiWeekend.receiveAmount).toBeCloseTo(sbiWeekday.receiveAmount, 6);
  });
});

// --- ranking behavior ----------------------------------------------------------

describe('calculator: ranking with observed rates', () => {
  it('flips the order when an observed rate beats the modeled estimate', () => {
    // Modeled: SBI (1.6% markup + fee) loses to Wise (0% markup).
    const modeled = runIDR().results;
    const sbiModeled = byId(modeled, 'sbi-remit');
    const wiseModeled = byId(modeled, 'wise');
    expect(sbiModeled.receiveAmount).toBeLessThan(wiseModeled.receiveAmount);

    // Observed SBI rate 5% ABOVE mid-market → SBI wins outright.
    const observed = runIDR({
      'sbi-remit': observedSet({ rates: { IDR: 105 * 1.05 } }),
    }).results;
    const sbiObserved = byId(observed, 'sbi-remit');
    const wiseObserved = byId(observed, 'wise');
    expect(sbiObserved.receiveAmount).toBeGreaterThan(wiseObserved.receiveAmount);
    expect(observed[0].providerId).toBe('sbi-remit');
    // Markup vs mid is negative (better than mid) — surfaced honestly.
    expect(sbiObserved.markupPct).toBeLessThan(0);
  });
});

// --- promo policy ----------------------------------------------------------------

describe('calculator: promo policy', () => {
  it('never awards best-value to a promo row, but keeps it in the ranking', () => {
    // JRF gets an absurdly good PROMO rate: it must top the table by payout…
    const { results } = runIDR({
      jrf: {
        providerId: 'jrf',
        rates: { IDR: 200 },
        fetchedAt: '2026-08-20T09:00:00Z',
        source: 'promo board',
        method: 'live',
        isPromo: true,
      },
    });

    const jrf = byId(results, 'jrf');
    expect(results[0].providerId).toBe('jrf'); // ranks first by payout…
    expect(jrf.rateSource.isPromo).toBe(true);
    expect(jrf.tags).not.toContain('best-value'); // …but never best-value.

    // The best-value tag lands on the best durably-attainable row instead.
    const tagged = results.filter((r) => r.tags.includes('best-value'));
    expect(tagged.length).toBe(1);
    const nonPromo = results.filter((r) => !r.rateSource.isPromo);
    const expectedBest = nonPromo.reduce((a, b) => (b.receiveAmount > a.receiveAmount ? b : a));
    expect(tagged[0].providerId).toBe(expectedBest.providerId);

    // Exactly one of each tag overall.
    expect(results.filter((r) => r.tags.includes('fastest')).length).toBe(1);
    expect(results.filter((r) => r.tags.includes('lowest-fee')).length).toBe(1);
  });

  it('lets a promo row keep non-rate-derived tags (fastest)', () => {
    // Seven Bank/WU is the fastest provider (30 min) — a promo rate must not
    // bar it from `fastest`, only from `best-value`.
    const { results } = runIDR({
      'seven-bank-wu': {
        providerId: 'seven-bank-wu',
        rates: { IDR: 190 },
        fetchedAt: '2026-08-20T09:00:00Z',
        source: 'promo board',
        method: 'live',
        isPromo: true,
      },
    });
    const wu = byId(results, 'seven-bank-wu');
    expect(results[0].providerId).toBe('seven-bank-wu');
    expect(wu.tags).toContain('fastest');
    expect(wu.tags).not.toContain('best-value');
  });

  it('still awards best-value normally when no promo rows exist', () => {
    const { results } = runIDR();
    const tagged = results.filter((r) => r.tags.includes('best-value'));
    expect(tagged.length).toBe(1);
    expect(tagged[0].providerId).toBe(results[0].providerId);
  });
});

// --- per-currency fee tiers (tasks.md task 8) -----------------------------------

describe('fee tiers: byCurrency overrides (verified IDR tables)', () => {
  const sbi = PROVIDERS.find((p) => p.id === 'sbi-remit')!;
  const sevenBank = PROVIDERS.find((p) => p.id === 'seven-bank-wu')!;
  const smiles = PROVIDERS.find((p) => p.id === 'smiles')!;
  const kyodai = PROVIDERS.find((p) => p.id === 'kyodai')!;

  it('byCurrency IDR tiers override the global tiers', () => {
    // Global SBI tiers would price ¥100,000 at ¥400; verified IDR says ¥1,480.
    expect(computeUpfrontFee(sbi.fee, 100_000, 'IDR')).toBe(1_480);
    // Non-IDR corridors keep the global tiers.
    expect(computeUpfrontFee(sbi.fee, 100_000, 'PHP')).toBe(400);
    expect(computeUpfrontFee(sbi.fee, 100_000, 'THB')).toBe(400);
  });

  it('falls back to global tiers when the corridor has no override', () => {
    expect(computeUpfrontFee(smiles.fee, 100_000, 'PHP')).toBe(600); // global
    expect(computeUpfrontFee(kyodai.fee, 100_000, 'VND')).toBe(700); // global
  });

  it('prices tier boundaries exactly (¥10,000 vs ¥10,001 …)', () => {
    // SBI IDR: <10k → 460, <50k → 880, <250k → 1480, ≤1M → 1980.
    expect(computeUpfrontFee(sbi.fee, 9_999, 'IDR')).toBe(460);
    expect(computeUpfrontFee(sbi.fee, 10_000, 'IDR')).toBe(460); // bound inclusive
    expect(computeUpfrontFee(sbi.fee, 10_001, 'IDR')).toBe(880);
    expect(computeUpfrontFee(sbi.fee, 50_001, 'IDR')).toBe(1_480);
    expect(computeUpfrontFee(sbi.fee, 1_000_000, 'IDR')).toBe(1_980);

    // Seven Bank/WU IDR 7-tier table.
    expect(computeUpfrontFee(sevenBank.fee, 10_000, 'IDR')).toBe(400);
    expect(computeUpfrontFee(sevenBank.fee, 30_000, 'IDR')).toBe(450);
    expect(computeUpfrontFee(sevenBank.fee, 30_001, 'IDR')).toBe(500);
    expect(computeUpfrontFee(sevenBank.fee, 100_000, 'IDR')).toBe(890);
    expect(computeUpfrontFee(sevenBank.fee, 250_001, 'IDR')).toBe(1_350);
    expect(computeUpfrontFee(sevenBank.fee, 500_001, 'IDR')).toBe(1_750);

    // Smiles + Kyodai IDR tables.
    expect(computeUpfrontFee(smiles.fee, 250_000, 'IDR')).toBe(1_000);
    expect(computeUpfrontFee(smiles.fee, 250_001, 'IDR')).toBe(1_450);
    expect(computeUpfrontFee(kyodai.fee, 10_001, 'IDR')).toBe(880);
    expect(computeUpfrontFee(kyodai.fee, 250_001, 'IDR')).toBe(1_980);
  });

  it('the simulation uses the corridor-specific tiers end-to-end', () => {
    const { results } = runIDR();
    const sbiRow = byId(results, 'sbi-remit');
    expect(sbiRow.feeJPY).toBe(1_480); // verified IDR tier at ¥100,000
    const phpRun = simulate(
      { amountJPY: 100_000, targetCurrency: 'PHP', deliveryType: 'all', at: THURSDAY },
      RATES,
    );
    const sbiPhp = phpRun.results.find((r) => r.providerId === 'sbi-remit')!;
    expect(sbiPhp.feeJPY).toBe(400); // global tier at ¥100,000
  });
});
