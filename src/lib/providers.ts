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
    supportedCurrencies: [
      'USD',
      'EUR',
      'INR',
      'PHP',
      'IDR',
      'VND',
      'CNY',
      'NPR',
      'BDT',
      'THB',
      'KRW',
    ],
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
    // Cloudflare-walled (research P2) — never labeled observed; the modeled
    // basis is their published terms, so the breakdown says so (task 21).
    modeledSourceLabel: 'per published terms (weekday interbank + 1 % weekend)',
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
    website: 'https://www.jpremit.com/',
    supportedCurrencies: ['PHP', 'VND', 'IDR', 'INR', 'NPR', 'THB'],
    deliveryTypes: ['bank', 'wallet'],
    speed: { label: 'Hours – 1 day', rankMinutes: 480 },
    rateMarkup: {
      // Modeled placeholder only — superseded by the observed-rate adapter
      // (live 2026-08-23: IDR 111.2 vs mid 111.37 → −0.15%; spike task 20).
      default: 0.016,
    },
    fee: {
      kind: 'tiered',
      // Global (illustrative for non-IDR corridors).
      tiers: [
        { upToJPY: 50_000, feeJPY: 450 },
        { upToJPY: 100_000, feeJPY: 650 },
        { upToJPY: null, feeJPY: 900 },
      ],
      // VERIFIED JPY→IDR bank-deposit (acc_depo) fee table.
      // Source: JRF's own public fee API POST /api/country/service/fee/all
      // (Indonesia, acc_depo), fetched live 2026-08-23 during the task-20
      // spike; ranges ¥1k–¥60k / ¥60,001–¥300k / ¥300,001–¥1M.
      byCurrency: {
        IDR: [
          { upToJPY: 60_000, feeJPY: 850 },
          { upToJPY: 300_000, feeJPY: 1_450 },
          { upToJPY: 1_000_000, feeJPY: 1_950 },
        ],
      },
    },
    note: 'Rates and fees from jpremit.com (today-rates board + published fee schedule, Indonesia).',
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
  // --------------------------------------------------------------------------
  // CITY EXPRESS (cityremit.com) — new-provider onboarding 2026-08-23.
  // Observed rates via the exchange.city-remit.net JSON board (adapter
  // supersedes the modeled markup below).
  // --------------------------------------------------------------------------
  {
    id: 'city-express',
    name: 'City Express',
    logoText: 'CE',
    brandColor: '#e65100',
    website: 'https://www.cityremit.com/',
    supportedCurrencies: ['IDR', 'NPR', 'VND', 'PHP', 'INR', 'BDT', 'THB', 'KRW'],
    deliveryTypes: ['bank', 'cash'],
    speed: { label: 'Minutes – 1 day', rankMinutes: 120 },
    rateMarkup: {
      // Modeled placeholder only — superseded by the observed-rate adapter
      // (live 2026-08-23: IDR −0.15%, NPR −1.1% vs mid).
      default: 0.01,
      byCurrency: { IDR: 0.004 },
    },
    fee: {
      kind: 'tiered',
      // Global (illustrative for other corridors).
      tiers: [
        { upToJPY: 50_000, feeJPY: 500 },
        { upToJPY: 250_000, feeJPY: 1_000 },
        { upToJPY: null, feeJPY: 1_500 },
      ],
      // VERIFIED JPY→IDR fee table (bank transfer; cash pickup identical).
      // Source: https://cityremit.com/service-fee (public page), verified
      // 2026-08-23 during onboarding — the /api/rates payload carries no fee
      // fields; see docs/rate-sources.md.
      byCurrency: {
        IDR: [
          { upToJPY: 10_000, feeJPY: 400 },
          { upToJPY: 50_000, feeJPY: 500 },
          { upToJPY: 250_000, feeJPY: 1_000 },
          { upToJPY: 1_000_000, feeJPY: 1_500 },
        ],
      },
    },
    note: 'The rate board also carries “GOLDENRATE” promo rates — the comparison always uses the standard rate.',
  },
  // --------------------------------------------------------------------------
  // JME (Japan Money Express) — new-provider onboarding 2026-08-23. Observed
  // rates via the japanremit.com/exchange-rate table (adapter supersedes the
  // modeled markup below).
  // --------------------------------------------------------------------------
  {
    id: 'jme',
    name: 'JME (Japan Money Express)',
    logoText: 'JME',
    brandColor: '#d71920',
    website: 'https://japanremit.com',
    supportedCurrencies: ['IDR'], // grown only as corridors verify
    deliveryTypes: ['bank', 'cash'],
    speed: { label: 'Within hours', rankMinutes: 240 },
    rateMarkup: {
      // Modeled placeholder only — superseded by the observed-rate adapter
      // (live 2026-08-23: bank-deposit IDR 110.1035 vs mid 111.37 → −1.14%).
      default: 0.011,
    },
    fee: {
      kind: 'tiered',
      // VERIFIED JPY→IDR fee table (research pass 2, verified 2026-08-23,
      // plan “Verified fee tier tables”). Global tiers: JME is IDR-first and
      // this schedule is its published standard; other corridors flagged
      // illustrative in docs/rate-sources.md.
      tiers: [
        { upToJPY: 10_000, feeJPY: 400 },
        { upToJPY: 50_000, feeJPY: 500 },
        { upToJPY: 250_000, feeJPY: 1_000 },
        { upToJPY: 1_000_000, feeJPY: 1_500 },
      ],
    },
    note: 'Rate shown is the standard BANK DEPOSIT rate — the page also displays campaign rates that this comparison never uses.',
  },
  // --------------------------------------------------------------------------
  // DCOM MONEY EXPRESS — new-provider onboarding 2026-08-23. Observed rates
  // via the sendmoney.co.jp rate table (adapter supersedes the modeled
  // markup below).
  // --------------------------------------------------------------------------
  {
    id: 'dcom',
    name: 'DCOM Money Express',
    logoText: 'DC',
    brandColor: '#0f7b3f',
    website: 'https://sendmoney.co.jp',
    supportedCurrencies: ['IDR'], // grown only as corridors verify (board quotes 19)
    deliveryTypes: ['bank', 'cash'],
    speed: { label: 'Minutes – 1 day', rankMinutes: 60 },
    rateMarkup: {
      // Modeled placeholder only — superseded by the observed-rate adapter
      // (live 2026-08-23: IDR 111.0 vs mid 111.37 → −0.33%).
      default: 0.005,
    },
    fee: {
      kind: 'tiered',
      // Global (illustrative for other corridors).
      tiers: [
        { upToJPY: 50_000, feeJPY: 500 },
        { upToJPY: 250_000, feeJPY: 1_000 },
        { upToJPY: null, feeJPY: 1_750 },
      ],
      // VERIFIED JPY→IDR fee table.
      // Source: DCOM published fee schedule, verified 2026-08-23 (research
      // pass 2, plan “Verified fee tier tables”); see docs/rate-sources.md.
      byCurrency: {
        IDR: [
          { upToJPY: 30_000, feeJPY: 400 },
          { upToJPY: 250_000, feeJPY: 1_000 },
          { upToJPY: 1_000_000, feeJPY: 1_750 },
        ],
      },
    },
  },
  // --------------------------------------------------------------------------
  // REMITLY JAPAN — new-provider onboarding 2026-08-23. Observed rates are
  // the PUBLIC PAGE'S NEW-CUSTOMER PROMO RATE (always `isPromo` — never
  // eligible for `best-value`, plan “Approach” §9).
  // --------------------------------------------------------------------------
  {
    id: 'remitly',
    name: 'Remitly',
    logoText: 'RE',
    brandColor: '#0071bc',
    website: 'https://www.remitly.com/jp',
    supportedCurrencies: ['IDR'], // grown only as corridors verify
    deliveryTypes: ['bank', 'cash', 'wallet'],
    speed: { label: 'Minutes – hours', rankMinutes: 30 },
    rateMarkup: {
      // Modeled placeholder only — superseded by the promo-flagged observed
      // rate (live 2026-08-23: promo 111.42, everyday range 106.85–110.87).
      default: 0.015,
    },
    fee: {
      // ILLUSTRATIVE (flagged — plan gap list): ¥100 representative flat
      // fee; the promo waives first-transfer fees, everyday fees vary by
      // pay/delivery config. See docs/rate-sources.md.
      kind: 'flat',
      feeJPY: 100,
    },
    note: 'Public page shows the new-customer promo rate (first transfer, capped at ¥100,000) — displayed as “Promo — new customers only” and never ranked as best value. Standard (everyday) rate varies by payment/delivery choice.',
  },
  // --------------------------------------------------------------------------
  // BNI TOKYO — new-provider onboarding 2026-08-23. Observed rates via the
  // ptbni.co.jp express-remittance board (TTS send card; adapter supersedes
  // the modeled markup below). Board updates business days ~09:20 JST.
  // --------------------------------------------------------------------------
  {
    id: 'bni-tokyo',
    name: 'BNI Tokyo',
    logoText: 'BNI',
    brandColor: '#f37021',
    website: 'http://www.ptbni.co.jp/',
    supportedCurrencies: ['IDR'],
    deliveryTypes: ['bank'],
    speed: { label: 'Hours – 1 day', rankMinutes: 480 },
    rateMarkup: {
      // Modeled placeholder only — superseded by the observed-rate adapter
      // (live 2026-08-23: TTS 107.99 vs mid 111.37 → −3.09%).
      default: 0.031,
    },
    fee: {
      // VERIFIED JPY→IDR express fee (research P2, plan “Verified fee tier
      // tables”, 2026-08-23); see docs/rate-sources.md.
      kind: 'flat',
      feeJPY: 3_500,
    },
    note: 'Express remittance to Indonesia; rate board updates on business days ~09:20 JST (TTS send card).',
  },
];

/** Total number of providers, handy for meta/analytics. */
export const PROVIDER_COUNT = PROVIDERS.length;
