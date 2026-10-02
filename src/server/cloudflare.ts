import { createApiHandler } from './api';
import { resolveAuthConfig } from './auth';
import type { CloudflareEnvLike, D1DatabaseLike, ExecutionContextLike, R2BucketLike } from './cloudflare-types';
import { createD1Repository } from './d1-repository';
import { createJobService, type JobService, type JobServiceConfig } from './jobs';
import { createR2StorageRuntime } from './r2-storage';
import { DatabaseUnavailableError } from './repository';
import { StorageUnavailableError, type StorageRuntime } from './storage';
import type { Repository } from './types';

export interface CloudflareApp {
  /** Serves /api/* with the Web-standard API handler. */
  fetch(request: Request, ctx?: ExecutionContextLike): Promise<Response>;
  /** Durable Markdown recovery; the cron awaits it directly (waitUntil is cancelled too early). */
  scheduled(): Promise<void>;
}

export interface CloudflareAppOptions {
  /** Test seam for the Gemini client (an in-memory client or a fetch stub). */
  markdown?: Pick<JobServiceConfig, 'client' | 'fetch' | 'now'>;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return names.every(name => typeof candidate[name] === 'function');
}

const isDatabase = (value: unknown): value is D1DatabaseLike => hasMethods(value, ['prepare']);
const isBucket = (value: unknown): value is R2BucketLike => hasMethods(value, ['head', 'get', 'put', 'delete']);

/** Builds the repository from the Worker's D1 binding `env.DB`. */
export function resolveD1Repository(environment: Record<string, unknown>): Repository {
  const binding = environment.DB;
  if (!isDatabase(binding)) throw new DatabaseUnavailableError();
  return createD1Repository(binding);
}

/**
 * Private video storage on the R2 bucket `env.RECORDINGS`. The binding stays
 * server-side; capabilities are opaque grants that only capabilityFetch accepts.
 */
export function resolveR2StorageRuntime(environment: Record<string, unknown>): StorageRuntime {
  const bucket = environment.RECORDINGS;
  if (!isBucket(bucket)) throw new StorageUnavailableError();
  return createR2StorageRuntime(bucket);
}

/**
 * Composition root for the Cloudflare Worker, the counterpart of the ohmyho.st
 * API companion (src/ohmyhost/companion.ts).
 *
 * D1 (env.DB), R2 (env.RECORDINGS), the shared access UUID with signed session
 * cookies (SLOP_ROOSTER_ACCESS_UUID, APP_SESSION_SECRET, SHARE_TOKEN_SECRET) and
 * the optional Gemini key are wired into the same API handler and job service.
 * Bindings and secrets resolve lazily, so /api/config reports
 * `configured: false` instead of crashing when one is missing.
 */
export function createCloudflareApp(env: CloudflareEnvLike, options: CloudflareAppOptions = {}): CloudflareApp {
  const environment = env as Record<string, unknown>;
  let storage: StorageRuntime | undefined;
  let repository: Repository | undefined;
  const getStorage = () => (storage ??= resolveR2StorageRuntime(environment));
  const getRepository = () => (repository ??= resolveD1Repository(environment));

  const geminiEnabled = typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0;
  function markdownService(ctx?: ExecutionContextLike): JobService {
    const defer = ctx
      ? (task: Promise<unknown>) => ctx.waitUntil(task.catch(() => { console.error('Background job deferred to durable recovery.'); }))
      : undefined;
    return createJobService(getRepository(), getStorage(), {
      apiKey: typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY : '',
      model: typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim() ? env.GEMINI_MODEL : undefined,
      ...options.markdown,
      ...(defer ? { defer } : {}),
    });
  }

  return {
    async fetch(request, ctx) {
      let markdown: JobService | undefined;
      return createApiHandler(getStorage, {
        repository: getRepository,
        auth: () => resolveAuthConfig(environment),
        ...(geminiEnabled ? { markdown: () => (markdown ??= markdownService(ctx)) } : {}),
      })(request);
    },

    async scheduled() {
      if (!geminiEnabled) return;
      await markdownService().runPending();
    },
  };
}
