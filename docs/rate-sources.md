# Rate Sources — per-provider register

Living register of where every provider's exchange rate and fee data comes
from, which corridors are verified, and what is still illustrative. Updated by
each adapter/onboarding task; `npm run verify:rates` re-checks every live
source from our own egress.

**Provenance legend** — rate status per corridor:
- **observed** — fetched live from the provider's own rate source (adapter), cached in KV for 12 h
- **manual** — checked-in rate, human-updated (`src/data/manual-rates.json`, task 21)
- **modeled** — estimated from a modeled markup (fallback ladder bottom)

Fee status: **verified** (from the provider's published/confirmed fee table,
JPY→IDR unless noted) or **illustrative** (simulator default, to be replaced).

---

## Task 6 GATE — SBI Remit proven end-to-end (2026-08-23)

**1. `npm run verify:rates` (node egress)** — all six quoted SBI corridors
fetched live, every rate inside the sanity bound [mid × 0.85, mid × 1.02], and
an independent re-fetch of the same endpoint agreed on every corridor (Δ 0.00%):

| Corridor | Observed (1 JPY →) | Mid-market | Markup | Sanity |
| --- | --- | --- | --- | --- |
| IDR | 111.110000 | 111.370031 | −0.23% | OK |
| PHP | 0.388500 | 0.388716 | −0.06% | OK |
| VND | 164.500000 | 164.366096 | +0.08% | OK |
| NPR | 0.954000 | 0.964650 | −1.10% | OK |
| CNY | 0.041900 | 0.042399 | −1.18% | OK |
| THB | 0.203500 | 0.205860 | −1.15% | OK |

**2. Workers runtime (workerd) egress — `npx wrangler pages dev ./dist`
(fresh KV namespace → true cold request):**

- `GET /api/simulate?amountJPY=100000&targetCurrency=IDR` → HTTP 200 in 0.39 s
- SBI Remit row: `rateSource.kind = "observed"`, `appliedRate = 111.11` IDR/JPY,
  `fetchedAt = 2026-08-23T09:46:20.836Z` (live, at request time),
  source `remit.co.jp rate board (kaigaisoukin/exchangeratecommission/exchange/)`
- `meta.observedCoverage = { observed: 1, modeled: 7 }`, no `fetchErrors`;
  SBI ranked #1 of 8 by real payout
- Server-rendered page (`GET /`) shows the SBI row with an
  **“Observed · just now”** badge and rate `1 ¥ = 111.11`

**3. Independent curl of the same endpoint, same egress, one second later
(2026-08-23T09:46:21Z):**

```
POST https://www.remit.co.jp/kaigaisoukin/exchangeratecommission/exchange/
     currency=IDR&mode=receive&base=JPY
→ {"rate":"111.110000","last_update":"2026-08-22 14:30:51",...}
```

Exact match with the workerd-fetched rate (111.11). Note the board's own
`last_update` (JST) can lag the fetch moment — the app records `fetchedAt` as
the observation time and relies on the 12 h KV TTL for freshness.

**GATE: PASSED** — SBI Remit's rate is real, fetched from our own egress
(node + workerd), reproducible via `npm run verify:rates`.

---

## Per-provider source table

| Provider | Corridor | Source URL | Method | Quoting units | Cache TTL | Rate status | Fee status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SBI Remit | IDR PHP VND NPR CNY THB | `POST https://www.remit.co.jp/kaigaisoukin/exchangeratecommission/exchange/` (form `currency=<CCY>&mode=receive&base=JPY`, one call per currency) | adapter (`src/lib/sources/sbi-remit.ts`) | API already per-1-JPY incl. CNY/THB (live-verified 2026-08-23; page *display* uses `data-rate` multipliers — CNY/USD/BRL only — which do NOT apply to the API) | 12 h KV | **observed** (INR, BDT: board returns `rate:null` → modeled) | illustrative (verified IDR tiers land in task 8) |
| Wise | all | — | — | — | — | modeled | illustrative (percentage) |
| Seven Bank / WU | all | — | — | — | — | modeled | illustrative |
| PayForex | all | — | — | — | — | modeled | illustrative |
| Revolut Japan | all | — | — | — | — | modeled ("per published terms" relabel: task 21) | illustrative |
| Smiles | all | — | — | — | — | modeled | illustrative |
| Kyodai | all | — | — | — | — | modeled (manual rates: task 21) | illustrative (verified IDR tiers: task 8) |
| JRF | all | — | — | — | — | modeled | illustrative |
| Brastel | all | — | — | — | — | modeled (spike: task 19) | illustrative |

Rows are replaced as adapters land (tasks 9–20): each onboarding task fills in
the URL/method/quoting-units columns and flips rate status to **observed** per
verified corridor, or documents the spike/manual outcome.

### Fee tables verified so far

None checked in yet — task 8 lands the verified JPY→IDR tier tables (SBI
Remit, Seven Bank/WU, Smiles, Kyodai) with per-currency overrides. All
non-IDR corridors stay illustrative.

---

## Known gaps / follow-ups

- SBI board does not quote INR or BDT (`rate: null` as of 2026-08-23) — those
  corridors render modeled until the board changes.
- Workers-egress confirmation for production (post-deploy cold request) is
  task 22; everything above ran on local workerd via `wrangler pages dev`.
