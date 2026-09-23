import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createGeminiClient, GeminiError } from '../src/server/gemini';

const API_KEY = 'test-gemini-key-must-stay-server-side';
const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com';
const FILE = {
  name: 'files/recording123',
  uri: `${GOOGLE_ORIGIN}/v1beta/files/recording123`,
  state: 'PROCESSING' as const,
};
const UPLOAD_URL = `${GOOGLE_ORIGIN}/upload/v1beta/files?upload_id=test-upload`;
const INTERACTION_INPUT = {
  jobId: 'ca445e32-0780-4202-a5f7-fc21a2b45eec',
  fileUri: FILE.uri,
  contentType: 'video/webm',
  goal: 'Write an exact transcript with timestamps.',
};

type FetchHandler = (request: Request, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const options = { ...init, ...(init?.body instanceof ReadableStream ? { duplex: 'half' } : {}) };
    return handler(new Request(input, options), init);
  }) as typeof fetch;
}

function bytesStream(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function uploadInput(sizeBytes = 4, openBody = async () => bytesStream(new Uint8Array([1, 2, 3, 4]))) {
  return { displayName: 'Screen recording', contentType: 'video/webm', sizeBytes, openBody };
}

async function assertProviderError(promise: Promise<unknown>, expected: { ambiguous: boolean; status?: number | null }) {
  await assert.rejects(promise, (error: unknown) => {
    assert(error instanceof GeminiError);
    assert.equal(error.ambiguous, expected.ambiguous);
    if ('status' in expected) assert.equal(error.status, expected.status);
    assert.equal(typeof error.code, 'string');
    assert(!error.message.includes(API_KEY), 'provider errors must not expose credentials');
    return true;
  });
}

test('Gemini uploads use the resumable protocol and transfer the original stream with its declared length', async () => {
  const requests: Request[] = [];
  let opened = false;
  let sourceRead = false;
  const client = createGeminiClient({
    apiKey: API_KEY,
    fetch: fakeFetch(async (request, init) => {
      requests.push(request);
      assert.equal(new URL(request.url).origin, GOOGLE_ORIGIN);
      assert(!request.url.includes(API_KEY));
      if (requests.length === 1) {
        assert.equal(request.method, 'POST');
        assert.equal(new URL(request.url).pathname, '/upload/v1beta/files');
        assert.equal(request.headers.get('x-goog-api-key'), API_KEY);
        assert.equal(request.headers.get('x-goog-upload-protocol'), 'resumable');
        assert.equal(request.headers.get('x-goog-upload-command'), 'start');
        assert.equal(request.headers.get('x-goog-upload-header-content-length'), '4');
        assert.equal(request.headers.get('x-goog-upload-header-content-type'), 'video/webm');
        assert.equal(opened, false, 'source storage is opened only after receiving an upload destination');
        const metadata = await request.json();
        assert.equal(metadata.file.display_name ?? metadata.file.displayName, 'Screen recording');
        return new Response(null, { headers: { 'x-goog-upload-url': UPLOAD_URL } });
      }
      assert.equal(request.url, UPLOAD_URL);
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('x-goog-upload-offset'), '0');
      assert.equal(request.headers.get('x-goog-upload-command'), 'upload, finalize');
      assert.equal(request.headers.get('content-length'), '4');
      assert(init?.body instanceof ReadableStream, 'video upload must remain a stream');
      assert.equal(opened, true);
      assert.equal(sourceRead, false, 'the complete source must not be buffered before uploading');
      assert.deepEqual([...new Uint8Array(await request.arrayBuffer())], [1, 2, 3, 4]);
      return Response.json({ file: FILE });
    }),
  });
  const result = await client.uploadFile(uploadInput(4, async () => {
    opened = true;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        sourceRead = true;
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    }, { highWaterMark: 0 });
  }));
  assert.deepEqual(result, FILE);
  assert.equal(requests.length, 2);
});

