import type { Provider } from '../types/remittance';

/**
 * ============================================================================
 *  REMITTANCE PROVIDER REGISTRY  (the "fee matrix" data engine)
 * ============================================================================
 *
 *  Each object below fully describes one provider. The calculator in
 *  src/lib/remittanceCalculator.ts reads these declaratively — you never need
 *  to write calculation code to onboard or update a provider.
 *
 *  HOW TO ADD A PROVIDER
 *  ---------------------
 *    1. Copy one of the blocks below.
 *    2. Give it a unique `id`.
 *    3. Fill in `supportedCurrencies`, `deliveryTypes`, and `speed`.
 *    4. Set the `rateMarkup` (see below) and the `fee` model.
 *
 *  HOW TO UPDATE A FEE MATRIX
 *  --------------------------
 *    • Flat-fee tiers → edit the `tiers` array of a `{ kind: 'tiered' }` fee.
 *      Tiers are matched top-to-bottom; the first tier whose `upToJPY` bound is
 *      >= the send amount wins. Keep them sorted ascending and end with
 *      `{ upToJPY: null, ... }` as the open-ended top tier.
 *    • Percentage fees (Wise) → edit `percent` / `fixedJPY` on a
 *      `{ kind: 'percentage' }` fee.
 *    • Single flat fee → `{ kind: 'flat', feeJPY }`.
 *
 *  HOW TO UPDATE THE EXCHANGE-RATE MARKUP
 *  --------------------------------------
 *    `rateMarkup.default` is the fraction added on top of the mid-market rate
 *    (0.018 = the provider's rate is 1.8% worse than mid-market). Override
 *    specific corridors via `rateMarkup.byCurrency`. `weekendSurcharge` adds
 *    extra markup on Japan-time weekends (used by Revolut Standard).
 *
 *  ⚠️  The numbers below are illustrative defaults for the simulator. Before
 *      going to production, replace them with each provider's *published*
 *      fee schedule and observed FX spread, and keep them under review.
 * ============================================================================
 */
