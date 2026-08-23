import type {
  Currency,
  DeliveryType,
  SimulationResponse,
  SimulationResult,
} from '../types/remittance';
import { classifyStaleness } from './observedRates';
import { getCurrency } from './currencies';

/**
 * ============================================================================
 *  COMPARISON-TABLE RENDERER (single source of truth)
 * ============================================================================
 *
 * Produces the IDR-first comparison table as an HTML string. Used by BOTH:
 *   • src/pages/index.astro — server-renders the first paint (works without
 *     JS, wired through the observed-rate read-through resolver), and
 *   • src/scripts/simulator.ts — re-renders client-side when the user clicks
 *     Compare (or presses Enter).
 *
 * Pure string building — no DOM access — so it runs identically in the SSR
 * worker and the browser.
 */

/** Manual entries older than this render "(outdated)". */
const MANUAL_OUTDATED_MS = 7 * 24 * 60 * 60 * 1000;

const DELIVERY_LABELS: Record<DeliveryType, string> = {
  bank: 'Bank',
  cash: 'Cash',
  wallet: 'Wallet',
};

const TAG_META: Record<string, { label: string; classes: string }> = {
  'best-value': {
    label: '★ Best Value',
    classes: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
  },
  fastest: {
    label: '⚡ Fastest',
    classes: 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300',
  },
  'lowest-fee': {
    label: '¥ Lowest Fee',
    classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  },
};

// --- formatting helpers --------------------------------------------------------

const fmtJPY = (n: number) => '¥' + Math.round(n).toLocaleString('en-US');

function fmtForeign(n: number, currency: Currency): string {
  const num = n.toLocaleString('en-US', {
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals,
  });
  return `${currency.symbol}${num}`;
}

const fmtPct = (frac: number) => (frac * 100).toFixed(2) + '%';

