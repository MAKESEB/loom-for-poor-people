export const MIB = 1024 * 1024;

// Video storage and optional AI processing have independent limits.
export const MAX_RECORDING_BYTES = 1024 * MIB;
export const MAX_MARKDOWN_BYTES = 50 * MIB;
export const MAX_SINGLE_UPLOAD_BYTES = 50 * MIB;
export const UPLOAD_CHUNK_BYTES = 8 * MIB;

// Recording duration is not capped independently of available file capacity.
export const MAX_DURATION_SECONDS: number | null = null;
