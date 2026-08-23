/**
 * Scheduled Cron Worker — keeps the RATES_KV cache warm.
 *
 * Cloudflare *Pages Functions* cannot register cron triggers, so the lazy
 * read-through cache in src/lib/rates.ts is the baseline. This optional
 * standalone Worker complements it: it refreshes the same KV entry on a
 * schedule so end-user requests are always served from a warm cache and never
 * pay the upstream latency.
 *
 * Deploy separately (it shares the RATES_KV namespace with the Pages app):
 *   cd workers/rate-refresh && npx wrangler deploy
 */
import { refreshRates } from '../../../src/lib/rates';

export interface Env {
  RATES_KV: KVNamespace;
}

export default {
  // Runs on the cron schedule defined in wrangler.toml.
  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(refreshRates(env.RATES_KV));
  },

  // Manual trigger for testing: `curl https://<worker>.workers.dev`.
  async fetch(_request, env): Promise<Response> {
    const table = await refreshRates(env.RATES_KV);
    return Response.json({ ok: true, refreshed: table.fetchedAt, source: table.source });
  },
} satisfies ExportedHandler<Env>;
