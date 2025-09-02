// src/worker.ts
// Cloudflare Worker with safe guards for missing KV binding (RECO_CACHE).
// Adds /env-check and clearer error messages to avoid "Cannot read properties of undefined (reading 'put')".

import type { ExportedHandler } from 'cloudflare:workers'

export interface Env {
  RECO_CACHE?: KVNamespace
  DATA_API_URL?: string
  API_KEY?: string
}

function kvRequired(env: Env): asserts env is Required<Pick<Env, 'RECO_CACHE'>> & Env {
  if (!env.RECO_CACHE) {
    throw new Error(
      'KV binding RECO_CACHE is not configured. Add [[kv_namespaces]] with binding = "RECO_CACHE" in wrangler.toml and set id/preview_id.'
    )
  }
}

async function runCron(env: Env): Promise<{ ok: boolean; ranAt: string }> {
  const now = new Date().toISOString()

  // If KV is missing, fail fast with a helpful message (and no crash)
  if (!env.RECO_CACHE) {
    console.error('RECO_CACHE not bound. Skipping KV writes.')
    return { ok: false, ranAt: now }
  }

  const payload = { ok: true, ranAt: now }
  await env.RECO_CACHE.put('cron:lastRun', now)
  await env.RECO_CACHE.put('cron:status', JSON.stringify(payload))
  return payload
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/run-cron' && request.method === 'POST') {
      const key = request.headers.get('x-cron-key')
      if (env.API_KEY && key !== env.API_KEY) {
        return new Response('Unauthorized', { status: 401 })
      }
      const result = await runCron(env)
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    if (url.pathname === '/cron-status') {
      if (!env.RECO_CACHE) {
        return new Response(
          JSON.stringify({ error: 'RECO_CACHE KV is not configured' }),
          { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } }
        )
      }
      const lastRun = await env.RECO_CACHE.get('cron:lastRun')
      const statusStr = await env.RECO_CACHE.get('cron:status')
      const status = statusStr ? JSON.parse(statusStr) : null
      return new Response(JSON.stringify({ lastRun, status }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    if (url.pathname === '/env-check') {
      // Do NOT leak secrets. Only boolean presence flags.
      const info = {
        hasKV: !!env.RECO_CACHE,
        hasDataApiUrl: !!env.DATA_API_URL,
        hasApiKeySet: !!env.API_KEY,
      }
      return new Response(JSON.stringify(info), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    return new Response('OK', { status: 200 })
  },

  async scheduled(_controller, env, ctx) {
    // Run cron work but don't crash if KV is missing
    ctx.waitUntil(runCron(env))
  },
}

export default worker