test('Gemini generation uses a background Interaction with video input, explicit goal and pinned API revision', async () => {
  const client = createGeminiClient({
    apiKey: API_KEY,
    fetch: fakeFetch(async (request) => {
      assert.equal(new URL(request.url).pathname, '/v1beta/interactions');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('x-goog-api-key'), API_KEY);
      assert.equal(request.headers.get('Api-Revision'), '2026-05-20');
      assert(!request.url.includes(API_KEY));
      const body = await request.json();
      assert.equal(body.model, 'gemini-3.8-flash');
      assert.equal(body.background, true);
      assert.equal(body.store, true, 'background work must be retrievable after the request finishes');
      assert(JSON.stringify(body.input).includes(FILE.uri));
      assert(JSON.stringify(body.input).includes('video/webm'));
      assert(JSON.stringify(body.input).includes(INTERACTION_INPUT.goal));
      assert(JSON.stringify(body.input).includes('agentic'), 'video processing must be explicitly enabled');
      return Response.json({ id: 'interaction-123', status: 'in_progress', steps: [] });
    }),
  });
  assert.deepEqual(await client.createInteraction(INTERACTION_INPUT), {
    id: 'interaction-123', status: 'in_progress', markdown: null,
  });
});

test('caller-chosen file names make uploads recoverable and returned names must match', async () => {
  const name = 'files/sr-ca445e3207804202a5f7fc21a2b45eec';
  const namedFile = { ...FILE, name, uri: `${GOOGLE_ORIGIN}/v1beta/${name}` };
  for (const responseFile of [namedFile, FILE]) {
    let calls = 0;
    const client = createGeminiClient({
      apiKey: API_KEY,
      fetch: fakeFetch(async (request) => {
        calls++;
        if (calls === 1) {
          assert.equal((await request.json()).file.name, name, 'reserve the durable name before transferring bytes');
          return new Response(null, { headers: { 'x-goog-upload-url': UPLOAD_URL } });
        }
        await request.arrayBuffer();
        return Response.json({ file: responseFile });
      }),
    });
    const result = client.uploadFile({ ...uploadInput(), name });
    if (responseFile === namedFile) assert.deepEqual(await result, namedFile);
    else await assert.rejects(result, GeminiError);
    assert.equal(calls, 2);
  }
});

test('blank goals request a useful briefing and a configured model overrides the default', async () => {
  const client = createGeminiClient({
    apiKey: API_KEY,
    model: 'configured-model',
    fetch: fakeFetch(async (request) => {
      const body = await request.json();
      assert.equal(body.model, 'configured-model');
      assert.match(JSON.stringify(body), /briefing/i);
      assert.match(JSON.stringify(body), /language/i, 'the default should retain the video language');
      return Response.json({ id: 'interaction-123', status: 'in_progress', steps: [] });
    }),
  });
  await client.createInteraction({ ...INTERACTION_INPUT, goal: '   ' });
});

test('finished Interactions expose only model output text, never thoughts or tool output', async () => {
  const client = createGeminiClient({
    apiKey: API_KEY,
    fetch: fakeFetch(async (request) => {
      assert.equal(request.method, 'GET');
      assert.equal(new URL(request.url).pathname, '/v1beta/interactions/interaction-123');
      assert.equal(request.headers.get('Api-Revision'), '2026-05-20');
      return Response.json({
        id: 'interaction-123', status: 'completed',
        steps: [
          { type: 'thought', content: [{ type: 'text', text: 'Private reasoning must stay private.' }] },
          { type: 'tool_result', content: [{ type: 'text', text: 'Internal tool trace must stay private.' }] },
          { type: 'model_output', content: [
            { type: 'text', text: '# Screen walkthrough' },
            { type: 'image', text: 'Non-text content must not become Markdown.' },
            { type: 'text', text: 'The user opens the settings panel.' },
          ] },
        ],
      });
    }),
  });
  const result = await client.getInteraction('interaction-123');
  assert.equal(result.status, 'completed');
  assert.match(result.markdown!, /# Screen walkthrough/);
  assert.match(result.markdown!, /The user opens the settings panel\./);
  assert(!result.markdown!.includes('private'));
  assert(!result.markdown!.includes('Non-text'));
});

test('lost or server-failed Interaction creation is uncertain and is never automatically retried', async () => {
  for (const failure of ['network', 500, 503] as const) {
    let calls = 0;
    const client = createGeminiClient({
      apiKey: API_KEY,
      fetch: fakeFetch(() => {
        calls++;
        if (failure === 'network') throw new TypeError(`Connection closed after accepting ${API_KEY}`);
        return Response.json({ error: { message: `Internal provider failure ${API_KEY}` } }, { status: failure });
      }),
    });
    await assertProviderError(client.createInteraction(INTERACTION_INPUT), {
      ambiguous: true, status: failure === 'network' ? null : failure,
    });
    assert.equal(calls, 1, 'retrying could create a second billable Interaction');
  }
});

test('an explicitly rejected Interaction creation is a definite failure', async () => {
  const client = createGeminiClient({
    apiKey: API_KEY,
    fetch: fakeFetch(() => Response.json({ error: { message: `Bad request ${API_KEY}` } }, { status: 400 })),
  });
  await assertProviderError(client.createInteraction(INTERACTION_INPUT), { ambiguous: false, status: 400 });
});

test('a timed-out Interaction creation retains its uncertain outcome', async () => {
  const client = createGeminiClient({
    apiKey: API_KEY,
    requestTimeoutMs: 10,
    fetch: fakeFetch((_request, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })),
  });
  await assertProviderError(client.createInteraction(INTERACTION_INPUT), { ambiguous: true, status: null });
});

