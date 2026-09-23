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
}

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

export function recordingApiPath(id: string, action = '', token = '') {
  return `/api/recordings/${encodeURIComponent(id)}${action ? `/${action}` : ''}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

export function uploadBlob(upload: Upload, blob: Blob, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!upload.uploadUrl) { reject(new Error('No upload destination is available. Your recording is still here.')); return; }
    const destination = new URL(upload.uploadUrl, window.location.origin);
    if (destination.origin !== window.location.origin) { reject(new Error('The upload destination is invalid. Please try again.')); return; }
    const request = new XMLHttpRequest();
    request.open('PUT', destination.href);
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
    request.onerror = () => reject(new Error('The connection was interrupted. Your recording is still here. Try again or download a copy.'));
    request.ontimeout = () => reject(new Error('The upload took too long. Your recording is still here. Try again or download a copy.'));
    request.onabort = () => reject(new Error('The upload was interrupted. Your recording is still here.'));
    request.send(blob);
  });
}
