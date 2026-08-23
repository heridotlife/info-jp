import type {
  FeeModel,
  Provider,
  RateMarkup,
  ResultTag,
  SimulationInput,
  SimulationResponse,
  SimulationResult,
  CurrencyCode,
} from '../types/remittance';
import { PROVIDERS } from './providers';
import { getCurrency } from './currencies';
import type { RateTable } from './rates';

/**
 * ============================================================================
 *  SIMULATION ENGINE
 * ============================================================================
 *  Pure, dependency-free calculation. Given a `SimulationInput` and a
 *  `RateTable` (mid-market rates), it returns one `SimulationResult` per
 *  eligible provider plus meta. No I/O here — fetch rates upstream and pass
 *  them in, which keeps this trivially unit-testable.
 *
 *  MONEY MODEL (per provider)
 *  --------------------------
 *    feeJPY            = upfront transfer fee for this amount
 *    appliedRate       = midMarketRate × (1 − markup)
 *    amountConverted   = max(amountJPY − feeJPY, 0)
 *    receiveAmount     = amountConverted × appliedRate
 *    markupCostJPY     = amountConverted × markup   (value lost to FX spread)
 *    netCostJPY        = feeJPY + markupCostJPY     (total real cost)
 *
 *  "Best value" is ranked by the largest `receiveAmount` — the number that
 *  actually lands in the recipient's account — which is equivalent to the
 *  lowest `netCostJPY` for a fixed send amount and currency.
 * ============================================================================
 */

/** Round to whole yen — providers quote fees in integer JPY. */
function roundYen(value: number): number {
  return Math.round(value);
}

/**
 * Is the given instant a weekend in Japan (JST, UTC+9)?
 * Used for Revolut-style weekend FX surcharges.
 */
export function isJapanWeekend(date: Date): boolean {
  // Shift to JST then read the day-of-week in UTC terms.
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDay(); // 0 = Sun … 6 = Sat
  return day === 0 || day === 6;
}

/** Resolve the effective markup fraction for a provider + currency + timing. */
function resolveMarkup(markup: RateMarkup, currency: CurrencyCode, isWeekend: boolean): number {
  const base = markup.byCurrency?.[currency] ?? markup.default;
  const weekend = isWeekend ? markup.weekendSurcharge ?? 0 : 0;
  return base + weekend;
}

/** Evaluate an upfront fee (JPY) for a given send amount. */
export function computeUpfrontFee(fee: FeeModel, amountJPY: number): number {
  switch (fee.kind) {
    case 'flat':
      return fee.feeJPY;

    case 'percentage': {
      const raw = amountJPY * fee.percent + (fee.fixedJPY ?? 0);
      return Math.max(raw, fee.minFeeJPY ?? 0);
    }

    case 'tiered': {
      for (const tier of fee.tiers) {
        if (tier.upToJPY === null || amountJPY <= tier.upToJPY) {
          return tier.feeJPY;
        }
      }
      // Amount exceeded every bounded tier and no open-ended tier was defined.
      return fee.tiers[fee.tiers.length - 1]?.feeJPY ?? 0;
    }
  }
}

function computeForProvider(
  provider: Provider,
  amountJPY: number,
  currency: CurrencyCode,
  midMarketRate: number,
  isWeekend: boolean,
): SimulationResult {
  const markupPct = resolveMarkup(provider.rateMarkup, currency, isWeekend);
  const feeJPY = roundYen(computeUpfrontFee(provider.fee, amountJPY));

  const appliedRate = midMarketRate * (1 - markupPct);
  const amountConvertedJPY = Math.max(amountJPY - feeJPY, 0);
  const receiveAmount = amountConvertedJPY * appliedRate;
  const markupCostJPY = amountConvertedJPY * markupPct;
  const netCostJPY = feeJPY + markupCostJPY;

  return {
    providerId: provider.id,
    providerName: provider.name,
    logoText: provider.logoText,
    brandColor: provider.brandColor,
    website: provider.website,
    note: provider.note,

    feeJPY,
    midMarketRate,
    appliedRate,
    markupPct,
    markupCostJPY: roundYen(markupCostJPY),
    amountConvertedJPY,
    receiveAmount,
    netCostJPY: roundYen(netCostJPY),
    netCostPct: amountJPY > 0 ? netCostJPY / amountJPY : 0,

    deliveryTypes: provider.deliveryTypes,
    speedLabel: provider.speed.label,
    speedRankMinutes: provider.speed.rankMinutes,

    tags: [], // filled in by `assignTags`
  };
}

/** Tag the winning cards (best value / fastest / lowest upfront fee). */
function assignTags(results: SimulationResult[]): void {
  if (results.length === 0) return;

  const bestValue = results.reduce((a, b) => (b.receiveAmount > a.receiveAmount ? b : a));
  const fastest = results.reduce((a, b) => (b.speedRankMinutes < a.speedRankMinutes ? b : a));
  const lowestFee = results.reduce((a, b) => (b.feeJPY < a.feeJPY ? b : a));

  const add = (result: SimulationResult, tag: ResultTag) => {
    if (!result.tags.includes(tag)) result.tags.push(tag);
  };

  add(bestValue, 'best-value');
  add(fastest, 'fastest');
  add(lowestFee, 'lowest-fee');
}

/**
 * Run the full simulation across every eligible provider.
 *
 * @param input  amount, currency, delivery filter, and optional timestamp
 * @param rates  mid-market rate table (fetch via src/lib/rates.ts)
 */
export function simulate(input: SimulationInput, rates: RateTable): SimulationResponse {
  const { amountJPY, targetCurrency, deliveryType } = input;
  const at = input.at ? new Date(input.at) : new Date();
  const weekend = isJapanWeekend(at);

  const midMarketRate = rates.rates[targetCurrency];
  const currency = getCurrency(targetCurrency);

  // If we somehow lack a rate for this corridor, return empty results with meta
  // rather than throwing — the UI can show a friendly "unavailable" state.
  if (midMarketRate === undefined || midMarketRate <= 0) {
    return {
      meta: {
        amountJPY,
        targetCurrency,
        deliveryType,
        midMarketRate: 0,
        ratesFetchedAt: rates.fetchedAt,
        ratesSource: rates.source,
        isJapanWeekend: weekend,
        currency,
      },
      results: [],
    };
  }

  const results = PROVIDERS.filter((p) => p.supportedCurrencies.includes(targetCurrency))
    .filter((p) => deliveryType === 'all' || p.deliveryTypes.includes(deliveryType))
    .map((p) => computeForProvider(p, amountJPY, targetCurrency, midMarketRate, weekend))
    // Best value (largest payout) first.
    .sort((a, b) => b.receiveAmount - a.receiveAmount);

  assignTags(results);

  return {
    meta: {
      amountJPY,
      targetCurrency,
      deliveryType,
      midMarketRate,
      ratesFetchedAt: rates.fetchedAt,
      ratesSource: rates.source,
      isJapanWeekend: weekend,
      currency,
    },
    results,
  };
}
