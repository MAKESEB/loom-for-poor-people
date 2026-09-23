import { createApiHandler } from '../server/api';
import { resolveAuthConfig } from '../server/auth';
import { createJobService } from '../server/jobs';
import { resolveRepository } from '../server/repository';
import { resolveStorageRuntime } from '../server/storage';

interface ExecutionContext { waitUntil(task: Promise<unknown>): void }

function services(environment: Record<string, unknown>, context?: ExecutionContext) {
  const storage = resolveStorageRuntime(environment);
  const repository = resolveRepository(environment);
  const markdown = typeof environment.GEMINI_API_KEY === 'string' && environment.GEMINI_API_KEY.trim() ? createJobService(repository, storage, {
    apiKey: typeof environment.GEMINI_API_KEY === 'string' ? environment.GEMINI_API_KEY : '',
    model: typeof environment.GEMINI_MODEL === 'string' ? environment.GEMINI_MODEL : undefined,
    ...(context ? { defer: (task: Promise<unknown>) => context.waitUntil(task.catch(() => {
      console.error('Background job deferred to durable recovery.');
    })) } : {}),
  }) : undefined;
  return { storage, repository, markdown };
}

export default {
  async fetch(request: Request, environment: Record<string, unknown>, context: ExecutionContext): Promise<Response> {
    let current: ReturnType<typeof services> | undefined;
    const get = () => current ??= services(environment, context);
    return createApiHandler(() => get().storage, {
      repository: () => get().repository,
      auth: () => resolveAuthConfig(environment),
      ...(environment.GEMINI_API_KEY ? { markdown: () => get().markdown! } : {}),
    })(request);
  },
  async scheduled(_controller: unknown, environment: Record<string, unknown>): Promise<void> {
    await services(environment).markdown?.runPending();
  },
};
