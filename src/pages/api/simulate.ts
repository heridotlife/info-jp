import type { APIRoute } from 'astro';
import { simulate } from '../../lib/remittanceCalculator';
import { getRates } from '../../lib/rates';
import { resolveObservedRates } from '../../lib/observedRates';
import { PROVIDERS } from '../../lib/providers';
import { inputFromSearchParams, parseSimulationInput } from '../../lib/simulationRequest';
import type { SimulationInput } from '../../types/remittance';

// This endpoint runs on demand (Cloudflare Pages Function) — never prerendered.
export const prerender = false;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Let the browser/edge reuse a response briefly. Matches the KV rate TTL.
  'cache-control': 'public, max-age=60, s-maxage=300',
};

/**
 * Shared handler for GET and POST.
 * Reads the `RATES_KV` binding off the Cloudflare runtime (present in prod and,
 * thanks to platformProxy, in `astro dev` too). Falls back gracefully when the
 * binding is missing — `getRates` will fetch live rates without caching.
 */
async function run(input: SimulationInput, locals: App.Locals): Promise<Response> {
  const kv = locals?.runtime?.env?.RATES_KV;
  const rates = await getRates(kv);

  // Observed rates for the providers that serve this corridor, read-through
  // KV (12 h TTL): warm requests make zero outbound fetches; a cold request
  // fans out the due adapters in parallel under an overall ~10 s budget.
  // Only corridor-eligible providers are resolved (subrequest budget).
  const corridorProviderIds = PROVIDERS.filter((p) => p.supportedCurrencies.includes(input.targetCurrency)).map(
    (p) => p.id,
  );
  const { byProvider, fetchErrors } = await resolveObservedRates(corridorProviderIds, kv, {
    midMarketRates: rates.rates,
  });

  const payload = simulate(input, rates, byProvider);
  if (Object.keys(fetchErrors).length > 0) {
    payload.meta.fetchErrors = fetchErrors;
  }

  return new Response(JSON.stringify(payload), { status: 200, headers: JSON_HEADERS });
}

/**
 * GET /api/simulate?amountJPY=100000&targetCurrency=IDR&deliveryType=all
 * Convenient for links, curl, and the client-side fetch.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const input = inputFromSearchParams(url.searchParams);
  return run(input, locals);
};

/**
 * POST /api/simulate
 * Body: { "amountJPY": 100000, "targetCurrency": "IDR", "deliveryType": "all" }
 */
export const POST: APIRoute = async ({ request, locals }) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Empty/invalid body → defaults kick in.
  }
  const input = parseSimulationInput(body);
  return run(input, locals);
};
