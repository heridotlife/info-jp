/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

// Bindings available on the Cloudflare runtime.
// Add new bindings (D1, R2, secrets…) here as you introduce them.
interface Env {
  /** KV namespace caching mid-market FX rates. See src/lib/rates.ts. */
  RATES_KV?: KVNamespace;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  // `Astro.locals.runtime.env.RATES_KV` and friends are typed via this.
  type Locals = Runtime;
}