test('upload timeout settles a hanging storage open and cancels its eventual source stream', { timeout: 1_000 }, async () => {
  let calls = 0;
  let resolveSource!: (source: ReadableStream<Uint8Array>) => void;
  let sourceSignal: AbortSignal | undefined;
  let canceled = false;
  const client = createGeminiClient({
    apiKey: API_KEY,
    uploadTimeoutMs: 5,
    fetch: fakeFetch(() => {
      calls++;
      return new Response(null, { headers: { 'x-goog-upload-url': UPLOAD_URL } });
    }),
  });
  const opening = new Promise<ReadableStream<Uint8Array>>((resolve) => { resolveSource = resolve; });
  await assertProviderError(client.uploadFile({
    ...uploadInput(),
    openBody: async (signal) => {
      sourceSignal = signal;
      return opening;
    },
  }), { ambiguous: false, status: null });
  assert.equal(sourceSignal?.aborted, true);
  assert.equal(calls, 1, 'an expired upload must not start transferring bytes');

  resolveSource(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(canceled, true, 'a capability stream arriving after timeout must be released');
  assert.equal(calls, 1);
});

test('an untrusted resumable destination is rejected before sending credentials or opening the source', async () => {
  for (const destination of [
    'https://attacker.example/steal',
    'http://generativelanguage.googleapis.com/upload',
    'https://generativelanguage.googleapis.com.attacker.example/upload',
    'https://generativelanguage.googleapis.com@attacker.example/upload',
    'https://user:password@generativelanguage.googleapis.com/upload',
  ]) {
    let calls = 0;
    let opened = false;
    const client = createGeminiClient({
      apiKey: API_KEY,
      fetch: fakeFetch((request) => {
        calls++;
        assert.equal(new URL(request.url).origin, GOOGLE_ORIGIN);
        return new Response(null, { headers: { 'x-goog-upload-url': destination } });
      }),
    });
    await assert.rejects(client.uploadFile(uploadInput(4, async () => {
      opened = true;
      return bytesStream(new Uint8Array(4));
    })), GeminiError);
    assert.equal(calls, 1, destination);
    assert.equal(opened, false, destination);
  }
});

test('provider redirects are never followed with credentials during start or video upload', async () => {
  for (const redirectStage of ['start', 'upload'] as const) {
    let calls = 0;
    const client = createGeminiClient({
      apiKey: API_KEY,
      fetch: fakeFetch(async (request) => {
        calls++;
        assert.equal(new URL(request.url).origin, GOOGLE_ORIGIN);
        assert(['error', 'manual'].includes(request.redirect), 'automatic redirects could disclose API credentials');
        if (calls === 1 && redirectStage === 'upload') {
          return new Response(null, { headers: { 'x-goog-upload-url': UPLOAD_URL } });
        }
        return new Response(null, { status: 307, headers: { location: 'https://attacker.example/steal' } });
      }),
    });
    await assert.rejects(client.uploadFile(uploadInput()), GeminiError);
    assert.equal(calls, redirectStage === 'start' ? 1 : 2);
  }
});

test('oversized declared uploads fail before reserving Google storage or opening the source', async () => {
  let calls = 0;
  let opened = false;
  const client = createGeminiClient({
    apiKey: API_KEY,
    fetch: fakeFetch(() => {
      calls++;
      return new Response(null, { status: 500 });
    }),
  });
  await assert.rejects(client.uploadFile(uploadInput(50 * 1024 * 1024 + 1, async () => {
    opened = true;
    return bytesStream(new Uint8Array(4));
  })), GeminiError);
  assert.equal(calls, 0);
  assert.equal(opened, false);
});

test('short and oversized source streams cannot be accepted as a complete video', async () => {
  for (const actualBytes of [3, 5]) {
    let calls = 0;
    const client = createGeminiClient({
      apiKey: API_KEY,
      fetch: fakeFetch(async (request) => {
        calls++;
        if (calls === 1) return new Response(null, { headers: { 'x-goog-upload-url': UPLOAD_URL } });
        await request.arrayBuffer();
        return Response.json({ file: FILE });
      }),
    });
    await assert.rejects(client.uploadFile(uploadInput(4, async () => bytesStream(new Uint8Array(actualBytes)))), GeminiError);
    assert.equal(calls, 2);
  }
});

test('file polling normalizes provider state and cleanup treats missing resources as already removed', async () => {
  const operations: string[] = [];
  const client = createGeminiClient({
    apiKey: API_KEY,
    fetch: fakeFetch((request) => {
      const path = new URL(request.url).pathname;
      operations.push(`${request.method} ${path}`);
      assert.equal(request.headers.get('x-goog-api-key'), API_KEY);
      if (request.method === 'GET') return Response.json({ ...FILE, state: 'ACTIVE' });
      if (path.includes('/interactions/')) assert.equal(request.headers.get('Api-Revision'), '2026-05-20');
      return Response.json({ error: { message: 'Already removed' } }, { status: 404 });
    }),
  });
  assert.deepEqual(await client.getFile(FILE.name), { ...FILE, state: 'ACTIVE' });
  await client.deleteFile(FILE.name);
  await client.deleteInteraction('interaction-123');
  assert.deepEqual(operations, [
    'GET /v1beta/files/recording123',
    'DELETE /v1beta/files/recording123',
    'DELETE /v1beta/interactions/interaction-123',
  ]);
});

function chunkedResponse(fragments: Iterable<Uint8Array>, state = { canceled: false, emitted: 0 }) {
  const iterator = fragments[Symbol.iterator]();
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const item = iterator.next();
      if (item.done) controller.close();
      else { state.emitted += item.value.length; controller.enqueue(item.value); }
    },
    cancel() { state.canceled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
}

function generatedResponse(prefix: string, repeatedCharacters: number, suffix: string, state = { canceled: false, emitted: 0 }) {
  const encoder = new TextEncoder();
  function* fragments() {
    // One-byte framing splits JSON escapes, quotes and multibyte output characters.
    for (const byte of encoder.encode(prefix)) yield new Uint8Array([byte]);
    const block = encoder.encode('A'.repeat(65_521));
    for (let remaining = repeatedCharacters; remaining > 0; remaining -= block.length) {
      yield remaining >= block.length ? block : block.subarray(0, remaining);
    }
    for (const byte of encoder.encode(suffix)) yield new Uint8Array([byte]);
  }
  return chunkedResponse(fragments(), state);
}

test('50 MiB inline video stays streamed with bounded lookahead and an exact base64 Content-Length', { timeout: 30_000 }, async () => {
  const sizeBytes = 50 * 1024 * 1024;
  const block = Uint8Array.from({ length: 16_381 }, (_, index) => index % 251);
  const expectedHash = createHash('sha256');
  const receivedHash = createHash('sha256');
  let sourceBytes = 0;
  let receivedBytes = 0;
  let requestCount = 0;
  const { fileUri: _fileUri, ...input } = INTERACTION_INPUT;
  const client = createGeminiClient({
    apiKey: API_KEY,
    uploadTimeoutMs: 30_000,
    fetch: fakeFetch(async (request, init) => {
      requestCount++;
      assert.equal(new URL(request.url).pathname, '/v1beta/interactions');
      assert(init?.body instanceof ReadableStream, 'inline JSON must stream rather than accumulate the video');
      assert.equal(request.headers.get('content-type'), 'application/json');
      assert.equal(request.headers.get('x-goog-api-key'), API_KEY);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert(sourceBytes <= block.length * 8, 'an unconsumed request must exert backpressure on storage');

      let prefix = '';
      let suffix = '';
      let phase: 'prefix' | 'data' | 'suffix' = 'prefix';
      let carry = '';
      let base64Characters = 0;
      let wireBytes = 0;
      let chunks = 0;
      const marker = '"data":"';
      const decoder = new TextDecoder();
      const reader = request.body!.getReader();
      function digestBase64(value: string) {
        assert.match(value, /^[A-Za-z0-9+/=]*$/);
        base64Characters += value.length;
        const combined = carry + value;
        const complete = combined.length - combined.length % 4;
        if (complete) {
          const decoded = Buffer.from(combined.slice(0, complete), 'base64');
          receivedBytes += decoded.length;
          receivedHash.update(decoded);
        }
        carry = combined.slice(complete);
      }
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        wireBytes += chunk.value.byteLength;
        let text = decoder.decode(chunk.value, { stream: true });
        if (phase === 'prefix') {
          prefix += text;
          const start = prefix.indexOf(marker);
          if (start < 0) {
            assert(prefix.length < 16_384, 'expected the inline video framing before its data');
            continue;
          }
          text = prefix.slice(start + marker.length);
          prefix = prefix.slice(0, start + marker.length);
          phase = 'data';
        }
        if (phase === 'data') {
          const end = text.indexOf('"');
          if (end < 0) digestBase64(text);
          else {
            digestBase64(text.slice(0, end));
            suffix += text.slice(end);
            phase = 'suffix';
          }
        } else if (phase === 'suffix') suffix += text;
        if (++chunks % 64 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert(sourceBytes - receivedBytes <= block.length * 8, 'slow consumers must not cause the source to buffer the remaining video');
        }
      }
      reader.releaseLock();
      assert.equal(phase, 'suffix');
      assert.equal(carry, '');
      assert.equal(base64Characters, 4 * Math.ceil(sizeBytes / 3));
      assert.equal(receivedBytes, sizeBytes);
      assert.equal(sourceBytes, sizeBytes);
      assert.equal(receivedHash.digest('hex'), expectedHash.digest('hex'), 'base64 carry across uneven chunks must preserve every input byte');
      assert.equal(wireBytes, Buffer.byteLength(prefix) + 4 * Math.ceil(sizeBytes / 3) + Buffer.byteLength(suffix));
      assert.equal(request.headers.get('content-length'), String(wireBytes));
      const body = JSON.parse(prefix + suffix);
      assert.equal(body.background, true);
      assert.equal(body.store, true);
      const video = body.input.find((content: { type: string }) => content.type === 'video');
      assert.equal(video.data, '');
      assert.equal(video.mime_type, 'video/webm');
      assert.equal(video.processing, 'static');
      assert.equal(video.uri, undefined);
      return Response.json({ id: 'interaction-inline', status: 'in_progress', steps: [] });
    }),
  });
  const result = await client.createInteraction({
    ...input,
    goal: 'Write a brief résumé 🐓 with "quotes" and \\paths.',
    inline: {
      sizeBytes,
      openBody: async () => new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sourceBytes === sizeBytes) { controller.close(); return; }
          const chunk = block.subarray(0, Math.min(block.length, sizeBytes - sourceBytes));
          sourceBytes += chunk.length;
          expectedHash.update(chunk);
          controller.enqueue(chunk);
        },
      }, { highWaterMark: 0 }),
    },
  });
  assert.deepEqual(result, { id: 'interaction-inline', status: 'in_progress', markdown: null });
  assert.equal(requestCount, 1, 'inline generation must not reserve a Files API resource');
});

