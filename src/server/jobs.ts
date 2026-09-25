import { createGeminiClient, GeminiError, type GeminiClient, type GeminiClientConfig, type GeminiFile, type GeminiInteraction } from './gemini';
import type { StorageRuntime } from './storage';
import type { JobPatch, MarkdownJob, MarkdownService, MarkdownView, RecordingRow, Repository } from './types';
import { MAX_MARKDOWN_BYTES } from '../shared/policy';

const LEASE_SECONDS = 240;
const POLL_DELAY_MS = 5_000;
const RETRY_DELAY_MS = 60_000;
const MAX_DEFERRED_VIDEO_BYTES = 10 * 1024 * 1024;
const MARKDOWN_SIZE_MESSAGE = 'Markdown generation is available for recordings up to 50 MiB.';
const TERMINAL = new Set(['completed', 'failed', 'uncertain']);
const UNKNOWN_MESSAGE = 'Gemini may have received this request, but its confirmation was lost. Generate again only if you want to start another attempt.';

class LostLease extends Error {}

export interface JobServiceConfig extends GeminiClientConfig {
  now?: () => Date;
  defer?: (task: Promise<unknown>) => void;
  client?: GeminiClient;
  processingWaitMs?: number;
  inputMethod?: 'inline' | 'files';
}