export function fmtRate(rate: number): string {
  if (rate >= 100) return rate.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (rate >= 1) return rate.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return rate.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function timeAgo(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} mins ago`;
  const hrs = Math.round(mins / 60);
  if (hrs === 1) return '1 hr ago';
  if (hrs < 48) return `${hrs} hrs ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

// --- provenance / staleness badges ----------------------------------------------

/**
 * Per-row provenance badge driven by `rateSource` + the staleness classifier:
 *   observed fresh  → "Observed · 3 hrs ago"   (green dot)
 *   observed stale  → same + amber "stale" marker (12–24 h band)
 *   manual          → "Manual · updated 2026-08-20" (+ amber stale marker,
 *                     + "(outdated)" once older than 7 days)
 *   modeled         → "Estimated"
 */
export function renderProvenanceBadge(r: SimulationResult, now = Date.now()): string {
  const rs = r.rateSource;

  if (rs.kind === 'modeled') {
    return `<span class="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">Estimated</span>`;
  }

  const staleness = classifyStaleness(rs.fetchedAt, now);
  const staleMarker =
    staleness === 'stale'
      ? '<span class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">stale</span>'
      : '';

  if (rs.kind === 'observed') {
    const age = rs.fetchedAt ? timeAgo(rs.fetchedAt, now) : '';
    return `<span class="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>Observed${age ? ` · ${age}` : ''}</span>${staleMarker}`;
  }

  // manual
  const date = (rs.fetchedAt ?? '').slice(0, 10) || 'unknown date';
  const t = rs.fetchedAt ? Date.parse(rs.fetchedAt) : NaN;
  const outdated =
    Number.isFinite(t) && now - t >= MANUAL_OUTDATED_MS
      ? ' <span class="text-amber-600 dark:text-amber-400">(outdated)</span>'
      : '';
  return `<span class="inline-flex items-center gap-1 rounded-md bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">Manual · updated ${esc(date)}</span>${staleMarker}${outdated}`;
}

function renderPromoBadge(): string {
  return `<span class="rounded-md bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">Promo — new customers only</span>`;
}

function renderTag(tag: string): string {
  const meta = TAG_META[tag];
  if (!meta) return '';
  return `<span class="rounded-md px-2 py-0.5 text-[11px] font-semibold ${meta.classes}">${meta.label}</span>`;
}

/** vs-mid-market chip for the rate cell. */
function renderDeltaChip(markupPct: number): string {
  if (markupPct <= 0) {
    return '<span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">mid-market ✓</span>';
  }
  return `<span class="rounded px-1.5 py-0.5 text-[11px] font-semibold ${
    markupPct <= 0.015
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
      : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
  }">${fmtPct(-markupPct)} vs mid</span>`;
}

// --- table ---------------------------------------------------------------------

function breakdownRow(label: string, value: string, hint?: string, strong = false): string {
  return `
    <div class="flex items-baseline justify-between gap-4">
      <span class="text-slate-500 dark:text-slate-400">${label}${hint ? ` <span class="text-slate-400">(${hint})</span>` : ''}</span>
      <span class="${strong ? 'font-bold text-slate-900 dark:text-slate-100' : 'font-medium'} tabular-nums">${value}</span>
    </div>`;
}

function renderProviderRow(
  r: SimulationResult,
  currency: Currency,
  isTop: boolean,
  now: number
): string {
  const tags = r.tags.map(renderTag).join(' ');
  const rowFrame = isTop ? 'bg-emerald-50/50 dark:bg-emerald-950/20' : '';
  const payoutColor = isTop
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-slate-900 dark:text-slate-100';
  const quoteFootnote =
    r.rateSource.quoteAmountJPY !== undefined
      ? `<div class="text-[10px] text-slate-400">quoted at ${fmtJPY(r.rateSource.quoteAmountJPY)}</div>`
      : '';
  const markupHint =
    r.rateSource.kind === 'observed'
      ? 'observed'
      : r.rateSource.kind === 'manual'
        ? 'manual rate'
        : 'estimated';

  return `
  <tr class="border-b border-slate-100 transition hover:bg-slate-50/70 dark:border-slate-800 dark:hover:bg-slate-800/40 ${rowFrame}">
    <td class="px-3 py-3">
      <div class="flex items-start gap-2.5">
        <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold text-slate-900 shadow-sm" style="background:${r.brandColor}">${esc(r.logoText)}</div>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="font-semibold">${esc(r.providerName)}</span>${tags}
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-1.5">
            ${renderProvenanceBadge(r, now)}
            ${r.rateSource.isPromo ? renderPromoBadge() : ''}
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
            ${r.deliveryTypes.map((d) => `<span class="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">${DELIVERY_LABELS[d]}</span>`).join('')}
            <span class="text-slate-300 dark:text-slate-600">·</span>
            <span>${esc(r.speedLabel)}</span>
          </div>
        </div>
      </div>
    </td>
    <td class="px-3 py-3 text-right">
      <div class="text-base font-bold tabular-nums ${payoutColor}">${fmtForeign(r.receiveAmount, currency)}</div>
      <div class="text-[11px] text-slate-400">${currency.code}</div>
    </td>
    <td class="px-3 py-3 text-right">
      <div class="text-sm font-semibold tabular-nums">1 ¥ = ${fmtRate(r.appliedRate)}</div>
      <div class="mt-0.5 flex justify-end">${renderDeltaChip(r.markupPct)}</div>
      ${quoteFootnote}
    </td>
    <td class="px-3 py-3 text-right text-sm font-semibold tabular-nums">${fmtJPY(r.feeJPY)}</td>
    <td class="px-3 py-3 text-right text-sm font-semibold tabular-nums">${fmtJPY(r.netCostJPY)}</td>
    <td class="px-2 py-3 text-center">
      <button type="button" data-toggle="${esc(r.providerId)}" aria-label="Toggle breakdown for ${esc(r.providerName)}"
              class="rounded-lg p-1.5 text-indigo-600 transition hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40">
        <svg class="h-4 w-4 transition-transform" data-chevron viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </td>
  </tr>
  <tr data-panel="${esc(r.providerId)}" hidden>
    <td colspan="6" class="border-b border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/50">
      <div class="grid gap-6 md:grid-cols-2">
        <div class="space-y-1.5 text-sm">
          ${breakdownRow('Mid-market rate', `1 JPY = ${fmtRate(r.midMarketRate)} ${currency.code}`)}
          ${breakdownRow('Rate you get', `1 JPY = ${fmtRate(r.appliedRate)} ${currency.code}`, markupHint)}
          ${breakdownRow('Amount converted', fmtJPY(r.amountConvertedJPY), 'after upfront fee')}
          ${breakdownRow('Upfront transfer fee', fmtJPY(r.feeJPY))}
        </div>
        <div class="space-y-1.5 text-sm">
          ${breakdownRow('Hidden FX markup cost', fmtJPY(r.markupCostJPY), r.markupPct <= 0 ? `none vs mid · ${markupHint}` : `${fmtPct(r.markupPct)} · ${markupHint}`)}
          ${breakdownRow('Net effective cost', `${fmtJPY(r.netCostJPY)} (${fmtPct(r.netCostPct)})`, undefined, true)}
          ${r.rateSource.sourceLabel ? `<p class="pt-1 text-xs text-slate-400">Rate source: ${esc(r.rateSource.sourceLabel)}</p>` : ''}
          ${r.note ? `<p class="text-xs text-slate-500 dark:text-slate-400">${esc(r.note)}</p>` : ''}
          <a href="${r.website}" target="_blank" rel="noopener noreferrer"
             class="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">Visit ${esc(r.providerName)} ↗</a>
        </div>
      </div>
    </td>
  </tr>`;
}

/** The full comparison table (header + one row per provider). */
export function renderResultsTable(data: SimulationResponse, now = Date.now()): string {
  const currency = getCurrency(data.meta.targetCurrency);
  const { results } = data;

  if (!results.length) {
    return `<div class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      No providers support ${currency.code} with this receiving method.
    </div>`;
  }

  const rows = results.map((r, i) => renderProviderRow(r, currency, i === 0, now)).join('');

  return `
  <div class="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
    <table class="w-full min-w-[760px] border-collapse text-sm">
      <thead>
        <tr class="border-b border-slate-200 bg-slate-50/80 text-left text-[11px] uppercase tracking-wide text-slate-400 dark:border-slate-800 dark:bg-slate-950/40">
          <th class="px-3 py-2.5 font-medium">Service</th>
          <th class="px-3 py-2.5 text-right font-medium">Recipient gets</th>
          <th class="px-3 py-2.5 text-right font-medium">Exchange rate</th>
          <th class="px-3 py-2.5 text-right font-medium">Upfront fee</th>
          <th class="px-3 py-2.5 text-right font-medium">Net cost</th>
          <th class="px-2 py-2.5 font-medium"><span class="sr-only">Breakdown</span></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/** Meta line above the table: counts, coverage, rate-table provenance. */
export function renderResultsMeta(data: SimulationResponse, now = Date.now()): string {
  const { meta } = data;
  if (!data.results.length) return 'No services match — try another amount.';

  const source = meta.ratesSource === 'fallback' ? 'offline estimate' : meta.ratesSource;
  const cov = meta.observedCoverage;
  const coverage =
    `${cov.observed} observed` +
    (cov.manual > 0 ? ` · ${cov.manual} manual` : '') +
    ` · ${cov.modeled} estimated`;
  const errors =
    meta.fetchErrors && Object.keys(meta.fetchErrors).length > 0
      ? ` · ${Object.keys(meta.fetchErrors).length} source${Object.keys(meta.fetchErrors).length === 1 ? '' : 's'} failed`
      : '';
  return `${data.results.length} services · ranked by real payout · ${coverage} · mid-market ${timeAgo(meta.ratesFetchedAt, now)} (${source})${errors}`;
}

/** Mid-market reference line under the amount input. */
export function renderRateLine(data: SimulationResponse): string {
  const code = data.meta.targetCurrency;
  if (data.meta.midMarketRate <= 0) return `Rate unavailable for ${code}.`;
  const weekend = data.meta.isJapanWeekend ? ' · weekend FX rules applied' : '';
  return `Mid-market: 1 JPY = ${fmtRate(data.meta.midMarketRate)} ${code}${weekend}`;
}
