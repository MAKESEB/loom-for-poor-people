import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { Readable } from 'node:stream';
import { createLocalStorage } from './src/dev/local-storage';
import { createApiHandler } from './src/server/api';

function localApi(): Plugin {
  return {
    name: 'little-loom-local-api',
    apply: 'serve',
    configureServer(server) {
      const runtime = createLocalStorage();
      const handleApi = createApiHandler(runtime);
      server.middlewares.use(async (incoming, outgoing, next) => {
        const path = incoming.url ?? '/';
        if (!path.startsWith('/api/') && !path.startsWith('/__local_storage/')) return next();
        const origin = `http://${incoming.headers.host ?? '127.0.0.1:5173'}`;
        runtime.setOrigin(origin);
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          const method = incoming.method ?? 'GET';
          const request = new Request(`${origin}${path}`, {
            method,
            headers,
            ...(method !== 'GET' && method !== 'HEAD' ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
          } as RequestInit);
          const response = path.startsWith('/__local_storage/') ? await runtime.capabilityFetch(request) : await handleApi(request);
          outgoing.statusCode = response.status;
          response.headers.forEach((value, key) => outgoing.setHeader(key, value));
          if (!response.body) return outgoing.end();
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(outgoing);
        } catch (error) {
          server.config.logger.error(error instanceof Error ? error.message : 'Local API failed');
          outgoing.statusCode = 500;
          outgoing.setHeader('Content-Type', 'application/json');
          outgoing.end(JSON.stringify({ error: 'The local storage request failed.' }));
        }
      });
    },
  };
}

export default defineConfig({ plugins: [react(), localApi()] });
