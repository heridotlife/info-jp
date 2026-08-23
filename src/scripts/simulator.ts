/**
 * Client-side controller for the remittance simulator.
 *
 * Responsibilities:
 *   • Hydrate from the server-rendered bootstrap JSON (no first-load fetch).
 *   • Wire up the amount / currency / delivery / theme controls.
 *   • Call GET /api/simulate on any change (debounced for typing).
 *   • Render the comparison cards — this file is the single source of truth for
 *     card markup, so the server just embeds data and lets us draw it.
 *
 * Framework-free on purpose: zero runtime deps keeps the page fast to load.
 */
import type {
  Currency,
  DeliveryFilter,
  DeliveryType,
  SimulationResponse,
  SimulationResult,
} from '../types/remittance';

interface Bootstrap {
  currencies: Currency[];
  initial: SimulationResponse;
  defaults: {
    amountJPY: number;
    targetCurrency: string;
    deliveryType: DeliveryFilter;
    min: number;
    max: number;
  };
}

// --- Bootstrap ---------------------------------------------------------------
const bootstrapEl = document.getElementById('bootstrap-data');
const boot: Bootstrap = JSON.parse(bootstrapEl?.textContent ?? '{}');
const currencyByCode = new Map(boot.currencies.map((c) => [c.code, c]));

const state = {
  amountJPY: boot.defaults.amountJPY,
  targetCurrency: boot.defaults.targetCurrency,
  deliveryType: boot.defaults.deliveryType,
};

// --- Element refs ------------------------------------------------------------
// No `extends HTMLElement` constraint: some element types (e.g. HTMLSelectElement)
// trip a structural-compatibility quirk in the DOM lib under this constraint.
const $ = <T = HTMLElement>(id: string) => document.getElementById(id) as T;
const amountInput = $<HTMLInputElement>('amount');
const currencySelect = $<HTMLSelectElement>('currency');
const quickAmounts = $('quick-amounts');
const deliveryToggle = $('delivery-toggle');
const resultsEl = $('results');
const rateLine = $('rate-line');
const resultsMeta = $('results-meta');
const loadingPill = $('loading-pill');
const themeToggle = $('theme-toggle');

// --- Formatting helpers ------------------------------------------------------
const fmtJPY = (n: number) => '¥' + Math.round(n).toLocaleString('en-US');