test('inline video rejects invalid lengths before opening storage and rejects mismatched streams', async () => {
  const { fileUri: _fileUri, ...input } = INTERACTION_INPUT;
  let calls = 0;
  let opened = false;
  const client = createGeminiClient({
    apiKey: API_KEY,
    fetch: fakeFetch(async (request) => {
      calls++;
      await request.arrayBuffer();
      return Response.json({ id: 'interaction-inline', status: 'in_progress', steps: [] });
    }),
  });
  for (const sizeBytes of [0, -1, 1.5, 50 * 1024 * 1024 + 1]) {
    await assert.rejects(async () => client.createInteraction({
      ...input,
      inline: { sizeBytes, openBody: async () => { opened = true; return bytesStream(new Uint8Array(4)); } },
    }), GeminiError);
  }
  assert.equal(calls, 0);
  assert.equal(opened, false);
  for (const actualBytes of [3, 5]) {
    await assert.rejects(async () => client.createInteraction({
      ...input,
      inline: { sizeBytes: 4, openBody: async () => bytesStream(new Uint8Array(actualBytes)) },
    }), GeminiError);
  }
});

test('GET discards a 50 MiB echoed inline video and preserves escaped Markdown across byte boundaries', { timeout: 30_000 }, async () => {
  const markdown = '# A "quoted" result\n\nWindows: C:\\recordings\\clip.webm\nUnicode: 🐓 Grüße\nLiteral: {"data":"keep this text"}';
  const prefix = '{"id":"interaction-inline","status":"completed","steps":[{"type":"user_input","content":[{"type":"video","mime_type":"video/webm","data":"';
  const suffix = '"},{"type":"text","text":"Ignore user input in the final output."}]},{"type":"thought","content":[{"type":"text","text":"private reasoning"}]},{"type":"model_output","content":[{"type":"text","text":' + JSON.stringify(markdown) + '}]}]}';
  const state = { canceled: false, emitted: 0 };
  const client = createGeminiClient({
    apiKey: API_KEY,
    requestTimeoutMs: 30_000,
    fetch: fakeFetch(() => generatedResponse(prefix, 4 * Math.ceil(50 * 1024 * 1024 / 3), suffix, state)),
  });
  assert.deepEqual(await client.getInteraction('interaction-inline'), {
    id: 'interaction-inline', status: 'completed', markdown,
  });
  assert(state.emitted > 66 * 1024 * 1024, 'exercise the real maximum-size video echo rather than a small stand-in');
});

