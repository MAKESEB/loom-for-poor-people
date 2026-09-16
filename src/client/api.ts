export interface Recording {
  id: string;
  title: string;
  durationSeconds: number;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
  videoUrl: string;
  sharePath: string;
}

export interface Upload {
  id?: string;
  uploadId: string;
  uploadUrl: string | null;
  alreadyUploaded?: boolean;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(message: string, public readonly code: string | null = null) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    let message = response.status === 404 ? 'This recording couldn’t be found.' : 'Something went wrong. Please try again.';
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error;
      if (typeof error === 'string') message = error;
      else if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') message = error.message;
    }
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : null;
    throw new ApiError(message, code);
  }
  return response.json() as Promise<T>;
}

export function uploadBlob(upload: Upload, blob: Blob, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!upload.uploadUrl) { reject(new Error('Storage didn’t provide an upload destination. Please try saving again.')); return; }
    const request = new XMLHttpRequest();
    request.open('PUT', upload.uploadUrl);
    request.timeout = 15 * 60 * 1000;
    const headers = upload.headers ?? {};
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) request.setRequestHeader('Content-Type', blob.type);
    Object.entries(headers).forEach(([key, value]) => {
      if (key.toLowerCase() !== 'content-length') request.setRequestHeader(key, value);
    });
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error('The upload didn’t finish. Your recording is still here. Please try saving again.'));
    };
    request.onerror = () => reject(new Error('Couldn’t reach storage. Check your connection and try saving again. Your recording is still here.'));
    request.ontimeout = () => reject(new Error('The upload took too long. Your recording is still here. Please try saving again.'));
    request.onabort = () => reject(new Error('The upload was interrupted. Your recording is still here.'));
    request.send(blob);
  });
}
