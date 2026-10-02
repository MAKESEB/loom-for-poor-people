/**
 * Minimal structural views of the Cloudflare bindings this app uses.
 *
 * The real Workers binding types satisfy these interfaces; tests and local
 * tooling provide in-memory or node:sqlite fakes. Keeping the server code on
 * these narrow shapes lets every adapter be unit-tested without Miniflare.
 */

export type D1Value = string | number | null | ArrayBuffer;

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: D1Value[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
}

export interface R2RangeLike {
  offset: number;
  length: number;
}

export interface R2ObjectLike {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string, options?: { range?: R2RangeLike }): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string, options?: R2PutOptionsLike): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** The Workers static assets binding (wrangler.jsonc `assets.binding`). */
export interface AssetsFetcherLike {
  fetch(request: Request): Promise<Response>;
}

/** Bindings and settings from wrangler.jsonc and the Worker's secrets. */
export interface CloudflareEnvLike {
  /** Recordings, upload manifests, sharing settings and Markdown jobs (migrations-d1/). */
  DB?: D1DatabaseLike;
  /** Private video bytes, plus small upload transfer records under `_meta/` (src/server/r2-storage.ts). */
  RECORDINGS?: R2BucketLike;
  /** The Vite build in dist/, served for every path that is not /api/*. */
  ASSETS?: AssetsFetcherLike;
  /** Secret: the shared access code creators sign in with. */
  SLOP_ROOSTER_ACCESS_UUID?: string;
  /** Secret, at least 32 characters: signs creator session cookies. */
  APP_SESSION_SECRET?: string;
  /** Secret, at least 32 characters: signs the permanent viewing tokens of protected links. */
  SHARE_TOKEN_SECRET?: string;
  /** Optional secret: enables "Generate Markdown". Recording and sharing work without it. */
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

export interface ExecutionContextLike {
  waitUntil(task: Promise<unknown>): void;
}
