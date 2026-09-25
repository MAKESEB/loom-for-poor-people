import { fixedLengthBody } from './storage';
import { MAX_MARKDOWN_BYTES } from '../shared/policy';

const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com';
const API_BASE = `${GOOGLE_ORIGIN}/v1beta`;
const API_REVISION = '2026-05-20';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_INTERACTION_BYTES = 96 * 1024 * 1024;
const MAX_STRING_CHARACTERS = 256 * 1024;

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GOAL = 'Create a concise briefing in Markdown: a short summary, key points, and actionable next steps when present. Use the language spoken in the recording unless the requested goal specifies another language.';

export class GeminiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null = null,
    public readonly ambiguous = false,
  ) {
    // Provider response bodies, URLs and credentials must never reach logs or UI.
    super(status ? `Gemini request failed (${status}).` : 'Gemini could not finish this request.');
    this.name = 'GeminiError';
  }
}

export interface GeminiFile {
  name: string;
  uri: string;
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED';
}

export interface GeminiInteraction {
  id: string;
  status: string;
  markdown: string | null;
}

export interface GeminiClientConfig {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

export interface InlineVideo {
  sizeBytes: number;
  openBody: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
}

export type InteractionInput = { jobId: string; contentType: string; goal: string } & (
  { fileUri: string; inline?: never } | { inline: InlineVideo; fileUri?: never }
);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GeminiError('provider_response_invalid');
  return value as Record<string, unknown>;
}

function fileName(name: string): string {
  if (!/^files\/[a-zA-Z0-9._-]{1,200}$/.test(name)) throw new GeminiError('provider_file_invalid');
  return name;
}

function interactionId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,512}$/.test(id)) throw new GeminiError('provider_interaction_invalid');
  return id;
}

function googleUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new GeminiError('upload_destination_invalid'); }
  if (url.origin !== GOOGLE_ORIGIN || url.username || url.password || url.hash) throw new GeminiError('upload_destination_invalid');
  return url;
}

function parseFile(value: unknown): GeminiFile {
  const data = record(value);
  const name = fileName(typeof data.name === 'string' ? data.name : '');
  const uri = googleUrl(typeof data.uri === 'string' ? data.uri : '');
  if (uri.pathname !== `/v1beta/${name}` || uri.search) throw new GeminiError('provider_file_invalid');
  if (!['ACTIVE', 'PROCESSING', 'FAILED'].includes(String(data.state))) throw new GeminiError('provider_file_invalid');
  return { name, uri: uri.toString(), state: data.state as GeminiFile['state'] };
}

function parseInteraction(value: unknown): GeminiInteraction {
  const data = record(value);
  const id = interactionId(typeof data.id === 'string' ? data.id : '');
  if (typeof data.status !== 'string') throw new GeminiError('provider_response_invalid');
  const chunks: string[] = [];
  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (!step || typeof step !== 'object' || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const content of step.content) {
        if (content && content.type === 'text' && typeof content.text === 'string') chunks.push(content.text);
      }
    }
  }
  return { id, status: data.status, markdown: chunks.join('\n\n').trim() || null };
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GeminiError('provider_response_invalid');
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GeminiError('provider_response_too_large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof GeminiError) throw error;
    throw new GeminiError('provider_response_invalid');
  } finally { reader.releaseLock(); }
}

/** Google echoes inline media in user_input. Project oversized string values to
 * empty strings while streaming, so a 67 MiB echo never becomes a JS string.
 * Markdown output is capped at 16K tokens and safely fits the retained limit. */
async function readInteractionJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GeminiError('provider_response_invalid');
  const decoder = new TextDecoder();
  let bytes = 0;
  const projected: string[] = [];
  let projectedLength = 0;
  let inString = false;
  let escaped = false;
  let oversized = false;
  let tokenParts: string[] = [];
  let tokenLength = 0;
  const append = (text: string) => {
    projectedLength += text.length;
    if (projectedLength > MAX_RESPONSE_BYTES) throw new GeminiError('provider_response_too_large');
    if (text) projected.push(text);
  };
  const tokenPart = (text: string) => {
    if (oversized) return;
    tokenLength += text.length;
    if (tokenLength > MAX_STRING_CHARACTERS) { oversized = true; tokenParts = []; }
    else tokenParts.push(text);
  };
  const consume = (text: string) => {
    let offset = 0;
    while (offset < text.length) {
      if (!inString) {
        const quote = text.indexOf('"', offset);
        if (quote === -1) { append(text.slice(offset)); return; }
        append(text.slice(offset, quote));
        inString = true; escaped = false; oversized = false; tokenParts = ['"']; tokenLength = 1;
        offset = quote + 1;
      } else {
        const start = offset;
        while (offset < text.length) {
          const character = text.charCodeAt(offset++);
          if (escaped) escaped = false;
          else if (character === 92) escaped = true;
          else if (character === 34) {
            tokenPart(text.slice(start, offset));
            append(oversized ? '""' : tokenParts.join(''));
            inString = false; tokenParts = [];
            break;
          }
        }
        if (inString) tokenPart(text.slice(start, offset));
      }
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_INTERACTION_BYTES) throw new GeminiError('provider_response_too_large');
      for (let offset = 0; offset < chunk.value.length; offset += 65_536) {
        consume(decoder.decode(chunk.value.subarray(offset, offset + 65_536), { stream: true }));
      }
    }
    consume(decoder.decode());
    if (inString) throw new GeminiError('provider_response_invalid');
    return JSON.parse(projected.join(''));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof GeminiError) throw error;
    throw new GeminiError('provider_response_invalid');
  } finally { reader.releaseLock(); }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  return btoa(binary);
}

