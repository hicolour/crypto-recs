/// <reference types=\"@cloudflare/workers-types\" />

/**
 * Cloudflare Worker with both `fetch` and `scheduled` handlers.
 * Option A: Adds a `scheduled()` handler so cron triggers stop failing.
 *
 * Replace `handleFetch()` and `runCron()` bodies with your app logic.
 */

export interface Env {
  // --- Add your bindings here, keep them optional so this file compiles either way ---
  // DB?: D1Database;
  // KV?: KVNamespace;
  // BUCKET?: R2Bucket;
  // QUEUE?: Queue;
}

/**
 * Main HTTP request handler (plug your existing router/app here).
 */
async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { method } = request;
  const url = new URL(request.url);

  // Simple health check route (useful for uptime monitors)
  if (url.pathname === "/health") {
    return new Response("ok", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // TODO: Replace this placeholder with your existing fetch/router logic.
  return new Response(
    JSON.stringify({
      message: "Worker is running. Replace handleFetch() with your app's logic.",
      method,
      path: url.pathname,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }
  );
}

/**
 * Periodic job body — put your cron work here (e.g., refresh caches, clean KV, etc.).
 * This is called by the `scheduled()` handler via `ctx.waitUntil()`.
 */
async function runCron(env: Env): Promise<void> {
  // Example no-op: do your maintenance here.
  // If you have a KV binding, you could record last run:
  // await env.KV?.put("last_cron_run", new Date().toISOString());

  // Simulate useful async work (remove in production)
  // await new Promise((r) => setTimeout(r, 10));
}

/**
 * Module Worker export with both handlers.
 */
export default {
  /**
   * HTTP requests entrypoint
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleFetch(request, env, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },

  /**
   * Cron triggers entrypoint
   *
   * Ensure you have a cron set in `wrangler.toml` or the Dashboard, e.g.:
   * [triggers]
   * crons = ["*/15 * * * *"]
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Optional: inspect which schedule fired -> event.cron
    // console.log("Cron fired:", event.cron, "at", new Date(event.scheduledTime).toISOString());

    // Fire-and-forget your periodic job
    ctx.waitUntil(runCron(env));
  },
};
