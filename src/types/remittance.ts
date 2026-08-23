/**
 * Domain types for the Japanese Remittance Simulator.
 *
 * The data model is intentionally *declarative*: a provider is a plain object
 * describing its fee matrix + rate markup, and the calculator (see
 * src/lib/remittanceCalculator.ts) interprets it. That means you can add a new
 * provider or tweak a fee schedule without touching any calculation code.
 */

/** Destination currencies the simulator supports. Extend freely. */
export type CurrencyCode =
  | 'IDR' // Indonesian Rupiah
  | 'PHP' // Philippine Peso
  | 'VND' // Vietnamese Dong
  | 'USD' // US Dollar
  | 'EUR' // Euro
  | 'INR' // Indian Rupee
  | 'CNY' // Chinese Yuan
  | 'NPR' // Nepalese Rupee
  | 'BDT' // Bangladeshi Taka
  | 'THB' // Thai Baht
  | 'KRW'; // South Korean Won

/** How the recipient collects the money. */
export type DeliveryType = 'bank' | 'cash' | 'wallet';

/** `'all'` is only used as a filter value from the UI, never stored on a provider. */
export type DeliveryFilter = DeliveryType | 'all';

export interface Currency {
  code: CurrencyCode;
  /** Display name, e.g. "Indonesian Rupiah". */
  name: string;
  /** Destination country/region label. */
  country: string;
  /** Emoji flag for compact UI. */
  flag: string;
  /** Currency symbol, e.g. "Rp". */
  symbol: string;
  /** Fractional digits to display for payout amounts (IDR/VND/KRW = 0). */
  decimals: number;
}

// ---------------------------------------------------------------------------
// Fee model
// ---------------------------------------------------------------------------

/**
 * One row of a tiered fee matrix.
 * Tiers are evaluated in order; the first tier whose `upToJPY` bound is >= the
 * send amount wins. Use `upToJPY: null` for the final, open-ended tier.
 *
 * Example — SBI Remit style:
 *   { upToJPY: 30_000,  feeJPY: 250 }   // ¥1     – ¥30,000  → ¥250
 *   { upToJPY: 100_000, feeJPY: 400 }   // ¥30,001 – ¥100,000 → ¥400
 *   { upToJPY: null,    feeJPY: 880 }   // ¥100,001+          → ¥880
 */
export interface FeeTier {
  /** Inclusive upper bound of the send amount (JPY). `null` = no upper bound. */
  upToJPY: number | null;
  /** Flat fee charged (JPY) when the send amount falls in this tier. */
  feeJPY: number;
}

/**
 * Discriminated union of the fee-charging strategies we model.
 * Add a new `kind` here + a matching branch in `computeUpfrontFee()`.
 */
export type FeeModel =
  /** Single flat fee regardless of amount (e.g. Revolut standard weekday). */
  | { kind: 'flat'; feeJPY: number }
  /** Tiered flat-fee matrix (most Japanese providers). */
  | { kind: 'tiered'; tiers: FeeTier[] }
  /**
   * Percentage-of-amount fee, optionally with a fixed component and/or a floor.
   * Wise-style: `percent` of the send amount + a small `fixedJPY`.
   */
  | { kind: 'percentage'; percent: number; fixedJPY?: number; minFeeJPY?: number };

// ---------------------------------------------------------------------------
// Exchange-rate markup
// ---------------------------------------------------------------------------

/**
 * The exchange-rate margin a provider adds on top of the mid-market rate,
 * expressed as a fraction (0.015 = 1.5% worse than mid-market).
 * `0` means the provider gives the true mid-market rate (e.g. Wise, Revolut
 * on weekdays).
 */
export interface RateMarkup {
  /** Applied when there is no per-currency override. */
  default: number;
  /** Optional per-currency overrides (some corridors are cheaper than others). */
  byCurrency?: Partial<Record<CurrencyCode, number>>;
  /**
   * Extra markup added only on weekends (Japan time). Revolut's Standard plan,
   * for example, applies a ~1% FX markup outside market hours.
   */
  weekendSurcharge?: number;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface DeliverySpeed {
  /** Human-readable label shown in the UI, e.g. "Seconds – 2 hrs". */
  label: string;
  /** Normalized to minutes so we can rank "fastest" objectively (use the max). */
  rankMinutes: number;
}

export interface Provider {
  id: string;
  name: string;
  /** Short monogram used by the placeholder logo chip (2–4 chars). */
  logoText: string;
  /** Brand accent color (hex) for the logo chip. */
  brandColor: string;
  website: string;
  supportedCurrencies: CurrencyCode[];
  deliveryTypes: DeliveryType[];
  speed: DeliverySpeed;
  rateMarkup: RateMarkup;
  fee: FeeModel;
  /** Optional footnote surfaced in the expandable card (points, promos, etc.). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Simulation I/O
// ---------------------------------------------------------------------------

export interface SimulationInput {
  amountJPY: number;
  targetCurrency: CurrencyCode;
  deliveryType: DeliveryFilter;
  /** ISO timestamp to evaluate weekend surcharges against. Defaults to now. */
  at?: string;
}

/** Tags surfaced as badges on the winning cards. */
export type ResultTag = 'best-value' | 'fastest' | 'lowest-fee';

export interface SimulationResult {
  providerId: string;
  providerName: string;
  logoText: string;
  brandColor: string;
  website: string;
  note?: string;

  /** Upfront transfer fee (JPY), rounded to whole yen. */
  feeJPY: number;
  /** Mid-market rate: 1 JPY → X foreign currency. */
  midMarketRate: number;
  /** Rate the provider actually applies: 1 JPY → X foreign currency. */
  appliedRate: number;
  /** Markup fraction actually applied (incl. any weekend surcharge). */
  markupPct: number;
  /** What the hidden FX margin costs, expressed back in JPY. */
  markupCostJPY: number;
  /** Amount converted after the upfront fee is taken (amountJPY − feeJPY). */
  amountConvertedJPY: number;
  /** Foreign-currency amount the recipient is guaranteed to receive. */
  receiveAmount: number;
  /** Net effective cost in JPY (upfront fee + markup cost). */
  netCostJPY: number;
  /** Net effective cost as a fraction of the send amount. */
  netCostPct: number;

  deliveryTypes: DeliveryType[];
  speedLabel: string;
  speedRankMinutes: number;

  tags: ResultTag[];
}

export interface SimulationMeta {
  amountJPY: number;
  targetCurrency: CurrencyCode;
  deliveryType: DeliveryFilter;
  midMarketRate: number;
  /** ISO timestamp the rate table was fetched. */
  ratesFetchedAt: string;
  /** Where the rate table came from (`open.er-api.com` or `fallback`). */
  ratesSource: string;
  /** Whether weekend surcharges were applied (Japan time). */
  isJapanWeekend: boolean;
  currency: Currency;
}

export interface SimulationResponse {
  meta: SimulationMeta;
  results: SimulationResult[];
}
