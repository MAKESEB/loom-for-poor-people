import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { createLocalStorage } from './src/dev/local-storage';
import { createLocalRepository } from './src/dev/repository';
import { createApiHandler } from './src/server/api';
import { resolveAuthConfig } from './src/server/auth';
import { createJobService } from './src/server/jobs';

function localApi(environment: Record<string, string>): Plugin {
  return {
    name: 'slop-rooster-local-api',
    apply: 'serve',
    async configureServer(server) {
      const storage = createLocalStorage();
      // Vite reloads this config when server modules change. Reuse the database
      // instead of opening the same PGlite directory while its old WASM is closing.
      const localCache = globalThis as typeof globalThis & {
        __slopRoosterLocalRepository?: ReturnType<typeof createLocalRepository>;
      };
      const local = await (localCache.__slopRoosterLocalRepository ??= createLocalRepository());
      const markdown = environment.GEMINI_API_KEY?.trim() ? createJobService(local.repository, storage, {
        apiKey: environment.GEMINI_API_KEY ?? '', model: environment.GEMINI_MODEL,
        defer: task => { void task.catch(() => server.config.logger.error('Background job deferred to durable recovery.')); },
      }) : undefined;
      const handleApi = createApiHandler(storage, {
        repository: local.repository, auth: () => resolveAuthConfig(environment), markdown,
      });
      const timer = setInterval(() => {
        void markdown?.runPending().catch(() => server.config.logger.error('Background recovery will retry.'));
      }, 15_000);
      timer.unref();
      server.httpServer?.once('close', () => { clearInterval(timer); });
      server.middlewares.use(async (incoming, outgoing, next) => {
        const path = incoming.url ?? '/';
        if (!path.startsWith('/api/') && !path.startsWith('/__local_storage/')) return next();
        const origin = `http://${incoming.headers.host ?? '127.0.0.1:5173'}`;
        storage.setOrigin(origin);
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          const method = incoming.method ?? 'GET';
          const request = new Request(`${origin}${path}`, {
            method, headers,
            ...(method !== 'GET' && method !== 'HEAD' ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
          } as RequestInit);
          const response = path.startsWith('/__local_storage/') ? await storage.capabilityFetch(request) : await handleApi(request);
          outgoing.statusCode = response.status;
          response.headers.forEach((value, key) => outgoing.setHeader(key, value));
          if (!response.body) return outgoing.end();
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(outgoing);
        } catch {
          server.config.logger.error('Local API request failed.');
          outgoing.statusCode = 500;
          outgoing.setHeader('Content-Type', 'application/json');
          outgoing.end(JSON.stringify({ error: 'This request could not finish. Please try again.' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), localApi(loadEnv(mode, process.cwd(), ''))],
  resolve: { alias: { '@': resolve('src') } },
}));
