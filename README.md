# JP Remittance Simulator & Comparison Engine

Compare the **real payout** of major money-transfer services operating in Japan.
Enter an amount in JPY, pick a destination currency and receiving method, and
the app ranks providers by what actually lands in the recipient's account —
folding the hidden exchange-rate markup back into a single _net effective cost_.

Built with **Astro (SSR)** + **Tailwind CSS v4** on **Cloudflare Pages**, with
mid-market FX rates cached in **Cloudflare KV**.

---

## Architecture

```
Browser ──GET /api/simulate──▶ Pages Function ──▶ getRates(RATES_KV) ──▶ KV cache (10 min TTL)
   ▲                                │                     │ miss
   └──── renders comparison ◀───────┘                     ▼
                                                    open.er-api.com (mid-market)
                                                          │ (optional)
                          Cron Worker ─every 10 min──▶ refreshRates() keeps KV warm
```

- **Calculation is pure** (`src/lib/remittanceCalculator.ts`) — no I/O, so it's
  trivially testable. Rates are fetched separately and passed in.
- **Providers are declarative data** (`src/lib/providers.ts`) — add or edit a
  fee matrix without touching calculation code.
- **First paint is server-rendered**: the default comparison is computed in
  `index.astro`; the client re-runs it via the JSON API on any control change.

## Project layout

| Path | Purpose |
| --- | --- |
| `astro.config.mjs` | Cloudflare adapter (directory output) + Tailwind Vite plugin |
| `wrangler.jsonc` | Pages config + `RATES_KV` binding |
| `src/types/remittance.ts` | All domain types (Provider, FeeTier, SimulationResult, Currency…) |
| `src/lib/providers.ts` | **Provider fee matrices** — the data engine |
| `src/lib/currencies.ts` | Destination currency catalogue |
| `src/lib/rates.ts` | Mid-market rate fetch + KV read-through cache |
| `src/lib/remittanceCalculator.ts` | The simulation engine |
| `src/lib/simulationRequest.ts` | Input parsing/validation shared by page + API |
| `src/pages/index.astro` | Interactive dashboard (server-rendered shell) |
| `src/scripts/simulator.ts` | Framework-free client controller + card renderer |
| `src/pages/api/simulate.ts` | `GET`/`POST /api/simulate` JSON endpoint |
| `workers/rate-refresh/` | Optional Cron Worker that keeps the KV cache warm |

## Getting started

```bash
npm install
npm run dev        # http://localhost:4321  (Miniflare simulates KV locally)
```

`platformProxy` in `astro.config.mjs` gives `astro dev` access to the KV
binding declared in `wrangler.jsonc`; locally any namespace id works.

## API

```
GET /api/simulate?amountJPY=100000&targetCurrency=IDR&deliveryType=all
POST /api/simulate   { "amountJPY": 100000, "targetCurrency": "IDR", "deliveryType": "bank" }
```

`deliveryType` ∈ `all | bank | cash | wallet`. Invalid inputs fall back to
safe defaults rather than erroring. Response: `{ meta, results }` (see
`SimulationResponse` in `src/types/remittance.ts`).

## Updating provider data

Everything lives in `src/lib/providers.ts`, which has step-by-step comments.
The money model per provider:

```
appliedRate      = midMarketRate × (1 − markup)
amountConverted  = max(amountJPY − upfrontFee, 0)
receiveAmount    = amountConverted × appliedRate      ← ranked "best value"
markupCost(JPY)  = amountConverted × markup           ← the hidden cost
netCost(JPY)     = upfrontFee + markupCost
```

- **Tiered flat fee** → edit the `tiers` array of a `{ kind: 'tiered' }` fee.
- **Percentage fee (Wise)** → edit `percent` / `fixedJPY`.
- **FX markup** → `rateMarkup.default`, per-corridor `byCurrency`, or
  `weekendSurcharge` (Revolut-style).

> ⚠️ Fees/markups shipped here are **illustrative defaults**. Replace them with
> each provider's published schedule before using this for real decisions.

## Deploy to Cloudflare Pages

```bash
# 1. Create the KV namespaces and paste the ids into wrangler.jsonc
npx wrangler kv namespace create RATES_KV
npx wrangler kv namespace create RATES_KV --preview

# 2. Build + deploy
npm run deploy       # astro build && wrangler pages deploy ./dist

# 3. (Optional) keep the cache warm with the cron worker
cd workers/rate-refresh
# paste the same prod KV id into wrangler.toml, then:
npx wrangler deploy
```

## Notes on the stack

- The current `@astrojs/cloudflare` (v12) always emits directory-style output,
  so the legacy `mode: 'directory'` option is no longer needed — see the
  comment in `astro.config.mjs`.
- Tailwind v4 is wired via the `@tailwindcss/vite` plugin; dark mode is
  class-based (`@custom-variant dark` in `src/styles/global.css`).
