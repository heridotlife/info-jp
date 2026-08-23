# JP Remittance Simulator & Comparison Engine

Compare the **real payout** of major money-transfer services operating in Japan.
Enter an amount in JPY, pick a destination currency and receiving method, and
the app ranks providers by what actually lands in the recipient's account —
folding the hidden exchange-rate markup back into a single _net effective cost_.

Built with **Astro (SSR)** + **Tailwind CSS v4** on **Cloudflare Pages**, with
FX rates cached in **Cloudflare KV**.

---

## Architecture

```
Browser ──GET /api/simulate (or SSR /)──▶ Pages Function
                                             │
              ┌──────────────────────────────┼───────────────────────────┐
              ▼                              ▼                           ▼
   getRates(RATES_KV)            resolveObservedRates(RATES_KV)   simulate() — pure math
   mid-market, 10-min TTL        per-provider observed rates,
        │ miss                       12-h TTL, read-through
        ▼                              │ miss → due adapters fetch
   open.er-api.com                    ▼  live NOW, in parallel (~10 s budget)
                                  provider rate boards (adapters)
```

**Requests are the only fetch path** — no cron Worker, no refresh API. A warm
request reads KV only (instant); the first request after a TTL expiry fetches
the due sources in parallel, caches them for everyone (12 h observed /
10 min mid-market), and renders partial results if some sources fail
(failed providers fall back to estimated rates, reported in `meta.fetchErrors`).

- **Calculation is pure** (`src/lib/remittanceCalculator.ts`) — no I/O, so it's
  trivially testable. Rates are fetched separately and passed in.
- **Providers are declarative data** (`src/lib/providers.ts`) — add or edit a
  fee matrix without touching calculation code.
- **Rate adapters are per-provider** (`src/lib/sources/`) — each automatable
  provider's own rate board, normalized to per-1-JPY, registered in
  `src/lib/sources/index.ts`; fixture-tested in `src/lib/sources/__tests__/`.
- **First paint is server-rendered**: the default IDR comparison is computed
  in `index.astro` as a real table (works without JS); clicking Compare
  re-runs it via the JSON API.

## Project layout

| Path                              | Purpose                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `astro.config.mjs`                | Cloudflare adapter (directory output) + Tailwind Vite plugin                       |
| `wrangler.jsonc`                  | Pages config + `RATES_KV` binding                                                  |
| `src/types/remittance.ts`         | All domain types (Provider, FeeTier, ObservedRateSet, SimulationResult…)           |
| `src/lib/providers.ts`            | **Provider fee matrices** — the data engine                                        |
| `src/lib/currencies.ts`           | Destination currency catalogue                                                     |
| `src/lib/rates.ts`                | Mid-market rate fetch + KV read-through cache (10-min TTL)                         |
| `src/lib/observedRates.ts`        | Per-provider observed-rate read-through resolver (12-h TTL) + staleness classifier |
| `src/lib/sources/`                | Rate adapters + registry (`index.ts`) + recorded fixtures                          |
| `src/lib/remittanceCalculator.ts` | The simulation engine                                                              |
| `src/lib/renderResults.ts`        | Comparison-table renderer shared by SSR + client                                   |
| `src/lib/simulationRequest.ts`    | Input parsing/validation shared by page + API                                      |
| `src/pages/index.astro`           | IDR-first dashboard (server-rendered table)                                        |
| `src/scripts/simulator.ts`        | Framework-free client controller (Compare button)                                  |
| `src/pages/api/simulate.ts`       | `GET`/`POST /api/simulate` JSON endpoint                                           |
| `scripts/verify-rates.ts`         | `bun run verify:rates` — live egress check of every adapter                        |
| `docs/rate-sources.md`            | Per-provider source/fee register (verified vs illustrative)                        |

## Getting started

```bash
bun install
bun run dev        # http://localhost:4321  (Miniflare simulates KV locally)
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

Deployment is **Pages-only** — a single wrangler target, no separate Worker.
Requests keep the caches warm (12 h observed / 10 min mid-market), so there is
nothing to schedule or monitor.

```bash
# 1. Create the KV namespaces and paste the ids into wrangler.jsonc
bunx wrangler kv namespace create RATES_KV
bunx wrangler kv namespace create RATES_KV --preview

# 2. Build + deploy
bun run deploy       # astro build && wrangler pages deploy ./dist
```

## Notes on the stack

- The current `@astrojs/cloudflare` (v12) always emits directory-style output,
  so the legacy `mode: 'directory'` option is no longer needed — see the
  comment in `astro.config.mjs`.
- Tailwind v4 is wired via the `@tailwindcss/vite` plugin; dark mode is
  class-based (`@custom-variant dark` in `src/styles/global.css`).