/** The database is the queue, mutex and source of truth across Dev, production and cron. */
export function createJobService(repository: Repository, runtime: StorageRuntime, config: JobServiceConfig) {
  const client = config.client ?? createGeminiClient(config);
  const now = config.now ?? (() => new Date());
  const after = (milliseconds: number) => new Date(now().getTime() + milliseconds).toISOString();

  function view(recording: RecordingRow, job: MarkdownJob | null): MarkdownView {
    return {
      enabled: recording.markdownEnabled,
      status: job?.status ?? 'idle',
      markdown: job?.markdown ?? null,
      ...(job?.error ? { error: job.error } : {}),
      ...(job ? { jobId: job.id } : {}),
    };
  }

  async function advance(id: string, reconcileOnly = false): Promise<void> {
    // UI polling can only retrieve a known background interaction. It never uploads or submits.
    const initial = await repository.getJob(id);
    if (!initial || (reconcileOnly && (initial.status !== 'generating' || !initial.interactionId))) return;
    if (Date.parse(initial.nextRunAt) > now().getTime()) return;
    const owner = crypto.randomUUID();
    let job = await repository.claimJob(id, owner, LEASE_SECONDS);
    if (!job) return;
    const fence = job.leaseVersion;

    async function save(patch: JobPatch) {
      const updated = await repository.updateJob(id, owner, fence, patch);
      if (!updated) throw new LostLease();
      job = updated;
      return updated;
    }

    async function fail(message: string) {
      await save({ status: 'failed', error: message, cleanupPending: Boolean(job!.providerFileName || job!.interactionId), cleanupAfter: null, nextRunAt: after(0) });
    }

    async function uncertain() {
      await save({ status: 'uncertain', error: UNKNOWN_MESSAGE, cleanupPending: Boolean(job!.providerFileName || job!.interactionId), cleanupAfter: job!.deadlineAt, nextRunAt: job!.deadlineAt });
    }

    async function cleanup() {
      if (!job!.cleanupPending || !TERMINAL.has(job!.status)) return;
      if (job!.cleanupAfter && Date.parse(job!.cleanupAfter) > now().getTime()) {
        await save({ nextRunAt: job!.cleanupAfter });
        return;
      }
      // Each successful deletion is checkpointed, so one failed resource does not restart work.
      if (job!.interactionId) {
        if (job!.status !== 'completed') {
          try { await client.cancelInteraction(job!.interactionId); }
          catch (error) {
            if (!(error instanceof GeminiError) || ![400, 409].includes(error.status ?? 0)) throw error;
          }
        }
        await client.deleteInteraction(job!.interactionId);
        await save({ interactionId: null });
      }
      if (job!.providerFileName) {
        await client.deleteFile(job!.providerFileName);
        await save({ providerFileName: null, providerFileUri: null });
      }
      await save({ cleanupPending: false, cleanupAfter: null });
    }

    async function acceptInteraction(interaction: GeminiInteraction) {
      if (interaction.status === 'completed') {
        if (!interaction.markdown) {
          await fail('Gemini finished without Markdown. You can generate again.');
          return;
        }
        // Persist output before deleting either provider resource.
        await save({ status: 'completed', markdown: interaction.markdown, error: null, cleanupPending: true, cleanupAfter: null, nextRunAt: after(0) });
      } else if (['in_progress', 'queued', 'running'].includes(interaction.status)) {
        await save({ status: 'generating', error: null, nextRunAt: after(POLL_DELAY_MS) });
      } else {
        await fail('Gemini could not complete this generation. Your video is still available.');
      }
    }

    try {
      if (reconcileOnly && (job.status !== 'generating' || !job.interactionId)) return;
      if (TERMINAL.has(job.status)) {
        if (!reconcileOnly) await cleanup();
        return;
      }
      if (job.status === 'submitting' && !job.interactionId) {
        // A process died after recording its intent to submit. Google has no documented
        // idempotency key or lookup by our job ID, so retrying here could double charge.
        await uncertain();
        return;
      }
      if (Date.parse(job.deadlineAt) <= now().getTime()) {
        await fail('Generation took too long. You can generate again.');
        if (!reconcileOnly) await cleanup();
        return;
      }

      if (job.interactionId) {
        const interaction = await client.getInteraction(job.interactionId);
        await acceptInteraction(interaction);
        // A UI GET is deliberately limited to retrieval and durable result reconciliation.
        if (!reconcileOnly) await cleanup();
        return;
      }
      if (reconcileOnly) return;

      const recording = await repository.getRecording(job.recordingId);
      if (!recording || recording.uploadState !== 'ready') {
        await fail('The recording is not available for generation.');
        await cleanup();
        return;
      }
      if (recording.sizeBytes > MAX_MARKDOWN_BYTES) {
        await fail(MARKDOWN_SIZE_MESSAGE);
        await cleanup();
        return;
      }

      const openRecording = async (signal: AbortSignal) => {
        const capability = await runtime.storage.createSignedRead(recording.objectKey);
        if (signal.aborted) throw new GeminiError('storage_read_failed');
        const response = await runtime.capabilityFetch(new Request(capability.url, {
          method: 'GET', headers: capability.requiredHeaders, redirect: 'manual', signal,
        }));
        const contentLength = response.headers.get('content-length');
        if (!response.ok || !response.body || (contentLength !== null && Number(contentLength) !== recording.sizeBytes)) {
          await response.body?.cancel();
          throw new GeminiError('storage_read_failed');
        }
        return response.body;
      };

      // Files-URI background requests currently fail at Google's retrieval endpoint
      // with an internal blobstore URI error. Inline video is streamed as base64 JSON
      // and keeps the same durable provider Interaction; never retry failed inference
      // automatically. Existing Files jobs retain their original path for cleanup.
      if (config.inputMethod !== 'files' && !job.providerFileName) {
        await save({ status: 'submitting', attempts: job.attempts + 1, nextRunAt: after(0) });
        const interaction = await client.createInteraction({
          jobId: job.id, goal: job.goal, contentType: recording.contentType,
          inline: { sizeBytes: recording.sizeBytes, openBody: openRecording },
        });
        await save({ interactionId: interaction.id, status: 'generating', nextRunAt: after(POLL_DELAY_MS) });
        await acceptInteraction(interaction);
        await cleanup();
        return;
      }

      let file: GeminiFile | null = null;
      if (job.providerFileName) {
        try { file = await client.getFile(job.providerFileName); }
        catch (error) {
          // A deterministic file name was saved before upload. A lost upload response
          // is recoverable without leaving untracked provider resources behind.
          if (!(error instanceof GeminiError) || error.status !== 404 || job.providerFileUri) throw error;
        }
      }
      let uploaded = false;
      if (!file) {
        if (job.attempts >= 3) {
          await fail('The video could not be sent to Gemini. You can generate again.');
          return;
        }
        const name = job.providerFileName ?? `files/sr-${job.id.replaceAll('-', '')}`;
        await save({ status: 'uploading', providerFileName: name, attempts: job.attempts + 1, error: null });
        file = await client.uploadFile({
          name,
          displayName: `slop-rooster-${job.id}`,
          contentType: recording.contentType,
          sizeBytes: recording.sizeBytes,
          openBody: openRecording,
        });
        uploaded = true;
      }
      await save({ providerFileName: file.name, providerFileUri: file.uri, status: 'processing', nextRunAt: after(0) });
      // Most short recordings finish processing within seconds. Bound this initial
      // wait; slower videos remain durable and the five-minute cron advances them.
      const waitUntil = Date.now() + Math.min(8_000, Math.max(0, config.processingWaitMs ?? 8_000));
      while (uploaded && file.state === 'PROCESSING' && Date.now() < waitUntil) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, waitUntil - Date.now())));
        file = await client.getFile(file.name);
      }
      if (file.state === 'FAILED') {
        await fail('Gemini could not process this video. Your video is still available.');
        await cleanup();
        return;
      }
      if (file.state !== 'ACTIVE') {
        await save({ nextRunAt: after(POLL_DELAY_MS) });
        return;
      }
      if (Date.parse(job.deadlineAt) <= now().getTime()) {
        await fail('Generation took too long. You can generate again.');
        await cleanup();
        return;
      }

      if (!job.providerFileUri) throw new GeminiError('provider_file_invalid');
      // This write is the submission barrier. No other invocation may retry the POST
      // when the process disappears between this checkpoint and saving the provider ID.
      await save({ status: 'submitting', nextRunAt: after(0) });
      const interaction = await client.createInteraction({ jobId: job.id, fileUri: job.providerFileUri, contentType: recording.contentType, goal: job.goal });
      await save({ interactionId: interaction.id, status: 'generating', nextRunAt: after(POLL_DELAY_MS) });
      await acceptInteraction(interaction);
      await cleanup();
    } catch (error) {
      if (error instanceof LostLease) return;
      // Never log a provider body, exception message, signed URL, or supplied prompt.
      if (job.status === 'submitting' && !job.interactionId) {
        if (!(error instanceof GeminiError) || error.ambiguous) await uncertain();
        else await fail('Gemini rejected this generation. You can try again later.');
      } else if (TERMINAL.has(job.status)) {
        await save({ nextRunAt: after(RETRY_DELAY_MS) });
      } else if (error instanceof GeminiError && error.status !== null && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        await fail('Gemini could not process this recording. You can generate again.');
      } else if (job.status === 'uploading') {
        await save({ status: 'queued', error: null, nextRunAt: after(RETRY_DELAY_MS) });
      } else {
        await save({ nextRunAt: after(RETRY_DELAY_MS) });
      }
    } finally {
      await repository.releaseJob(id, owner, fence);
    }
  }

  const service: MarkdownService & { advance: typeof advance; runPending: (limit?: number) => Promise<{ processed: number }> } = {
    async generate(recording, goal, requestId) {
      if (recording.sizeBytes > MAX_MARKDOWN_BYTES) {
        throw Object.assign(new Error(MARKDOWN_SIZE_MESSAGE), { code: 'markdown_too_large', status: 413 });
      }
      const { job, created } = await repository.createJob({ id: crypto.randomUUID(), recordingId: recording.id, requestId, goal: goal.trim() });
      // HTTP waitUntil only has 30 seconds after the response. Large inline uploads
      // belong to the scheduled invocation's 120-second window instead.
      if (created && config.defer && recording.sizeBytes <= MAX_DEFERRED_VIDEO_BYTES) config.defer(advance(job.id));
      return view(recording, job);
    },
    async status(recording, reconcile) {
      let job = await repository.getLatestJob(recording.id);
      if (reconcile && job?.status === 'generating' && job.interactionId) {
        await advance(job.id, true);
        job = await repository.getJob(job.id);
      }
      return view(recording, job);
    },
    advance,
    async runPending(limit = 4) {
      const pending = await repository.listWork(Math.min(8, Math.max(1, limit)));
      const results = await Promise.allSettled(pending.map((job) => advance(job.id)));
      // One unavailable row must not starve unrelated recordings. The rejected job's
      // durable lease expires and the next cron invocation can recover it.
      return { processed: results.filter((result) => result.status === 'fulfilled').length };
    },
  };
  return service;
}

export type JobService = ReturnType<typeof createJobService>;
