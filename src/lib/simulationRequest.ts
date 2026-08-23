import type { CurrencyCode, DeliveryFilter, SimulationInput } from '../types/remittance';
import { isSupportedCurrency } from './currencies';

/** Guard rails for the send amount (JPY). */
export const MIN_AMOUNT_JPY = 1_000;
export const MAX_AMOUNT_JPY = 10_000_000;
export const DEFAULT_AMOUNT_JPY = 100_000;
export const DEFAULT_CURRENCY: CurrencyCode = 'IDR';

const DELIVERY_VALUES: readonly DeliveryFilter[] = ['all', 'bank', 'cash', 'wallet'];

function clampAmount(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return DEFAULT_AMOUNT_JPY;
  return Math.min(Math.max(Math.round(n), MIN_AMOUNT_JPY), MAX_AMOUNT_JPY);
}

function parseCurrency(raw: unknown): CurrencyCode {
  if (typeof raw === 'string') {
    const code = raw.toUpperCase();
    if (isSupportedCurrency(code)) return code;
  }
  return DEFAULT_CURRENCY;
}

function parseDelivery(raw: unknown): DeliveryFilter {
  if (typeof raw === 'string' && (DELIVERY_VALUES as string[]).includes(raw)) {
    return raw as DeliveryFilter;
  }
  return 'all';
}

/**
 * Normalize an untrusted request payload (query params or JSON body) into a
 * safe `SimulationInput`. Invalid values fall back to sensible defaults so the
 * endpoint never 400s on a slightly-off request.
 */
export function parseSimulationInput(source: Record<string, unknown>): SimulationInput {
  return {
    amountJPY: clampAmount(source.amountJPY ?? source.amount),
    targetCurrency: parseCurrency(source.targetCurrency ?? source.currency),
    deliveryType: parseDelivery(source.deliveryType ?? source.delivery),
  };
}

/** Build a `SimulationInput` from URL search params. */
export function inputFromSearchParams(params: URLSearchParams): SimulationInput {
  return parseSimulationInput({
    amountJPY: params.get('amountJPY') ?? params.get('amount') ?? undefined,
    targetCurrency: params.get('targetCurrency') ?? params.get('currency') ?? undefined,
    deliveryType: params.get('deliveryType') ?? params.get('delivery') ?? undefined,
  });
}
