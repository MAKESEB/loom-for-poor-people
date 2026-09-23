export interface RecordingRow {
  id: string;
  requestId: string;
  uploadId: string;
  title: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number;
  createdAt: string;
  objectKey: string;
  transferId: string | null;
  uploadSha256: string | null;
  uploadAttempted: boolean;
  uploadState: 'pending' | 'ready';
  protected: boolean;
  markdownEnabled: boolean;
}

export type JobStatus = 'queued' | 'uploading' | 'processing' | 'submitting' | 'generating' | 'completed' | 'failed' | 'uncertain';

export interface MarkdownJob {
  id: string;
  recordingId: string;
  requestId: string;
  goal: string;
  status: JobStatus;
  providerFileName: string | null;
  providerFileUri: string | null;
  interactionId: string | null;
  markdown: string | null;
  error: string | null;
  attempts: number;
  cleanupPending: boolean;
  cleanupAfter: string | null;
  nextRunAt: string;
  deadlineAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  leaseVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type JobPatch = Partial<Pick<MarkdownJob, 'status' | 'providerFileName' | 'providerFileUri' | 'interactionId' | 'markdown' | 'error' | 'attempts' | 'cleanupPending' | 'cleanupAfter' | 'nextRunAt' | 'deadlineAt'>>;

export interface Repository {
  createRecording(input: RecordingRow): Promise<RecordingRow>;
  getRecording(id: string): Promise<RecordingRow | null>;
  getRecordingByRequest(requestId: string): Promise<RecordingRow | null>;
  attachTransfer(id: string, transferId: string): Promise<RecordingRow>;
  claimUpload(id: string, owner: string): Promise<RecordingRow | null>;
  saveUploadDigest(id: string, owner: string, digest: string): Promise<RecordingRow | null>;
  markUploadAttempt(id: string, owner: string, attempted: boolean): Promise<RecordingRow | null>;
  releaseUpload(id: string, owner: string): Promise<void>;
  completeRecording(id: string): Promise<RecordingRow>;
  updateRecording(id: string, patch: { protected?: boolean; markdownEnabled?: boolean }): Promise<RecordingRow>;
  createJob(input: { id: string; recordingId: string; requestId: string; goal: string }): Promise<{ job: MarkdownJob; created: boolean }>;
  getLatestJob(recordingId: string): Promise<MarkdownJob | null>;
  getJob(id: string): Promise<MarkdownJob | null>;
  claimJob(id: string, owner: string, leaseSeconds: number): Promise<MarkdownJob | null>;
  updateJob(id: string, owner: string, leaseVersion: number, patch: JobPatch): Promise<MarkdownJob | null>;
  releaseJob(id: string, owner: string, leaseVersion: number): Promise<void>;
  listWork(limit: number): Promise<MarkdownJob[]>;
}

export interface MarkdownView {
  enabled: boolean;
  status: JobStatus | 'idle';
  markdown: string | null;
  error?: string;
  jobId?: string;
}

export interface MarkdownService {
  generate(recording: RecordingRow, goal: string, requestId: string): Promise<MarkdownView>;
  status(recording: RecordingRow, advance: boolean): Promise<MarkdownView>;
}
