// NOTE: `// @ts-check` is intentionally omitted. `@tailwindcss/vite` is typed
// against a slightly different Vite version than the one Astro bundles, which
// produces a harmless type-skew error under `astro check` even though the build
// is correct. `defineConfig` still provides full editor autocompletion.
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // SSR on Cloudflare. Individual pages can opt back into static output with
  // `export const prerender = true`. The API route + index run on demand.
  output: 'server',

  adapter: cloudflare({
    // NOTE ON `mode: 'directory'`:
    // Older @astrojs/cloudflare (v7–v9) exposed a `mode: 'directory' | 'advanced'`
    // option. From v12 (the Astro 5 line) that option was removed — the adapter
    // always emits a directory-style `_worker.js/` bundle for Cloudflare Pages,
    // which is exactly what `mode: 'directory'` used to request. So there is
    // nothing extra to configure here; the output is directory mode by default.
    //
    // `platformProxy` boots a local Miniflare so `astro dev` can access your
    // Cloudflare bindings (KV, D1, etc.) declared in wrangler.jsonc.
    platformProxy: {
      enabled: true,
    },
    // Use Cloudflare's image resizing in production; noop-friendly locally.
    imageService: 'compile',
  }),

  vite: {
    plugins: [tailwindcss()],
  },
});
