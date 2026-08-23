import type { Currency, CurrencyCode } from '../types/remittance';

/**
 * Destination currency catalogue.
 *
 * To add a new corridor:
 *   1. Add the ISO code to `CurrencyCode` in src/types/remittance.ts.
 *   2. Add an entry here (flag emoji + display metadata).
 *   3. Add a fallback mid-market rate in FALLBACK_RATES (src/lib/rates.ts).
 *   4. Make sure at least one provider lists it in `supportedCurrencies`.
 */
export const CURRENCIES: readonly Currency[] = [
  { code: 'IDR', name: 'Indonesian Rupiah', country: 'Indonesia',   flag: '🇮🇩', symbol: 'Rp', decimals: 0 },
  { code: 'PHP', name: 'Philippine Peso',   country: 'Philippines', flag: '🇵🇭', symbol: '₱',  decimals: 2 },
  { code: 'VND', name: 'Vietnamese Dong',   country: 'Vietnam',     flag: '🇻🇳', symbol: '₫',  decimals: 0 },
  { code: 'INR', name: 'Indian Rupee',      country: 'India',       flag: '🇮🇳', symbol: '₹',  decimals: 2 },
  { code: 'NPR', name: 'Nepalese Rupee',    country: 'Nepal',       flag: '🇳🇵', symbol: 'रू', decimals: 2 },
  { code: 'BDT', name: 'Bangladeshi Taka',  country: 'Bangladesh',  flag: '🇧🇩', symbol: '৳',  decimals: 2 },
  { code: 'CNY', name: 'Chinese Yuan',      country: 'China',       flag: '🇨🇳', symbol: '¥',  decimals: 2 },
  { code: 'THB', name: 'Thai Baht',         country: 'Thailand',    flag: '🇹🇭', symbol: '฿',  decimals: 2 },
  { code: 'KRW', name: 'South Korean Won',  country: 'South Korea', flag: '🇰🇷', symbol: '₩',  decimals: 0 },
  { code: 'USD', name: 'US Dollar',         country: 'United States', flag: '🇺🇸', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro',              country: 'Eurozone',    flag: '🇪🇺', symbol: '€',  decimals: 2 },
];

export const CURRENCY_CODES: readonly CurrencyCode[] = CURRENCIES.map((c) => c.code);

const CURRENCY_BY_CODE: Record<string, Currency> = Object.fromEntries(
  CURRENCIES.map((c) => [c.code, c]),
);

export function getCurrency(code: CurrencyCode): Currency {
  const currency = CURRENCY_BY_CODE[code];
  if (!currency) throw new Error(`Unknown currency code: ${code}`);
  return currency;
}

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return code in CURRENCY_BY_CODE;
}