function fmtForeign(n: number, code: string): string {
  const c = currencyByCode.get(code as Currency['code']);
  const decimals = c?.decimals ?? 2;
  const num = n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${c?.symbol ?? ''}${num}`;
}

const fmtPct = (frac: number) => (frac * 100).toFixed(2) + '%';

function fmtRate(rate: number): string {
  if (rate >= 100) return rate.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (rate >= 1) return rate.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return rate.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} mins ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? '1 hr ago' : `${hrs} hrs ago`;
}

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

// --- Rendering ---------------------------------------------------------------
function renderTag(tag: string): string {
  const meta = TAG_META[tag];
  if (!meta) return '';
  return `<span class="rounded-md px-2 py-0.5 text-[11px] font-semibold ${meta.classes}">${meta.label}</span>`;
}

function renderCard(r: SimulationResult, code: string, isBest: boolean): string {
  const deliveryPills = r.deliveryTypes
    .map(
      (d) =>
        `<span class="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">${DELIVERY_LABELS[d]}</span>`,
    )
    .join('');

  const tags = r.tags.map(renderTag).join(' ');

  // Highlight the winning card (largest real payout) with a green frame.
  const frame = isBest
    ? 'border-emerald-400 ring-2 ring-emerald-400/40 dark:border-emerald-500'
    : 'border-slate-200 dark:border-slate-800';

  const payoutColor = isBest ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-900 dark:text-slate-100';

  // Exchange rate is the headline comparison metric. Show a delta-vs-mid-market
  // chip so rates are scannable across providers: green = mid-market,
  // amber = modest markup, rose = wide spread.
  const rateDelta = -r.markupPct; // provider's rate vs mid-market (negative = worse)
  const deltaChip =
    r.markupPct <= 0
      ? '<span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">mid-market ✓</span>'
      : `<span class="rounded px-1.5 py-0.5 text-[11px] font-semibold ${
          r.markupPct <= 0.015
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
            : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
        }">${fmtPct(rateDelta)} vs mid</span>`;

  const markupCell = r.markupPct <= 0 ? '0.00%' : fmtPct(r.markupPct);

  return `
  <article class="overflow-hidden rounded-2xl border bg-white shadow-sm transition dark:bg-slate-900 ${frame}">
    <div class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
      <!-- Left: identity -->
      <div class="flex min-w-0 items-start gap-3">
        <div class="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-sm font-bold text-slate-900 shadow-sm"
             style="background:${r.brandColor}">
          ${r.logoText}
        </div>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="truncate font-semibold">${r.providerName}</span>
            ${tags}
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            ${deliveryPills}
            <span class="text-slate-300 dark:text-slate-600">·</span>
            <span>${r.speedLabel}</span>
          </div>
        </div>
      </div>

      <!-- Right: payout -->
      <div class="shrink-0 text-left sm:text-right">
        <div class="text-[11px] uppercase tracking-wide text-slate-400">Recipient gets</div>
        <div class="text-xl font-bold tabular-nums ${payoutColor}">${fmtForeign(r.receiveAmount, code)}</div>
        <div class="text-[11px] text-slate-400">${code}</div>
      </div>
    </div>

    <!-- Exchange-rate bar — the headline comparison metric -->
    <div class="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-950/40">
      <span class="text-[11px] font-medium uppercase tracking-wide text-slate-400">Exchange rate</span>
      <span class="flex items-center gap-2">
        <span class="text-sm font-bold tabular-nums">1 ¥ = ${fmtRate(r.appliedRate)} ${code}</span>
        ${deltaChip}
      </span>
    </div>

    <!-- Stats strip -->
    <div class="grid grid-cols-3 divide-x divide-slate-100 border-t border-slate-100 text-center dark:divide-slate-800 dark:border-slate-800">
      <div class="px-2 py-2.5">
        <div class="text-[11px] text-slate-400">Upfront fee</div>
        <div class="text-sm font-semibold tabular-nums">${fmtJPY(r.feeJPY)}</div>
      </div>
      <div class="px-2 py-2.5">
        <div class="text-[11px] text-slate-400">Rate markup</div>
        <div class="text-sm font-semibold tabular-nums">${markupCell}</div>
      </div>
      <div class="px-2 py-2.5">
        <div class="text-[11px] text-slate-400">Net cost</div>
        <div class="text-sm font-semibold tabular-nums">${fmtJPY(r.netCostJPY)}</div>
      </div>
    </div>

    <!-- Expandable breakdown -->
    <button type="button" data-toggle="${r.providerId}"
            class="flex w-full items-center justify-center gap-1 border-t border-slate-100 py-2 text-xs font-medium text-indigo-600 transition hover:bg-slate-50 dark:border-slate-800 dark:text-indigo-400 dark:hover:bg-slate-800/50">
      <span>Full breakdown</span>
      <svg class="h-3.5 w-3.5 transition-transform" data-chevron viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div data-panel="${r.providerId}" hidden
         class="space-y-1.5 border-t border-slate-100 bg-slate-50 px-4 py-3 text-sm dark:border-slate-800 dark:bg-slate-950/50">
      ${breakdownRow('Mid-market rate', `1 JPY = ${fmtRate(r.midMarketRate)} ${code}`)}
      ${breakdownRow('Rate you get', `1 JPY = ${fmtRate(r.appliedRate)} ${code}`)}
      ${breakdownRow('Amount converted', fmtJPY(r.amountConvertedJPY), 'after upfront fee')}
      ${breakdownRow('Upfront transfer fee', fmtJPY(r.feeJPY))}
      ${breakdownRow('Hidden FX markup cost', fmtJPY(r.markupCostJPY), r.markupPct <= 0 ? 'none — mid-market' : fmtPct(r.markupPct))}
      ${breakdownRow('Net effective cost', `${fmtJPY(r.netCostJPY)} (${fmtPct(r.netCostPct)})`, undefined, true)}
      ${r.note ? `<p class="pt-1 text-xs text-slate-500 dark:text-slate-400">${r.note}</p>` : ''}
      <a href="${r.website}" target="_blank" rel="noopener noreferrer"
         class="mt-1 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
        Visit ${r.providerName} ↗
      </a>
    </div>
  </article>`;
}

function breakdownRow(label: string, value: string, hint?: string, strong = false): string {
  return `
    <div class="flex items-baseline justify-between gap-4">
      <span class="text-slate-500 dark:text-slate-400">${label}${hint ? ` <span class="text-slate-400">(${hint})</span>` : ''}</span>
      <span class="${strong ? 'font-bold' : 'font-medium'} tabular-nums ${strong ? 'text-slate-900 dark:text-slate-100' : ''}">${value}</span>
    </div>`;
}

