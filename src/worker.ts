// src/worker.ts
// Cloudflare Worker with both fetch() and scheduled() handlers.
// Fixes "Handler does not export a scheduled() function" by exporting it explicitly.
// Replace the stubbed logic inside runCron() with your project's real recomputation logic.

import type { ExportedHandler } from 'cloudflare:workers'

export interface Env {
  RECO_CACHE: KVNamespace
  DATA_API_URL?: string
  API_KEY?: string // optional: used to secure the manual /run-cron endpoint
}

async function runCron(env: Env): Promise<void> {
  // TODO: pull fresh data, recompute signals, store results, etc.
  const now = new Date().toISOString()

  // Example heartbeat payload — replace with your real work
  const payload = { ok: true, ranAt: now }

  // Persist something so you can confirm the cron is running
  await env.RECO_CACHE.put('cron:lastRun', now)
  await env.RECO_CACHE.put('cron:status', JSON.stringify(payload))
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // Optional: manually trigger the cron by POSTing to /run-cron
    if (url.pathname === '/run-cron' && request.method === 'POST') {
      const key = request.headers.get('x-cron-key')
      if (env.API_KEY && key !== env.API_KEY) {
        return new Response('Unauthorized', { status: 401 })
      }
      await runCron(env)
      return new Response('Cron executed', { status: 200 })
    }

    // Optional: quick status check
    if (url.pathname === '/cron-status') {
      const lastRun = await env.RECO_CACHE.get('cron:lastRun')
      const statusStr = await env.RECO_CACHE.get('cron:status')
      const status = statusStr ? JSON.parse(statusStr) : null
      return new Response(JSON.stringify({ lastRun, status }), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      })
    }

    return new Response('OK', { status: 200 })
  },

  // This is the key bit: export a scheduled() handler for cron triggers
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env))
  }
}

export default worker
