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
| SBI Remit | IDR PHP VND NPR CNY THB | `POST https://www.remit.co.jp/kaigaisoukin/exchangeratecommission/exchange/` (form `currency=<CCY>&mode=receive&base=JPY`, one call per currency) | adapter (`src/lib/sources/sbi-remit.ts`) | API already per-1-JPY incl. CNY/THB (live-verified 2026-08-23; page *display* uses `data-rate` multipliers — CNY/USD/BRL only — which do NOT apply to the API) | 12 h KV | **observed** (INR, BDT: board returns `rate:null` → modeled) | IDR **verified** (task 8); others illustrative |
| Wise | USD EUR INR PHP IDR VND CNY NPR BDT THB KRW | `GET https://wise.com/gateway/v1/quotes/?source=JPY&target=<CCY>&rateType=FIXED&sourceAmount=10000` (one call per corridor) | adapter (`src/lib/sources/wise.ts`) | `rate` is per-1-JPY, arithmetic-verified 2026-08-23 ((¥10,000 − ¥289 fee) × 111.001 = targetAmount) | 12 h KV | **observed** (all 11 corridors live 2026-08-23; markup ≈ 0 as expected: IDR −0.33%) | illustrative (percentage — quote fees are amount-aware: ¥289 at ¥10k IDR) |
| Seven Bank / WU | IDR PHP VND INR NPR BDT THB USD | `GET https://www.sevenbank.co.jp/t/html/file/CurrentFXList.xml` (one board; rows keyed by two-letter countrycode — `ID` for Indonesia — plus a `<currencycode>` per currency) | adapter (`src/lib/sources/seven-bank-wu.ts`) | `fxrate` per-1-JPY (live 2026-08-23: IDR 110.916 vs mid 111.370); VN/PH blocks carry sibling USD rows — adapter matches countrycode + currencycode | 12 h KV | **observed** (all 8 corridors live 2026-08-23) | IDR **verified** (task 8); others illustrative
| PayForex | IDR only (receipt codes for other corridors sit behind a POST fragment — not reverse-engineered) | 1) `GET https://www.payforex.net/remittance/simulator?ctry=Indonesia` → session `__Host-PFXID` + `_csrf` meta · 2) `POST https://www.payforex.net/ajax` `{"func":"GetRemitRateAction","args":{"country":"Indonesia","receiptCode":"BR_BRI","fromFx":"JPY","toFx":"IDR","needVipRateCalc":false}}` with `X-CSRF-TOKEN` + `X-Requested-With` | adapter (`src/lib/sources/payforex.ts`) | `resultData.currencyRate` string `(1 JPY = 109.0037 IDR)` — comma-grouped, stripped before parse; per-1-JPY | 12 h KV | **observed** (IDR live 2026-08-23; other corridors modeled) | illustrative (documented gap; `payMethod`/fees belong to their RemitSimulatorAction, not used) |
| Revolut Japan | all | — | — | — | — | modeled ("per published terms" relabel: task 21) | illustrative |
| Smiles | NPR INR PHP VND IDR BDT (THB absent from board 2026-08-23) | `GET https://www.smileswallet.com/japan/exchange-rates/` (server-rendered; `class='exchange_rate'` anchors per country block) | adapter (`src/lib/sources/smiles.ts`) | anchor text `<rate> <CCY>` per-1-JPY, ~3–4 significant digits | 12 h KV | **observed** (6 corridors live 2026-08-23; THB skipped → modeled) | IDR **verified** (task 8); others illustrative |
| Kyodai | all | — | — | — | — | modeled (manual rates: task 21) | IDR **verified** (task 8); others illustrative |
| JRF | PHP VND IDR INR NPR THB | `GET https://www.jpremit.com/api/fetch/country/fx/rates/extended` (one JSON board; header `X-Requested-With: XMLHttpRequest`) | adapter (`src/lib/sources/jrf.ts`) | `fx_rate` per-1-JPY; rows with `fx_rate: ""` are unquoted payment variants — skipped; first numeric row per currency wins | 12 h KV | **observed** (spike task 20 SUCCESS: endpoint reverse-engineered from the Vue SPA's axios calls, live from node + workerd 2026-08-23; INR quotes above mid on some days — the sanity bound may drop that corridor) | IDR **verified** (own fee API `POST /api/country/service/fee/all` acc_depo, 2026-08-23); others illustrative |
| Brastel | all | — | — | — | — | **modeled — spike task 19 FAILED** (see spike notes) | illustrative |
| Instarem | IDR | `GET https://www.instarem.com/api/v1/public/transaction/computed-value?source_currency=JPY&destination_currency=IDR&source_amount=10000` (anonymous) | adapter (`src/lib/sources/instarem.ts`) | `instarem_fx_rate` per-1-JPY (⚠️ NOT the reference `fx_rate`); promo cross-check vs `regular_instarem_fx_rate` — diverged quote → standard rate stored | 12 h KV | **observed** (live 2026-08-23: standard 110.8606; promo quote 110.9719 detected, not stored) | IDR **verified** (¥0, `regular_transaction_fee_amount: 0`, live 2026-08-23); corridor limit ¥5k–¥1M |
| City Express | IDR NPR VND PHP INR BDT THB KRW | `GET https://exchange.city-remit.net/api/rates` (one JSON board) | adapter (`src/lib/sources/city-express.ts`) | `rate` per-1-JPY; `GOLDENRATE` promo rows dropped (§9) | 12 h KV | **observed** (8 corridors live 2026-08-23) | IDR **verified** (cityremit.com/service-fee, 2026-08-23); others illustrative |
| JME | IDR | `GET https://japanremit.com/exchange-rate` (server-rendered tables; JME pane only — MoneyGram pane never read) | adapter (`src/lib/sources/jme.ts`) | BANK DEPOSIT method row per-1-JPY (live 110.1035); ⚠️ empty-method row is a promo ABOVE mid (112.4665) — structurally excluded | 12 h KV | **observed** (live 2026-08-23) | IDR **verified** (task plan table, 2026-08-23); global tiers = published schedule |
| DCOM | IDR (board quotes 19 currencies) | `GET https://sendmoney.co.jp/jp/fx-rate/` (server-rendered table) | adapter (`src/lib/sources/dcom.ts`) | send column `JPY = X` cell (`IDR 111.0000`) per-1-JPY; inverse `X = JPY` cell never read | 12 h KV | **observed** (live 2026-08-23) | IDR **verified** (plan fee table, 2026-08-23); others illustrative |
| Remitly Japan | IDR (promo) | `GET https://www.remitly.com/jp/ja/currency-converter/jpy-to-idr-rate` (server-rendered; embedded `merchandisingFacts` JSON) | adapter (`src/lib/sources/remitly.ts`) | `effectiveRateAsLowAs` per-1-JPY — **always `isPromo: true`** (new-customer rate, above mid); ⚠️ `secondaryMerchandisingFacts` block never read | 12 h KV | **observed — promo only** (live 2026-08-23: promo 111.42; everyday range 106.85–110.87 public on the page, exact per-config rate login-walled) | illustrative (¥100 flat placeholder; promo waives first-transfer fees) |
| BNI Tokyo | IDR | `GET http://www.ptbni.co.jp/faq-et/?lang=ja` (plain HTTP — server-side fetch only) | adapter (`src/lib/sources/bni-tokyo.ts`) | TTS card's `( IDR per JPY )` row per-1-JPY (live 107.99; fallback: invert the IDR TTS row); ⚠️ TTB card explicitly ignored; board updates business days ~09:20 JST | 12 h KV | **observed** (live 2026-08-23; board 2026-08-21 09:20 — weekend lag accepted under rev-4 uniform TTL) | IDR **verified** (express flat ¥3,500, research P2 2026-08-23) |

Rows are replaced as adapters land (tasks 9–20): each onboarding task fills in
the URL/method/quoting-units columns and flips rate status to **observed** per
verified corridor, or documents the spike/manual outcome.

---

## Spike notes

### Brastel WIMS gateway — task 19 verdict: NOT AUTOMATABLE (stays modeled)

Probed 2026-08-23 from **both** node egress and the workerd runtime
(`npx wrangler pages dev ./dist`, temporary probe route since removed):

| Stage | Result |
| --- | --- |
| `GET www.brastel.com/web/WIMS/Manager.aspx?action=GetAllBestExchangeRates&xslFile=getwebmethodxml.xsl&seeXmlOnly=true` | HTTP 200 from **both** runtimes (the P1 "method not found" / P2 "TLS refused" split does not reproduce from our egress) — but the payload is a WIMS error envelope: `Method not found: GetAllBestExchangeRates`, `<MethodList />` empty (no introspection) |
| 8 candidate action names (`GetExchangeRates`, `GetAllExchangeRates`, `GetBestExchangeRates`, `ExchangeRateList`, …) | all `Method not found` |
| `remit.brastel.com` (the remit SPA that would reveal the real action name) | **HTTP 403 openresty** from node AND workerd — WAF blocks our egress outright |
| `brastelremit.jp/eng/home` | **HTTP 403 openresty** from node AND workerd |
| `www.brastel.com/pages/eng/remit/` | HTTP 200 but a JS stub with no rate links; `rates_from_mobile.xsl` is the calling-card page, not remittance |

Conclusion: the gateway is reachable but the remit-rates method is undiscoverable
without reading the WAF-walled SPA — replaying past the WAF would cross the
plan's no-session-spoofing / politeness line. **No adapter; Brastel stays
modeled.** No browser-captured manual rate exists, so no manual entry either
(manual entries require a genuinely captured value — Kyodai's is the only one
so far). Rerun trigger: if Brastel's SPA ever becomes fetchable (or a genuine
captured rate is taken in a browser), add `src/data/manual-rates.json` entry or
an adapter.

