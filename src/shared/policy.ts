export const MIB = 1024 * 1024;

// Video storage and optional AI processing have independent limits.
/**
 * 1,280 parts of 8 MiB, on Cloudflare (D1 and R2; migrations-d1/0002 allows exactly this).
 * Playback streams a recording part by part within one Worker invocation, a few subrequests
 * per part, well inside the 10,000 subrequests of the Workers Paid plan.
 */
export const MAX_RECORDING_BYTES = 10 * 1024 * MIB;
/**
 * The Postgres schema (ohmyho.st hosting and local `npm run dev`) stays at 1 GiB, 128 parts:
 * its size, part count and part index CHECK constraints cannot be relaxed under the hosting's
 * additive-only migration contract.
 */
export const POSTGRES_MAX_RECORDING_BYTES = 1024 * MIB;
/**
 * Markdown jobs stream the video to Gemini as base64 inside one request, which Gemini
 * accepts up to 100 MB. Base64 adds a third, so 64 MiB of video become ~89.5 MB.
 * Parted recordings stream stitched together, like playback.
 */
export const MAX_MARKDOWN_BYTES = 64 * MIB;
export const MAX_SINGLE_UPLOAD_BYTES = 50 * MIB;
export const UPLOAD_CHUNK_BYTES = 8 * MIB;
export const MAX_PART_COUNT = MAX_RECORDING_BYTES / UPLOAD_CHUNK_BYTES;
export const POSTGRES_MAX_PART_COUNT = POSTGRES_MAX_RECORDING_BYTES / UPLOAD_CHUNK_BYTES;

/** A byte limit for user-facing text, e.g. "64 MiB" or "1 GiB". */
export function limitText(bytes: number): string {
  if (bytes >= 1024 * MIB) return `${Number((bytes / (1024 * MIB)).toFixed(1))} GiB`;
  return `${Number((bytes / MIB).toFixed(1))} MiB`;
}

// Recording duration is not capped independently of available file capacity.
export const MAX_DURATION_SECONDS: number | null = null;
