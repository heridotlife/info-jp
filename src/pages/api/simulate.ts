import type { APIRoute } from 'astro';
import { simulate } from '../../lib/remittanceCalculator';
import { getRates } from '../../lib/rates';
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
  const payload = simulate(input, rates);

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
