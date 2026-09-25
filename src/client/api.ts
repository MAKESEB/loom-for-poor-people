export interface Recording {
  id: string;
  title: string;
  durationSeconds: number;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
  videoUrl: string;
  sharePath: string;
  isOwner: boolean;
  protected: boolean;
  markdownEnabled: boolean;
  markdownEligible?: boolean;
  maxMarkdownBytes?: number;
}

export type RecordingView = 'public' | 'manage';

export interface MarkdownResult {
  enabled: boolean;
  status: 'idle' | 'queued' | 'uploading' | 'processing' | 'submitting' | 'generating' | 'completed' | 'failed' | 'uncertain';
  markdown: string | null;
  error?: string;
  jobId?: string;
}

export interface Upload {
  id?: string;
  uploadId: string;
  uploadUrl: string | null;
  alreadyUploaded?: boolean;
  headers?: Record<string, string>;
  chunkSizeBytes?: number;
  partCount?: number;
}

export class ApiError extends Error {
  constructor(message: string, public readonly code: string | null = null, public readonly status = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

function reportExpiredSession(status: number, code?: string | null) {
  if (status === 401 && code !== 'invalid_access_code') window.dispatchEvent(new Event('slop-rooster:session-expired'));
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...init?.headers } });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    let message = response.status === 404 ? 'This recording couldn’t be found.' : 'Something went wrong. Please try again.';
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error;
      if (typeof error === 'string') message = error;
      else if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') message = error.message;
    }
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : null;
    reportExpiredSession(response.status, code);
    throw new ApiError(message, code, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function recordingApiPath(id: string, action = '', token = '', view?: RecordingView) {
  const query = new URLSearchParams();
  if (token) query.set('token', token);
  if (view) query.set('view', view);
  const search = query.toString();
  return `/api/recordings/${encodeURIComponent(id)}${action ? `/${action}` : ''}${search ? `?${search}` : ''}`;
}

function uploadRequest(destination: URL, headers: Record<string, string>, blob: Blob, onProgress: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', destination.href);
    request.timeout = 15 * 60 * 1000;
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) request.setRequestHeader('Content-Type', blob.type);
    Object.entries(headers).forEach(([key, value]) => {
      if (key.toLowerCase() !== 'content-length') request.setRequestHeader(key, value);
    });
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(blob.size, event.loaded));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) { resolve(); return; }
      let message = 'The upload didn’t finish. Your recording is still here. Try again or download a copy.';
      let code: string | null = null;
      try {
        const body = JSON.parse(request.responseText) as { error?: unknown; code?: unknown };
        if (typeof body.error === 'string') message = body.error;
        if (typeof body.code === 'string') code = body.code;
      } catch { /* Keep a useful error for non-JSON proxy responses. */ }
      reportExpiredSession(request.status, code);
      reject(new ApiError(message, code, request.status));
    };
    request.onerror = () => reject(new ApiError('The connection was interrupted. Your recording is still here. Try again or download a copy.', 'upload_network_error'));
    request.ontimeout = () => reject(new ApiError('The upload took too long. Your recording is still here. Try again or download a copy.', 'upload_timeout', 408));
    request.onabort = () => reject(new Error('The upload was interrupted. Your recording is still here.'));
    request.send(blob);
  });
}

export async function uploadBlob(upload: Upload, blob: Blob, onProgress: (percent: number) => void): Promise<void> {
  if (!upload.uploadUrl) throw new Error('No upload destination is available. Your recording is still here.');
  const destination = new URL(upload.uploadUrl, window.location.origin);
  if (destination.origin !== window.location.origin) throw new Error('The upload destination is invalid. Please try again.');
  const headers = upload.headers ?? {};
  const reportProgress = (bytes: number) => onProgress(Math.min(100, Math.round(bytes / blob.size * 100)));
  if (upload.chunkSizeBytes === undefined && upload.partCount === undefined) {
    await uploadRequest(destination, headers, blob, reportProgress);
    onProgress(100);
    return;
  }

  const chunkSize = upload.chunkSizeBytes;
  const partCount = upload.partCount;
  if (!Number.isSafeInteger(chunkSize) || !chunkSize || chunkSize < 1 || !Number.isSafeInteger(partCount) || !partCount || partCount !== Math.ceil(blob.size / chunkSize)) {
    throw new Error('The upload could not be prepared. Your recording is still here. Please try again.');
  }
  for (let part = 0; part < partCount; part += 1) {
    const start = part * chunkSize;
    const slice = blob.slice(start, Math.min(start + chunkSize, blob.size), blob.type);
    const partDestination = new URL(destination);
    partDestination.searchParams.set('part', String(part));
    for (let attempt = 0; ; attempt += 1) {
      try {
        await uploadRequest(partDestination, headers, slice, (bytes) => reportProgress(start + bytes));
        reportProgress(start + slice.size);
        break;
      } catch (reason) {
        const transient = reason instanceof ApiError && (reason.code === 'upload_network_error' || [408, 425, 429, 500, 502, 503, 504].includes(reason.status));
        if (!transient || attempt >= 2) throw reason;
        // Parts are idempotent: replay only this slice after a bounded transient retry.
        reportProgress(start);
        await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 1500));
      }
    }
  }
  onProgress(100);
}
