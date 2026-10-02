/**
 * Cloudflare Workers entry point (wrangler.jsonc `main`).
 *
 * - /api/* runs this Worker first (`assets.run_worker_first`) and is served by the
 *   app's Web-standard API handler (src/server/api.ts) through the composition
 *   root in src/server/cloudflare.ts.
 * - Everything else is the Vite build in dist/, served by Workers static assets
 *   with single-page-application fallback, so /v/<id> and /manage/<id> load the
 *   SPA. Static assets answer those requests without invoking this Worker; the
 *   ASSETS fallback below only covers requests that reach it anyway.
 * - The `*\/5 * * * *` cron runs durable Markdown recovery. The work is awaited
 *   directly: a scheduled handler's own promise gets the full invocation budget,
 *   while ctx.waitUntil() work is cancelled shortly after the handler returns.
 */
import { createCloudflareApp, type CloudflareApp } from './server/cloudflare';
import type { CloudflareEnvLike, ExecutionContextLike } from './server/cloudflare-types';

// Bindings are stable per isolate; reuse the app (and its lazily resolved
// repository and storage) instead of rebuilding it per request.
const apps = new WeakMap<object, CloudflareApp>();

function appFor(env: CloudflareEnvLike): CloudflareApp {
  let app = apps.get(env);
  if (!app) {
    app = createCloudflareApp(env);
    apps.set(env, app);
  }
  return app;
}

const worker = {
  async fetch(request: Request, env: CloudflareEnvLike, ctx: ExecutionContextLike): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) return appFor(env).fetch(request, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_controller: unknown, env: CloudflareEnvLike): Promise<void> {
    await appFor(env).scheduled();
  },
};

export default worker;
