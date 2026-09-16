import { createApiHandler } from '../server/api';
import { resolveStorageRuntime, storageBindingDiagnostics } from '../server/storage';

export default {
  async fetch(request: Request, environment: Record<string, unknown>): Promise<Response> {
    return createApiHandler(() => resolveStorageRuntime(environment), {
      storageDiagnostics: () => storageBindingDiagnostics(environment),
    })(request);
  },
};