### JRF — task 20 verdict: AUTOMATED (adapter landed)

`https://www.jpremit.com/today-rates` is a Vue SPA whose 2.5 MB `app.js`
bundle contains every axios call as string literals. The board the page
renders is a plain anonymous `GET /api/fetch/country/fx/rates/extended`
(Laravel JSON, no session, no CSRF). Verified from node + workerd egress
2026-08-23; their fee schedule is equally open
(`POST /api/country/service/fee/all` → IDR acc_depo tiers ¥850/¥1,450/¥1,950,
now the verified `byCurrency.IDR` fee override). The registry's JRF website
corrected to `https://www.jpremit.com/` (the site's own title: "JRF (Japan
Remit Finance Co., Ltd.) … www.jpremit.com").

### Fee tables verified so far

Checked in with task 8 (2026-08-23) as `byCurrency.IDR` overrides in
`src/lib/providers.ts` — verified on the JPY→IDR corridor (research pass 2,
plan "Verified fee tier tables"); tiers are inclusive upper bounds:

| Provider | Method | Tiers (send band → fee) |
| --- | --- | --- |
| SBI Remit | bank | <¥10k → ¥460 · <¥50k → ¥880 · <¥250k → ¥1,480 · ≤¥1M → ¥1,980 |
| Seven Bank/WU | cash (WU) | <¥10k → ¥400 · <¥30k → ¥450 · <¥50k → ¥500 · <¥100k → ¥890 · <¥250k → ¥990 · <¥500k → ¥1,350 · ≤¥1M → ¥1,750 |
| Smiles | bank | <¥10k → ¥400 · <¥50k → ¥600 · <¥250k → ¥1,000 · ≤¥1M → ¥1,450 |
| Kyodai | bank | <¥10k → ¥450 · <¥50k → ¥880 · <¥250k → ¥1,480 · ≤¥1M → ¥1,980 |
| Instarem | bank | flat **¥0** (verified live: `regular_transaction_fee_amount: 0`, 2026-08-23) |
| City Express | bank + cash | <¥10k → ¥400 · <¥50k → ¥500 · <¥250k → ¥1,000 · ≤¥1M → ¥1,500 (public service-fee page, 2026-08-23) |
| JME | bank | <¥10k → ¥400 · <¥50k → ¥500 · <¥250k → ¥1,000 · ≤¥1M → ¥1,500 (research P2, 2026-08-23) |
| DCOM | bank | <¥30k → ¥400 · <¥250k → ¥1,000 · ≤¥1M → ¥1,750 (research P2, 2026-08-23) |
| BNI Tokyo | bank (express) | flat **¥3,500** (research P2, 2026-08-23) |

Every non-IDR corridor of these providers keeps the illustrative global tiers
(marked above). Still unverified: Wise (percentage model by design), PayForex,
JRF, Brastel, and all non-IDR corridors.

---

## Known gaps / follow-ups

- SBI board does not quote INR or BDT (`rate: null` as of 2026-08-23) — those
  corridors render modeled until the board changes.
- Wise quote `fee` is amount-aware (¥289 at the ¥10,000 IDR reference quote) —
  the registry keeps the percentage model; amount-tiered fee modeling is a
  documented gap (plan §8).
- Seven Bank `Sendcharge.xml` (fee cross-check for task 8's IDR tiers) no
  longer exists — the URL serves the bank's HTML homepage (2026-08-23). The
  verified IDR tiers stand on research pass 2; divergence check not possible.
- Remitly's everyday (standard) rate RANGE is public on the converter page
  (`everydayRateAsLowAs/AsHighAs`, live 106.85–110.87) — superseding P2's
  "standard rate fully login-walled" verdict for the range, though the exact
  per-config rate still requires login. Stored rate stays promo-flagged;
  modeling the everyday range is a possible future refinement.
- Workers-egress confirmation for production (post-deploy cold request) is
  task 22; everything above ran on local workerd via `wrangler pages dev`.