/** Encode at most 48 KiB at a time, carrying only the final 0–2 bytes. */
function inlineJsonBody(source: ReadableStream<Uint8Array>, prefix: Uint8Array, suffix: Uint8Array): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = source.getReader();
  let sourceDone = false;
  let started = false;
  async function* chunks() {
    started = true;
    try {
      yield prefix;
      let carry = new Uint8Array(0);
      while (true) {
        const next = await reader.read();
        if (next.done) { sourceDone = true; break; }
        let offset = 0;
        const input = next.value;
        if (carry.length) {
          const needed = Math.min(3 - carry.length, input.length);
          const joined = new Uint8Array(carry.length + needed);
          joined.set(carry); joined.set(input.subarray(0, needed), carry.length);
          offset = needed;
          if (joined.length < 3) { carry = joined; continue; }
          yield encoder.encode(base64(joined));
          carry = new Uint8Array(0);
        }
        while (input.length - offset >= 3) {
          const length = Math.min(49_152, Math.floor((input.length - offset) / 3) * 3);
          yield encoder.encode(base64(input.subarray(offset, offset + length)));
          offset += length;
        }
        carry = input.slice(offset);
      }
      if (carry.length) yield encoder.encode(base64(carry));
      yield suffix;
    } finally {
      if (!sourceDone) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() {
      if (!started) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      else await iterator.return(undefined);
    },
  }, { highWaterMark: 0 });
}

/** Restrict byte count while preserving backpressure; never assemble a video in memory. */
function countedStream(source: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  let length = 0;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > size || length > MAX_MARKDOWN_BYTES) throw new GeminiError('input_size_invalid');
      controller.enqueue(chunk);
    },
    flush() { if (length !== size) throw new GeminiError('input_size_invalid'); },
  }));
}

function openSource(openBody: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      settled = true;
      reject(new GeminiError('provider_upload_failed'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => openBody(signal)).then((stream) => {
      signal.removeEventListener('abort', abort);
      if (settled) { void stream.cancel().catch(() => undefined); return; }
      settled = true;
      resolve(stream);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      settled = true;
      reject(error);
    });
  });
}