export const PROVIDERS: readonly Provider[] = [
  // --------------------------------------------------------------------------
  // WISE — mid-market rate, transparent percentage fee.
  // Wise advertises the real mid-market rate (≈0 markup) and charges a
  // variable percentage + tiny fixed component instead.
  // --------------------------------------------------------------------------
  {
    id: 'wise',
    name: 'Wise',
    logoText: 'WI',
    brandColor: '#9fe870',
    website: 'https://wise.com/jp',
    supportedCurrencies: ['USD', 'EUR', 'INR', 'PHP', 'IDR', 'VND', 'CNY', 'NPR', 'BDT', 'THB', 'KRW'],
    deliveryTypes: ['bank', 'wallet'],
    speed: { label: 'Seconds – 1 day', rankMinutes: 60 },
    rateMarkup: { default: 0 }, // true mid-market rate
    fee: {
      kind: 'percentage',
      percent: 0.0059, // ~0.59% of the send amount (corridor-dependent in reality)
      fixedJPY: 70, //   small fixed component
      minFeeJPY: 90,
    },
    note: 'Always the mid-market rate. Fee is a transparent % of the amount.',
  },

  // --------------------------------------------------------------------------
  // SBI REMIT — tiered flat fee + moderate FX markup. Popular for SE Asia.
  // --------------------------------------------------------------------------
  {
    id: 'sbi-remit',
    name: 'SBI Remit',
    logoText: 'SBI',
    brandColor: '#0b3d91',
    website: 'https://www.remit.co.jp/',
    supportedCurrencies: ['IDR', 'PHP', 'VND', 'INR', 'NPR', 'BDT', 'CNY', 'THB'],
    deliveryTypes: ['bank', 'cash', 'wallet'],
    speed: { label: 'Minutes – 1 day', rankMinutes: 240 },
    rateMarkup: {
      default: 0.015, // ~1.5%
      byCurrency: { PHP: 0.017, IDR: 0.016, INR: 0.014 },
    },
    fee: {
      kind: 'tiered',
      // Global (illustrative for non-IDR corridors).
      tiers: [
        { upToJPY: 30_000, feeJPY: 250 },
        { upToJPY: 100_000, feeJPY: 400 },
        { upToJPY: null, feeJPY: 880 },
      ],
      // VERIFIED JPY→IDR bank-transfer fee table.
      // Source: SBI Remit published fee schedule, verified 2026-08-23
      // (research pass 2, plan “Verified fee tier tables”); see docs/rate-sources.md.
      byCurrency: {
        IDR: [
          { upToJPY: 10_000, feeJPY: 460 },
          { upToJPY: 50_000, feeJPY: 880 },
          { upToJPY: 250_000, feeJPY: 1_480 },
          { upToJPY: 1_000_000, feeJPY: 1_980 },
        ],
      },
    },
  },

  // --------------------------------------------------------------------------
  // SEVEN BANK / WESTERN UNION — cash pickup network. Higher FX markup, the
  // trade-off for a huge global payout footprint.
  // --------------------------------------------------------------------------
  {
    id: 'seven-bank-wu',
    name: 'Seven Bank / Western Union',
    logoText: 'WU',
    brandColor: '#ffdd00',
    website: 'https://www.sevenbank.co.jp/soukin/',
    supportedCurrencies: ['PHP', 'VND', 'IDR', 'INR', 'NPR', 'BDT', 'THB', 'USD'],
    deliveryTypes: ['cash', 'bank', 'wallet'],
    speed: { label: 'Minutes (cash pickup)', rankMinutes: 30 },
    rateMarkup: {
      default: 0.028, // ~2.8% — cash networks carry a wider spread
      byCurrency: { PHP: 0.025 },
    },
    fee: {
      kind: 'tiered',
      // Global (illustrative for non-IDR corridors).
      tiers: [
        { upToJPY: 30_000, feeJPY: 550 },
        { upToJPY: 100_000, feeJPY: 990 },
        { upToJPY: null, feeJPY: 1_500 },
      ],
      // VERIFIED JPY→IDR fee table (Western Union cash pickup via Seven Bank ATM).
      // Source: Seven Bank send-charge schedule (Sendcharge), verified 2026-08-23
      // (research pass 2, plan “Verified fee tier tables”); see docs/rate-sources.md.
      byCurrency: {
        IDR: [
          { upToJPY: 10_000, feeJPY: 400 },
          { upToJPY: 30_000, feeJPY: 450 },
          { upToJPY: 50_000, feeJPY: 500 },
          { upToJPY: 100_000, feeJPY: 890 },
          { upToJPY: 250_000, feeJPY: 990 },
          { upToJPY: 500_000, feeJPY: 1_350 },
          { upToJPY: 1_000_000, feeJPY: 1_750 },
        ],
      },
    },
    note: 'Cash pickup at Western Union agents worldwide, often within minutes.',
  },

  // --------------------------------------------------------------------------
  // PAYFOREX — online-first, competitive tiers for SE/South Asia.
  // --------------------------------------------------------------------------
  {
    id: 'payforex',
    name: 'PayForex',
    logoText: 'PF',
    brandColor: '#e4002b',
    website: 'https://www.payforex.net/',
    supportedCurrencies: ['PHP', 'VND', 'IDR', 'INR', 'NPR', 'BDT', 'THB', 'CNY'],
    deliveryTypes: ['bank', 'cash', 'wallet'],
    speed: { label: 'Minutes – hours', rankMinutes: 120 },
    rateMarkup: { default: 0.018 },
    fee: {
      kind: 'tiered',
      tiers: [
        { upToJPY: 50_000, feeJPY: 480 },
        { upToJPY: 150_000, feeJPY: 680 },
        { upToJPY: null, feeJPY: 980 },
      ],
    },
  },

  // --------------------------------------------------------------------------
  // REVOLUT JAPAN — special case. Standard plan gives the mid-market rate on
  // weekdays with a low flat fee, but adds a ~1% surcharge on weekends.
  // Modeled with `weekendSurcharge` + a flat fee.
  // --------------------------------------------------------------------------
  {
    id: 'revolut-jp',
    name: 'Revolut Japan',
    logoText: 'RV',
    brandColor: '#0666eb',
    website: 'https://www.revolut.com/ja-JP/',
    supportedCurrencies: ['USD', 'EUR', 'INR', 'PHP', 'THB', 'KRW', 'CNY'],
    deliveryTypes: ['bank', 'wallet'],
    speed: { label: 'Seconds – 2 hrs', rankMinutes: 120 },
    rateMarkup: {
      default: 0, //          weekday: true mid-market rate…
      weekendSurcharge: 0.01, // …+1% on Japan-time weekends
    },
    fee: {
      kind: 'flat',
      feeJPY: 300, // representative Standard-plan transfer fee
    },
    note: 'Mid-market rate on weekdays; ~1% FX markup on weekends (Standard plan).',
  },

  // --------------------------------------------------------------------------
  // SMILES MOBILE REMITTANCE — app-based, tiered fee, loyalty points option.
  // --------------------------------------------------------------------------
  {
    id: 'smiles',
    name: 'Smiles Mobile Remittance',
    logoText: 'SM',
    brandColor: '#00a99d',
    website: 'https://smiles.com/',
    supportedCurrencies: ['NPR', 'INR', 'PHP', 'VND', 'IDR', 'BDT', 'THB'],
    deliveryTypes: ['bank', 'cash', 'wallet'],
    speed: { label: 'Minutes – 1 day', rankMinutes: 180 },
    rateMarkup: { default: 0.015 },
    fee: {
      kind: 'tiered',
      // Global (illustrative for non-IDR corridors).
      tiers: [
        { upToJPY: 50_000, feeJPY: 400 },
        { upToJPY: 100_000, feeJPY: 600 },
        { upToJPY: null, feeJPY: 990 },
      ],
      // VERIFIED JPY→IDR bank-transfer fee table.
      // Source: Smiles published fee schedule, verified 2026-08-23
      // (research pass 2, plan “Verified fee tier tables”); see docs/rate-sources.md.
      byCurrency: {
        IDR: [
          { upToJPY: 10_000, feeJPY: 400 },
          { upToJPY: 50_000, feeJPY: 600 },
          { upToJPY: 250_000, feeJPY: 1_000 },
          { upToJPY: 1_000_000, feeJPY: 1_450 },
        ],
      },
    },
    note: 'Earn/redeem points to offset the transfer fee.',
  },

  // --------------------------------------------------------------------------
  // KYODAI REMITTANCE — long-running network, cash + bank + wallet.
  // --------------------------------------------------------------------------
  {
    id: 'kyodai',
    name: 'Kyodai Remittance',
    logoText: 'KY',
    brandColor: '#005bab',
    website: 'https://www.kyodai.co.jp/',
    supportedCurrencies: ['PHP', 'VND', 'IDR', 'INR', 'NPR', 'BDT', 'THB', 'CNY'],
    deliveryTypes: ['bank', 'cash', 'wallet'],
    speed: { label: 'Minutes – 1 day', rankMinutes: 240 },
    rateMarkup: { default: 0.017 },
    fee: {
      kind: 'tiered',
      // Global (illustrative for non-IDR corridors).
      tiers: [
        { upToJPY: 50_000, feeJPY: 500 },
        { upToJPY: 100_000, feeJPY: 700 },
        { upToJPY: null, feeJPY: 1_000 },
      ],
      // VERIFIED JPY→IDR bank-transfer fee table.
      // Source: Kyodai Remittance published fee schedule, verified 2026-08-23
      // (research pass 2, plan “Verified fee tier tables”); see docs/rate-sources.md.
      byCurrency: {
        IDR: [
          { upToJPY: 10_000, feeJPY: 450 },
          { upToJPY: 50_000, feeJPY: 880 },
          { upToJPY: 250_000, feeJPY: 1_480 },
          { upToJPY: 1_000_000, feeJPY: 1_980 },
        ],
      },
    },
  },

  // --------------------------------------------------------------------------
  // JRF — Japan Remit Finance. Bank-transfer focused.
  // --------------------------------------------------------------------------
  {
    id: 'jrf',
    name: 'Japan Remit Finance (JRF)',
    logoText: 'JRF',
    brandColor: '#c8102e',
    website: 'https://www.jrf.co.jp/',
    supportedCurrencies: ['PHP', 'VND', 'IDR', 'INR', 'NPR', 'THB'],
    deliveryTypes: ['bank', 'wallet'],
    speed: { label: 'Hours – 1 day', rankMinutes: 480 },
    rateMarkup: { default: 0.016 },
    fee: {
      kind: 'tiered',
      tiers: [
        { upToJPY: 50_000, feeJPY: 450 },
        { upToJPY: 100_000, feeJPY: 650 },
        { upToJPY: null, feeJPY: 900 },
      ],
    },
  },

  // --------------------------------------------------------------------------
  // BRASTEL REMIT — strong Philippines/Brazil corridors, cash + bank.
  // --------------------------------------------------------------------------
  {
    id: 'brastel',
    name: 'Brastel Remit',
    logoText: 'BR',
    brandColor: '#f7941e',
    website: 'https://remit.brastel.com/',
    supportedCurrencies: ['PHP', 'VND', 'IDR', 'INR', 'NPR', 'BDT', 'THB'],
    deliveryTypes: ['bank', 'cash', 'wallet'],
    speed: { label: 'Minutes – 1 day', rankMinutes: 200 },
    rateMarkup: { default: 0.018 },
    fee: {
      kind: 'tiered',
      tiers: [
        { upToJPY: 50_000, feeJPY: 500 },
        { upToJPY: 100_000, feeJPY: 800 },
        { upToJPY: null, feeJPY: 1_200 },
      ],
    },
  },
  // --------------------------------------------------------------------------
  // INSTAREM — new-provider onboarding 2026-08-23. Observed rates via its
  // computed-value quote API (adapter supersedes the modeled markup below).
  // --------------------------------------------------------------------------
  {
    id: 'instarem',
    name: 'Instarem',
    logoText: 'IN',
    brandColor: '#5b53ff',
    website: 'https://www.instarem.com/en-jp/',
    supportedCurrencies: ['IDR'], // grown only as corridors verify
    deliveryTypes: ['bank'],
    speed: { label: 'Hours – 1 day', rankMinutes: 480 },
    rateMarkup: {
      // Modeled placeholder only — superseded by the observed-rate adapter
      // (live 2026-08-23: regular pricing margin ≈ 0.35% on IDR).
      default: 0.003,
      byCurrency: { IDR: 0.0035 },
    },
    fee: {
      // Verified live IDR, `regular_transaction_fee_amount: 0` (research P2,
      // reconfirmed from our egress 2026-08-23).
      kind: 'flat',
      feeJPY: 0,
    },
    note: 'Corridor limit ¥5,000–¥1,000,000 (JPY→IDR). ¥0 transfer fee verified. Quotes can carry a first-transaction rate bonus — the comparison stores the standard (regular) rate when they diverge.',
  },
];

/** Total number of providers, handy for meta/analytics. */
export const PROVIDER_COUNT = PROVIDERS.length;
