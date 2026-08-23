/**
 * ============================================================================
 *  verify:rates — live egress check for every registered rate adapter
 * ============================================================================
 *
 * Fetches each registered adapter LIVE from this environment and prints the
 * observed rate vs the provider's own source URL vs the live mid-market rate
 * plus the derived markup. This is the first independent confirmation of the
 * research-pass endpoint claims from OUR OWN egress (Task 6 gate + per-adapter
 * acceptance criteria).
 *
 * Exit code ≠ 0 when:
 *   • the gate provider (SBI Remit) fails to fetch,
 *   • SBI's adapter rate disagrees with an independent re-fetch of the same
 *     endpoint beyond tolerance (rate ticks allowed), or
 *   • any corridor falls outside the sanity bound [mid × 0.85, mid × 1.02].
 *
 * Run: npm run verify:rates
 */
import { RATE_ADAPTERS } from '../src/lib/sources';
import { withinSanityBound } from '../src/lib/observedRates';
import { SBI_REMIT_ENDPOINT } from '../src/lib/sources/sbi-remit';
import type { CurrencyCode, ObservedRateSet } from '../src/types/remittance';

/** Drift tolerated between adapter fetch and independent re-fetch (rates tick). */
const PAGE_TOLERANCE = 0.01; // 1 %

const MIDMARKET_URL = 'https://open.er-api.com/v6/latest/JPY';

async function fetchMidMarket(): Promise<Partial<Record<CurrencyCode, number>>> {
  const res = await fetch(MIDMARKET_URL);
  if (!res.ok) throw new Error(`mid-market upstream ${res.status}`);
  const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
  if (data.result !== 'success' || !data.rates) throw new Error('malformed mid-market payload');
  return data.rates as Partial<Record<CurrencyCode, number>>;
}

/** Independent re-fetch of one SBI corridor (the "vs the page" comparison). */
async function refetchSbiCorridor(currency: CurrencyCode): Promise<number | undefined> {
  const res = await fetch(SBI_REMIT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ currency, mode: 'receive', base: 'JPY' }).toString(),
  });
  if (!res.ok) return undefined;
  const json = (await res.json()) as { rate?: string | null };
  if (typeof json.rate !== 'string') return undefined;
  const n = Number(json.rate);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const pct = (frac: number) => (frac * 100).toFixed(2) + '%';

async function main(): Promise<number> {
  const now = new Date().toISOString();
  console.log(`verify:rates — live adapter check from THIS egress (node) @ ${now}`);
  console.log('');

  let mid: Partial<Record<CurrencyCode, number>>;
  try {
    mid = await fetchMidMarket();
  } catch (err) {
    console.error(`FATAL: mid-market fetch failed — cannot sanity-check: ${(err as Error).message}`);
    return 1;
  }
  const sample = (Object.entries(mid) as Array<[CurrencyCode, number]>)
    .filter(([c]) => ['IDR', 'PHP', 'VND', 'NPR', 'CNY', 'THB'].includes(c))
    .map(([c, v]) => `${c} ${v.toFixed(4)}`)
    .join('  ');
  console.log(`mid-market (${MIDMARKET_URL}): ${sample}`);
  console.log('');

  const failures: string[] = [];

  for (const [providerId, adapter] of Object.entries(RATE_ADAPTERS)) {
    console.log(`── ${providerId} ──`);
    let set: ObservedRateSet;
    try {
      set = await adapter.fetchRates();
    } catch (err) {
      console.log(`  ADAPTER FAILED: ${(err as Error).message}`);
      failures.push(`${providerId}: adapter fetch failed (${(err as Error).message})`);
      console.log('');
      continue;
    }

    console.log(`  source: ${set.source}${set.isPromo ? '  [PROMO RATE — never best-value]' : ''}`);
    console.log(`  fetchedAt: ${set.fetchedAt}${set.quoteAmountJPY ? `  (quoted at ¥${set.quoteAmountJPY.toLocaleString()})` : ''}`);

    for (const [code, rate] of Object.entries(set.rates) as Array<[CurrencyCode, number]>) {
      const midRate = mid[code];
      const line = `  ${code}: ${rate.toFixed(6)}`;
      if (midRate === undefined) {
        console.log(`${line}  (no mid-market value — sanity check skipped)`);
        continue;
      }
      const markup = (midRate - rate) / midRate;
      const sane = withinSanityBound(rate, midRate);
      const verdict = sane ? 'OK' : 'OUT OF BOUNDS';
      console.log(
        `${line}  mid ${midRate.toFixed(6)}  markup ${pct(markup)}  sanity [${(midRate * 0.85).toFixed(4)} .. ${(midRate * 1.02).toFixed(4)}]: ${verdict}`,
      );
      if (!sane) failures.push(`${providerId} ${code}: ${rate} outside sanity bound vs mid ${midRate}`);
    }
    console.log('');
  }

  // --- Gate: SBI Remit must be live, sane, and match an independent re-fetch.
  const sbiAdapter = RATE_ADAPTERS['sbi-remit'];
  if (!sbiAdapter) {
    failures.push('gate: SBI Remit adapter not registered');
  } else {
    try {
      const set = await sbiAdapter.fetchRates();
      console.log('── gate: SBI Remit vs independent re-fetch of the same endpoint ──');
      for (const code of ['IDR', 'PHP', 'VND', 'NPR', 'CNY', 'THB'] as CurrencyCode[]) {
        const rate = set.rates[code];
        const page = await refetchSbiCorridor(code);
        if (rate === undefined) {
          console.log(`  ${code}: not quoted by adapter`);
          continue;
        }
        if (page === undefined) {
          failures.push(`gate: SBI ${code} re-fetch failed (adapter said ${rate})`);
          continue;
        }
        const drift = Math.abs(rate - page) / page;
        const ok = drift <= PAGE_TOLERANCE;
        console.log(
          `  ${code}: adapter ${rate.toFixed(6)}  page ${page.toFixed(6)}  Δ ${pct(drift)}  ${ok ? 'OK' : 'MISMATCH'}`,
        );
        if (!ok) failures.push(`gate: SBI ${code} adapter ${rate} vs page ${page} (Δ ${pct(drift)} > ${pct(PAGE_TOLERANCE)})`);
      }
      console.log(`  source URL: ${SBI_REMIT_ENDPOINT}`);
      console.log('');
    } catch (err) {
      failures.push(`gate: SBI Remit fetch failed (${(err as Error).message})`);
    }
  }

  if (failures.length > 0) {
    console.error('RESULT: FAIL');
    for (const f of failures) console.error(`  ✗ ${f}`);
    return 1;
  }
  console.log('RESULT: PASS — every registered adapter verified live from this egress');
  return 0;
}

process.exit(await main());