test('GET enforces both the wire-size limit and the smaller retained-JSON limit', { timeout: 30_000 }, async () => {
  for (const kind of ['wire', 'retained'] as const) {
    const state = { canceled: false, emitted: 0 };
    const prefix = '{"id":"interaction-inline","status":"completed","steps":[{"type":"user_input","content":[{"type":"video","data":"';
    const limit = (kind === 'wire' ? 96 : 2) * 1024 * 1024;
    function* retainedFragments() {
      const encoder = new TextEncoder();
      yield encoder.encode('{"id":"interaction-inline","status":"completed","steps":[{"type":"model_output","content":[');
      const entry = encoder.encode(JSON.stringify({ type: 'text', text: 'A'.repeat(65_521) }) + ',');
      for (let index = 0; index < 35; index++) yield entry;
      yield encoder.encode('{"type":"text","text":"end"}]}]}');
    }
    const client = createGeminiClient({
      apiKey: API_KEY,
      requestTimeoutMs: 30_000,
      fetch: fakeFetch(() => kind === 'wire'
        ? generatedResponse(prefix, limit + 65_521, '"}]}]}', state)
        : chunkedResponse(retainedFragments(), state)),
    });
    await assertProviderError(client.getInteraction('interaction-inline'), { ambiguous: false, status: null });
    assert.equal(state.canceled, true, `${kind} overflow must cancel the upstream response`);
    assert(state.emitted <= limit + 131_042, `${kind} overflow must stop reading promptly`);
  }
});