function renderResults(data: SimulationResponse): void {
  const { meta, results } = data;
  const code = meta.targetCurrency;

  // Rate line under the currency picker.
  if (meta.midMarketRate > 0) {
    const weekend = meta.isJapanWeekend ? ' · weekend FX rules applied' : '';
    rateLine.textContent = `Mid-market: 1 JPY = ${fmtRate(meta.midMarketRate)} ${code}${weekend}`;
  } else {
    rateLine.textContent = 'Rate unavailable for this currency.';
  }

  // Meta line above the results.
  const source = meta.ratesSource === 'fallback' ? 'offline estimate' : meta.ratesSource;
  resultsMeta.textContent = results.length
    ? `${results.length} services · ranked by real payout · rates ${timeAgo(meta.ratesFetchedAt)} (${source})`
    : 'No services match this currency + method combination.';

  if (!results.length) {
    resultsEl.innerHTML = `
      <div class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        No providers support ${code} with this receiving method. Try switching the method to “All”.
      </div>`;
    return;
  }

  const bestId = results[0]?.providerId; // sorted best-payout first
  resultsEl.innerHTML = results.map((r) => renderCard(r, code, r.providerId === bestId)).join('');
}

// --- Fetching ----------------------------------------------------------------
let inflight: AbortController | null = null;

async function runSimulation(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;

  loadingPill.classList.remove('hidden');
  loadingPill.classList.add('flex');
  resultsEl.style.opacity = '0.55';

  const params = new URLSearchParams({
    amountJPY: String(state.amountJPY),
    targetCurrency: state.targetCurrency,
    deliveryType: state.deliveryType,
  });

  try {
    const res = await fetch(`/api/simulate?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = (await res.json()) as SimulationResponse;
    renderResults(data);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return; // superseded by a newer request
    resultsMeta.textContent = 'Could not update — showing last known results.';
  } finally {
    if (inflight === controller) {
      inflight = null;
      loadingPill.classList.add('hidden');
      loadingPill.classList.remove('flex');
      resultsEl.style.opacity = '1';
    }
  }
}

// Debounce rapid typing on the amount field.
let debounceTimer: number | undefined;
function scheduleSimulation(delay = 0): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(runSimulation, delay);
}

// --- Control wiring ----------------------------------------------------------
function readAmount(): number {
  const n = Number(amountInput.value);
  if (!Number.isFinite(n)) return boot.defaults.amountJPY;
  return Math.min(Math.max(Math.round(n), boot.defaults.min), boot.defaults.max);
}

amountInput.addEventListener('input', () => {
  state.amountJPY = readAmount();
  scheduleSimulation(300);
});

// Snap to bounds and re-run immediately when the field loses focus.
amountInput.addEventListener('change', () => {
  state.amountJPY = readAmount();
  amountInput.value = String(state.amountJPY);
  scheduleSimulation(0);
});

quickAmounts.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-amount]');
  if (!btn) return;
  state.amountJPY = Number(btn.dataset.amount);
  amountInput.value = String(state.amountJPY);
  scheduleSimulation(0);
});

currencySelect.addEventListener('change', () => {
  state.targetCurrency = currencySelect.value;
  scheduleSimulation(0);
});

deliveryToggle.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-delivery]');
  if (!btn) return;
  state.deliveryType = btn.dataset.delivery as DeliveryFilter;
  deliveryToggle.querySelectorAll<HTMLElement>('[data-delivery]').forEach((el) => {
    el.setAttribute('aria-selected', el === btn ? 'true' : 'false');
  });
  scheduleSimulation(0);
});

// Expand/collapse breakdown (event delegation on the results container).
resultsEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-toggle]');
  if (!btn) return;
  const id = btn.dataset.toggle;
  const panel = resultsEl.querySelector<HTMLElement>(`[data-panel="${id}"]`);
  const chevron = btn.querySelector<SVGElement>('[data-chevron]');
  if (!panel) return;
  const isOpen = !panel.hidden;
  panel.hidden = isOpen;
  chevron?.classList.toggle('rotate-180', !isOpen);
});

// Theme toggle (persists preference; Layout applies it pre-paint next load).
themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  } catch {
    /* ignore */
  }
});

// --- Boot --------------------------------------------------------------------
// Render the server-computed results immediately (no network round-trip).
renderResults(boot.initial);
