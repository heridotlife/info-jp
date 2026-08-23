/**
 * Client-side controller for the remittance simulator (simplified IDR-first UI).
 *
 * The first comparison (¥100,000 → IDR) is server-rendered in index.astro as a
 * real table — this script only re-runs it when the user clicks Compare (or
 * presses Enter in the amount field). The UI layer hardcodes
 * `targetCurrency=IDR` + `deliveryType=all`: every verified rate and fee tier
 * is JPY→IDR, so other corridors would render mostly "Estimated" rows.
 * Internal multi-currency stays fully supported by /api/simulate + the
 * calculator; a picker can return later without touching them.
 *
 * Framework-free on purpose: zero runtime deps keeps the page fast to load.
 */
import type { SimulationResponse } from '../types/remittance';
import { renderRateLine, renderResultsMeta, renderResultsTable } from '../lib/renderResults';

interface Bootstrap {
  initial: SimulationResponse;
  defaults: {
    amountJPY: number;
    min: number;
    max: number;
  };
}

/** Fixed by the simplified UI (see header) — the API stays multi-currency. */
const TARGET_CURRENCY = 'IDR';
const DELIVERY_TYPE = 'all';

// --- Bootstrap ---------------------------------------------------------------
const bootstrapEl = document.getElementById('bootstrap-data');
const boot: Bootstrap = JSON.parse(bootstrapEl?.textContent ?? '{}');

// --- Element refs ------------------------------------------------------------
const $ = <T = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('compare-form');
const amountInput = $<HTMLInputElement>('amount');
const compareBtn = $<HTMLButtonElement>('compare-btn');
const resultsEl = $('results');
const rateLine = $('rate-line');
const resultsMeta = $('results-meta');
const themeToggle = $('theme-toggle');

// --- Fetch + render ----------------------------------------------------------

function render(data: SimulationResponse): void {
  rateLine.textContent = renderRateLine(data);
  resultsMeta.textContent = renderResultsMeta(data);
  resultsEl.innerHTML = renderResultsTable(data);
}

function setBusy(busy: boolean): void {
  compareBtn.disabled = busy;
  compareBtn.setAttribute('aria-busy', String(busy));
  compareBtn.querySelector('[data-label]')!.textContent = busy ? 'Comparing…' : 'Compare';
}

async function runSimulation(): Promise<void> {
  let amount = Number(amountInput.value);
  if (!Number.isFinite(amount)) amount = boot.defaults.amountJPY;
  amount = Math.min(Math.max(Math.round(amount), boot.defaults.min), boot.defaults.max);
  amountInput.value = String(amount);

  setBusy(true);
  resultsEl.style.opacity = '0.55';
  try {
    const params = new URLSearchParams({
      amountJPY: String(amount),
      targetCurrency: TARGET_CURRENCY,
      deliveryType: DELIVERY_TYPE,
    });
    const res = await fetch(`/api/simulate?${params}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    render((await res.json()) as SimulationResponse);
  } catch {
    resultsMeta.textContent = 'Could not update — showing last known results.';
  } finally {
    setBusy(false);
    resultsEl.style.opacity = '1';
  }
}

// Compare button + Enter in the amount field both submit the form.
form.addEventListener('submit', (e) => {
  e.preventDefault();
  void runSimulation();
});

// Expand/collapse the per-row breakdown (delegation covers both the
// server-rendered first paint and any client re-render).
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
// First paint is already server-rendered markup; nothing to do until the
// user asks for a new amount. (A stale first paint — e.g. rates older than
// the 12 h cache — refreshes on the first Compare click.)