export function createGeminiClient(config: GeminiClientConfig) {
  if (!config.apiKey?.trim()) throw new GeminiError('provider_unconfigured');
  const providerFetch = config.fetch ?? fetch;
  const requestTimeout = config.requestTimeoutMs ?? 15_000;
  const uploadTimeout = config.uploadTimeoutMs ?? 90_000;
  const headers = (extra?: HeadersInit) => {
    const result = new Headers(extra);
    result.set('x-goog-api-key', config.apiKey);
    result.set('Api-Revision', API_REVISION);
    return result;
  };

  async function request<T>(url: string, init: RequestInit | ((signal: AbortSignal) => Promise<RequestInit>), parse: (response: Response) => Promise<T>, options: { timeout?: number; creating?: boolean; allowMissing?: boolean } = {}): Promise<T> {
    googleUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout ?? requestTimeout);
    let body: BodyInit | null | undefined;
    try {
      const resolved = typeof init === 'function' ? await init(controller.signal) : init;
      body = resolved.body;
      // workerd only supports follow/manual. Reject non-2xx ourselves so neither
      // credentials nor the video body can be forwarded to a redirect destination.
      const response = await providerFetch(url, { ...resolved, headers: headers(resolved.headers), signal: controller.signal, redirect: 'manual' });
      if (!response.ok && !(options.allowMissing && response.status === 404)) {
        await response.body?.cancel();
        throw new GeminiError('provider_request_failed', response.status, Boolean(options.creating && (response.status >= 500 || response.status === 408 || (response.status >= 300 && response.status < 400))));
      }
      return await parse(response);
    } catch (error) {
      controller.abort();
      if (body instanceof ReadableStream && !body.locked) await body.cancel().catch(() => undefined);
      if (error instanceof GeminiError && (!options.creating || error.status !== null)) throw error;
      throw new GeminiError('provider_request_failed', null, Boolean(options.creating));
    } finally { clearTimeout(timer); }
  }

  async function uploadFile(input: { name?: string; displayName: string; contentType: string; sizeBytes: number; openBody: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>> }): Promise<GeminiFile> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_MARKDOWN_BYTES) throw new GeminiError('input_size_invalid');
    if (!['video/webm', 'video/mp4'].includes(input.contentType)) throw new GeminiError('input_type_invalid');
    const uploadUrl = await request(`${GOOGLE_ORIGIN}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(input.sizeBytes),
        'X-Goog-Upload-Header-Content-Type': input.contentType,
      },
      body: JSON.stringify({ file: { ...(input.name ? { name: fileName(input.name) } : {}), display_name: input.displayName } }),
    }, async (response) => {
      const destination = response.headers.get('X-Goog-Upload-URL');
      await response.body?.cancel();
      if (!destination) throw new GeminiError('upload_destination_invalid');
      const parsed = googleUrl(destination);
      if (!parsed.pathname.startsWith('/upload/')) throw new GeminiError('upload_destination_invalid');
      return parsed.toString();
    });

    // One timeout covers opening the fresh storage capability and streaming it to Google.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), uploadTimeout);
    let body: ReadableStream<Uint8Array> | undefined;
    try {
      body = fixedLengthBody(countedStream(await openSource(input.openBody, controller.signal), input.sizeBytes), input.sizeBytes);
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST', headers: headers({
          'content-type': input.contentType,
          'content-length': String(input.sizeBytes),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        }), body, duplex: 'half', signal: controller.signal, redirect: 'manual',
      };
      const response = await providerFetch(uploadUrl, init);
      if (!response.ok) {
        await response.body?.cancel();
        throw new GeminiError('provider_upload_failed', response.status);
      }
      const file = parseFile(record(await readJson(response)).file);
      if (input.name && file.name !== input.name) throw new GeminiError('provider_file_invalid');
      return file;
    } catch (error) {
      controller.abort();
      if (body && !body.locked) await body.cancel().catch(() => undefined);
      if (error instanceof GeminiError) throw error;
      throw new GeminiError('provider_upload_failed');
    } finally { clearTimeout(timer); }
  }

  const discard = async (response: Response) => { await response.body?.cancel(); };
  return {
    uploadFile,
    getFile: (name: string) => request(`${API_BASE}/${fileName(name)}`, { method: 'GET' }, async (response) => parseFile(await readJson(response))),
    deleteFile: (name: string) => request(`${API_BASE}/${fileName(name)}`, { method: 'DELETE' }, discard, { allowMissing: true }),
    createInteraction: (input: InteractionInput) => {
      if (!['video/webm', 'video/mp4'].includes(input.contentType)) throw new GeminiError('input_type_invalid');
      let video: Record<string, string>;
      if (input.inline) {
        if (!Number.isSafeInteger(input.inline.sizeBytes) || input.inline.sizeBytes <= 0 || input.inline.sizeBytes > MAX_MARKDOWN_BYTES) throw new GeminiError('input_size_invalid');
        video = { type: 'video', data: '', mime_type: input.contentType, processing: 'static' };
      } else {
        const uri = googleUrl(input.fileUri);
        if (!/^\/v1beta\/files\/[a-zA-Z0-9._-]+$/.test(uri.pathname) || uri.search) throw new GeminiError('provider_file_invalid');
        video = { type: 'video', uri: uri.toString(), mime_type: input.contentType, processing: 'agentic' };
      }
      const json = JSON.stringify({
          model: config.model?.trim() || DEFAULT_GEMINI_MODEL,
          background: true,
          store: true,
          system_instruction: 'Produce only Markdown grounded in the recording. Follow the requested goal and mark uncertainty. Unless the goal specifies otherwise, use the language spoken in the recording. Do not include HTML or a wrapping Markdown code fence.',
          input: [
            video,
            { type: 'text', text: input.goal.trim() || DEFAULT_GOAL },
          ],
          generation_config: { thinking_level: 'low', max_output_tokens: 16_384 },
          labels: { slop_rooster_job: input.jobId },
        });
      if (!input.inline) {
        return request(`${API_BASE}/interactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json }, async (response) => parseInteraction(await readInteractionJson(response)), { creating: true });
      }
      const inline = input.inline;
      const splitAt = json.indexOf('"data":""') + '"data":"'.length;
      const encoder = new TextEncoder();
      const prefix = encoder.encode(json.slice(0, splitAt));
      const suffix = encoder.encode(json.slice(splitAt));
      const length = prefix.byteLength + 4 * Math.ceil(inline.sizeBytes / 3) + suffix.byteLength;
      return request(`${API_BASE}/interactions`, async (signal) => {
        const source = countedStream(await openSource(inline.openBody, signal), inline.sizeBytes);
        const init: RequestInit & { duplex: 'half' } = {
          method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(length) },
          body: fixedLengthBody(inlineJsonBody(source, prefix, suffix), length), duplex: 'half',
        };
        return init;
      }, async (response) => parseInteraction(await readInteractionJson(response)), { creating: true, timeout: uploadTimeout });
    },
    getInteraction: (id: string) => request(`${API_BASE}/interactions/${interactionId(id)}`, { method: 'GET' }, async (response) => parseInteraction(await readInteractionJson(response)), { timeout: uploadTimeout }),
    cancelInteraction: (id: string) => request(`${API_BASE}/interactions/${interactionId(id)}/cancel`, { method: 'POST' }, discard, { allowMissing: true }),
    deleteInteraction: (id: string) => request(`${API_BASE}/interactions/${interactionId(id)}`, { method: 'DELETE' }, discard, { allowMissing: true }),
  };
}

export type GeminiClient = ReturnType<typeof createGeminiClient>;
