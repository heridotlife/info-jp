#!/usr/bin/env node
// E2E local boot smoke — the bun-flavoured twin of heridotlife's
// scripts/e2e-local.mjs. Builds the site, boots it with `wrangler pages dev`
// (real workerd + Miniflare KV), runs a CI-safe HTTP smoke, and tears
// everything down. Used by the CI `e2e-local` job; also runnable locally.
//
// CI-safety: the only two real routes — `GET /` (SSR index) and
// `/api/simulate` — both cold-resolve FX rates from live provider endpoints
// when the KV cache is empty (as it is on every fresh boot). Calling them
// from CI would fetch live endpoints from shared runners: impolite and
// flaky. Instead the smoke asserts, against the booted server:
//
//   1. GET /favicon.svg → 200 — a static asset from the astro build output
//      (excluded from the worker in dist/_routes.json) is served.
//   2. GET /__e2e_missing_route__ → 404 — the request IS handled by the SSR
//      worker (matched by the `/*` include in _routes.json), proving the
//      built worker bundle boots and routes under workerd. No route matches,
//      so no page code runs and zero outbound fetches happen.
//
// Requires bun (project runtime) and node >= 18 (global fetch); no npm dependencies.

import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const PORT = 8788;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 60_000;

/** Run a command to completion, inheriting stdio; exit non-zero on failure. */
function run(cmd, args, label) {
  console.log(`▸ ${label}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    console.error(`✗ ${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/** Assert an HTTP response, returning the decoded JSON-free body. */
async function expectStatus(path, expected) {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: 'manual' });
  if (response.status !== expected) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GET ${path}: expected HTTP ${expected}, got ${response.status}. Body: ${body.slice(0, 300)}`,
    );
  }
  console.log(`✓ GET ${path} → ${response.status}`);
  return response;
}

async function main() {
  // 1. Build — this job is the CI build gate; there is no standalone build job.
  run('bun', ['run', 'build'], 'astro build');

  // 2. Boot the built Pages output. `detached: true` puts wrangler (and its
  //    workerd child) in their own process group so teardown can kill the
  //    whole tree — wrangler alone won't reap workerd.
  console.log(`▸ wrangler pages dev ./dist (port ${PORT})`);
  const server = spawn('bunx', ['wrangler', 'pages', 'dev', './dist', '--ip', '127.0.0.1', '--port', String(PORT)], {
    stdio: 'ignore', // wrangler's banner is noisy in CI logs; exit codes are the signal
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });

  server.on('error', (error) => {
    console.error(`✗ failed to spawn wrangler: ${error.message}`);
    process.exit(1);
  });

  const teardown = () => {
    try {
      process.kill(-server.pid, 'SIGTERM'); // negative pid = process group
    } catch {
      // Already gone — nothing to tear down.
    }
  };

  try {
    // 3. Wait for readiness: poll the static asset until the server answers
    //    (workerd boot + asset scan takes a few seconds).
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`server did not become ready within ${BOOT_TIMEOUT_MS / 1000}s`);
      }
      try {
        await fetch(`${BASE_URL}/favicon.svg`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // 4. Smoke assertions (see CI-safety note in the header).
    await expectStatus('/favicon.svg', 200);
    await expectStatus('/__e2e_missing_route__', 404);
    console.log('✓ e2e-local smoke passed');
  } finally {
    teardown();
  }
}

main();
