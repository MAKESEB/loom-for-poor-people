import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Copy, Download, FileText, Link2, LoaderCircle, LockKeyhole, LogOut, Mic, MicOff, Monitor, Pause, Play, Plus, RefreshCw, ShieldCheck, Square, Volume2, VolumeX, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError, recordingApiPath, uploadBlob, type MarkdownResult, type Recording, type RecordingView, type Upload } from './client/api';
import { useScreenRecorder } from './client/useScreenRecorder';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Switch } from './components/ui/switch';
import { Textarea } from './components/ui/textarea';
import { MAX_DURATION_SECONDS, MAX_MARKDOWN_BYTES, MAX_RECORDING_BYTES, MIB } from './shared/policy';

const ACTIVE_JOBS = new Set<MarkdownResult['status']>(['queued', 'uploading', 'processing', 'submitting', 'generating']);
interface RecorderConfig { maxBytes: number; maxDurationSeconds: number | null; maxMarkdownBytes: number; configured: boolean }
const INITIAL_CONFIG: RecorderConfig = { maxBytes: MAX_RECORDING_BYTES, maxDurationSeconds: MAX_DURATION_SECONDS, maxMarkdownBytes: MAX_MARKDOWN_BYTES, configured: false };

function messageOf(error: unknown, fallback = 'Something went wrong. Please try again.') {
  return error instanceof Error ? error.message : fallback;
}

function duration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  return `${hours ? `${hours}:` : ''}${minutes.toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}

function fileSize(bytes: number) {
  if (bytes >= 1024 * MIB) return `${Number((bytes / (1024 * MIB)).toFixed(1))} GiB`;
  return `${(bytes / MIB).toFixed(bytes < 10 * MIB ? 1 : 0)} MiB`;
}

function RoosterMark({ large = false }: { large?: boolean }) {
  return <svg className={large ? 'rooster-mark rooster-mark-large' : 'rooster-mark'} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M18.5 9.5c-2-4-1-7 1-6 1 .5 1 2 1 2s1-4 3-3c1.5 1-.5 4-.5 4s3-2 3.5 0c.5 2-3 4-3 4" fill="#ef4444" />
    <path d="M22 8.5c-3.8 0-6.5 3.2-6.5 7V17c-4.5.5-7.5-1-9-5.5-2 4-.5 8.5 2 10.5 2.1 1.7 5 2.7 8.5 2.7 6 0 8.5-4.2 8.5-8.2V13L29 11.5l-4-1A5.6 5.6 0 0 0 22 8.5Z" fill="currentColor" />
    <circle cx="22.5" cy="12" r=".85" fill="white" />
    <path d="M14.5 24v4m5-4v4m-8 0h5m1 0h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    <path d="M5.5 12c-3-3-3-6-2-8 4 1 6 5 5.5 9" fill="currentColor" />
  </svg>;
}

function Brand() {
  return <a href="/" className="brand" aria-label="Slop Rooster home"><RoosterMark /><span>slop rooster<span className="brand-period">.</span></span></a>;
}

function Header({ children }: { children?: ReactNode }) {
  return <header className="site-header page-width"><Brand /><div className="header-actions">{children}</div></header>;
}

function Footer() {
  return <footer className="site-footer page-width"><span>Less explaining. More showing.</span><span className="footer-label"><span /> Slop Rooster</span></footer>;
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice${error ? ' notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}

function Spinner({ label }: { label?: string }) {
  return <span className="loading-inline"><LoaderCircle className="spinner" aria-hidden="true" />{label}</span>;
}

function Login({ onSuccess, modal = false, onClose }: { onSuccess: () => void; modal?: boolean; onClose?: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (modal && !dialog.current?.open) dialog.current?.showModal();
    if (modal) field.current?.focus();
    return () => dialog.current?.close();
  }, [modal]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !code.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await api('/api/session', { method: 'POST', body: JSON.stringify({ accessCode: code.trim() }) });
      setCode('');
      onSuccess();
    } catch (reason) {
      setError(messageOf(reason));
      field.current?.focus();
    } finally { submitting.current = false; setBusy(false); }
  }

  const content = <div className="login-card">
    {modal && <Button variant="ghost" size="icon" className="dialog-close" onClick={onClose} aria-label="Close sign in"><X /></Button>}
    {modal ? <h2 id="session-login-title">Sign in</h2> : <h1 className="sr-only">Sign in</h1>}
    <form onSubmit={(event) => void submit(event)}>
      <label htmlFor={modal ? 'session-access-code' : 'access-code'}>Access code</label>
      <Input id={modal ? 'session-access-code' : 'access-code'} ref={field} type="password" value={code} onChange={(event) => setCode(event.target.value)} placeholder="UUID" autoComplete="current-password" autoCapitalize="none" spellCheck={false} required maxLength={100} aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} disabled={busy} />
      {error && <p className="field-error" id="login-error" role="alert">{error}</p>}
      <Button className="login-submit" type="submit" disabled={busy || !code.trim()}>{busy ? <Spinner label="Signing in…" /> : <>Continue <ArrowRight /></>}</Button>
    </form>
  </div>;

  if (modal) return <dialog ref={dialog} className="login-dialog" aria-labelledby="session-login-title" onCancel={(event) => { event.preventDefault(); onClose?.(); }}>{content}</dialog>;
  return <><Header /><main className="login-main page-width">{content}</main></>;
}

function CopyButton({ text, label = 'Copy link', variant = 'default', onUnavailable }: { text: string; label?: string; variant?: 'default' | 'ghost' | 'outline'; onUnavailable?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { setCopied(false); }, [text]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
      onUnavailable?.();
    }
  }
  return <Button variant={variant} size="sm" onClick={() => void copy()} aria-label={copied ? 'Copied' : label}>{copied ? <Check /> : <Copy />}<span>{copied ? 'Copied' : failed ? 'Copy manually' : label}</span></Button>;
}

function MarkdownDocument({ markdown, downloadUrl }: { markdown: string; downloadUrl: string }) {
  const [manualCopy, setManualCopy] = useState(false);
  const raw = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (manualCopy) { raw.current?.focus(); raw.current?.select(); } }, [manualCopy]);
  return <section className="markdown-document" aria-label="Recording Markdown">
    <div className="document-toolbar"><div><FileText size={16} /><h2>From the recording</h2><span className="file-tag">.md</span></div><div className="document-actions"><CopyButton text={markdown} label="Copy" variant="ghost" onUnavailable={() => setManualCopy(true)} /><Button asChild variant="ghost" size="sm"><a href={downloadUrl} download><Download /><span>Download</span></a></Button></div></div>
    {manualCopy && <div className="manual-copy"><label htmlFor="markdown-raw">Select and copy the Markdown below.</label><Textarea id="markdown-raw" ref={raw} readOnly value={markdown} rows={6} /><Button variant="ghost" size="sm" onClick={() => setManualCopy(false)}>Done</Button></div>}
    <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span className="markdown-image-description">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
    }}>{markdown}</ReactMarkdown></div>
  </section>;
}

function RecordingDetails({ recording, onChange, view, token = '' }: { recording: Recording; onChange: (recording: Recording) => void; view: RecordingView; token?: string }) {
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [goal, setGoal] = useState('');
  const [markdown, setMarkdown] = useState<MarkdownResult | null>(null);
  const [generationBusy, setGenerationBusy] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [pollError, setPollError] = useState(false);
  const [pollCycle, setPollCycle] = useState(0);
  const settingsLock = useRef(false);
  const generationLock = useRef(false);
  const pendingGeneration = useRef<{ id: string; goal: string } | null>(null);
  const resultVersion = useRef(0);
  const linkInput = useRef<HTMLInputElement>(null);
  const [manualLinkCopy, setManualLinkCopy] = useState(false);
  const canManage = view === 'manage' && recording.isOwner;
  const maxMarkdownBytes = recording.maxMarkdownBytes ?? MAX_MARKDOWN_BYTES;
  const markdownEligible = recording.markdownEligible ?? recording.sizeBytes <= maxMarkdownBytes;
  const shareUrl = new URL(recording.sharePath, window.location.origin).href;
  const working = generationBusy || !!markdown?.enabled && ACTIVE_JOBS.has(markdown.status);
  const showDocument = recording.markdownEnabled && markdown?.enabled === true && !!markdown.markdown && (canManage || markdown.status === 'completed');

  useEffect(() => {
    if (!recording.markdownEnabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped || generationLock.current) return;
      const version = resultVersion.current;
      let again = false;
      try {
        const result = await api<MarkdownResult>(recordingApiPath(recording.id, 'markdown', token, view));
        if (stopped || resultVersion.current !== version) return;
        setMarkdown(result);
        setPollError(false);
        again = result.enabled && ACTIVE_JOBS.has(result.status);
      } catch (reason) {
        if (stopped || resultVersion.current !== version) return;
        const denied = reason instanceof ApiError && [401, 403, 404].includes(reason.status);
        if (denied) setMarkdown(null);
        setPollError(!denied);
        again = !denied;
      }
      if (!stopped && again) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [recording.id, recording.markdownEnabled, token, view, pollCycle]);

  async function updateSettings(update: { protected?: boolean; markdownEnabled?: boolean }) {
    if (!canManage || settingsLock.current) return;
    settingsLock.current = true;
    setSettingsBusy(true);
    setSettingsError('');
    try {
      const result = await api<Recording>(recordingApiPath(recording.id, '', '', 'manage'), { method: 'PATCH', body: JSON.stringify(update) });
      onChange(result);
    } catch (reason) { setSettingsError(messageOf(reason)); }
    finally { settingsLock.current = false; setSettingsBusy(false); }
  }

  async function generate() {
    if (!canManage || !markdownEligible || generationLock.current || working) return;
    generationLock.current = true;
    resultVersion.current += 1;
    setGenerationBusy(true);
    setGenerationError('');
    const cleanGoal = goal.trim();
    if (!pendingGeneration.current || pendingGeneration.current.goal !== cleanGoal) pendingGeneration.current = { id: crypto.randomUUID(), goal: cleanGoal };
    try {
      const result = await api<MarkdownResult>(recordingApiPath(recording.id, 'markdown', '', 'manage'), { method: 'POST', body: JSON.stringify({ goal: cleanGoal, requestId: pendingGeneration.current.id }) });
      pendingGeneration.current = null;
      setMarkdown(result);
      setPollError(false);
    } catch (reason) { setGenerationError(messageOf(reason)); }
    finally {
      generationLock.current = false;
      setGenerationBusy(false);
      // A completed or idle lookup has no timer; an explicit Generate restarts it.
      setPollCycle((cycle) => cycle + 1);
    }
  }

  return <>
    {canManage && <section className="share-settings" aria-label="Sharing options">
      <div className="share-heading"><label htmlFor="share-link">Ready to share</label><a className="view-recording-link" href={recording.sharePath} target="_blank" rel="noopener noreferrer">View recording<ChevronRight size={13} /></a></div>
      <div className="share-link-row"><div className="share-input-wrap"><Link2 size={16} /><Input id="share-link" ref={linkInput} value={shareUrl} readOnly onFocus={(event) => event.currentTarget.select()} aria-label="Share link" /></div><CopyButton text={shareUrl} onUnavailable={() => { setManualLinkCopy(true); linkInput.current?.focus(); linkInput.current?.select(); }} /></div>
      {manualLinkCopy && <p className="helper-text" role="status">The link is selected. Copy it with your keyboard.</p>}
      <div className="share-options">
        <div className="option-row"><div className="option-icon"><ShieldCheck size={18} /></div><label htmlFor="protect-link"><span>Protect link</span><small>{recording.protected ? 'Only the full link, including its token, opens this video.' : 'Add a private access token. The link never expires.'}</small></label><Switch id="protect-link" checked={recording.protected} onCheckedChange={(checked) => void updateSettings({ protected: checked })} disabled={settingsBusy} /></div>
        <div className="option-row"><div className="option-icon"><FileText size={18} /></div><label htmlFor="generate-markdown"><span>Generate Markdown</span><small>A briefing, a transcript, or whatever you need.</small></label><Switch id="generate-markdown" checked={recording.markdownEnabled} onCheckedChange={(checked) => void updateSettings({ markdownEnabled: checked })} disabled={settingsBusy} /></div>
      </div>
      {settingsError && <Notice error>{settingsError}</Notice>}
      {recording.markdownEnabled && <div className="goal-editor">
        <div className="goal-label"><label htmlFor="markdown-goal">Define the goal</label><span>Optional</span></div>
        <Textarea id="markdown-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Turn this into a brief with key takeaways and next steps…" maxLength={4000} rows={3} disabled={working || !markdownEligible} />
        <div className="generation-action"><p>{markdownEligible ? <>Generate sends this video to Gemini.<br className="mobile-break" /> Leave blank for a short briefing.</> : <>Markdown is available for videos up to {fileSize(maxMarkdownBytes)}.<br className="mobile-break" /> Your video is ready to share.</>}</p><Button size="sm" disabled={working || settingsBusy || !markdownEligible} onClick={() => void generate()}>{working ? <Spinner label="Generating…" /> : <>{markdown?.markdown ? 'Generate again' : markdown?.status === 'uncertain' ? 'Try again' : 'Generate'}<ArrowRight /></>}</Button></div>
        {working && <p className="job-note" role="status">You can close this tab. Your Markdown will be waiting here.</p>}
        {markdown?.status === 'uncertain' && <Notice>The previous request may still be processing. Trying again starts a new request.</Notice>}
        {markdown?.status === 'failed' && <Notice error>{markdown.error || 'Markdown couldn’t be generated. Your video is ready to share; you can try again.'}</Notice>}
        {generationError && <Notice error>{generationError}</Notice>}
        {pollError && <p className="helper-text" role="status">Reconnecting to check your Markdown…</p>}
      </div>}
    </section>}
    {showDocument && <MarkdownDocument markdown={markdown!.markdown!} downloadUrl={recordingApiPath(recording.id, 'markdown/download', token, view)} />}
  </>;
}

function Recorder({ onLogout, onSaved }: { onLogout: () => Promise<void>; onSaved: (recording: Recording) => void }) {
  const [config, setConfig] = useState(INITIAL_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [microphone, setMicrophone] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'uploading' | 'finalizing'>('idle');
  const [progress, setProgress] = useState(0);
  const [saveError, setSaveError] = useState('');
  const [blobUrl, setBlobUrl] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const uploadLock = useRef(false);
  const autoStarted = useRef<Blob | null>(null);
  const uploadedSession = useRef<{ id: string; uploadId: string } | null>(null);
  const reservationBody = useRef<string | null>(null);
  const liveVideo = useRef<HTMLVideoElement>(null);
  const capture = useScreenRecorder(config.maxBytes, config.maxDurationSeconds);
  const recording = capture.phase === 'recording' || capture.phase === 'paused';
  const active = recording || capture.phase === 'requesting' || capture.phase === 'stopping';
  const saving = saveState === 'uploading' || saveState === 'finalizing';
  const preview = capture.phase === 'preview';
  const tooLarge = !!capture.blob && capture.blob.size > config.maxBytes;
  const canCapture = !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined';

  const refreshConfig = useCallback(async () => {
    try {
      const value = await api<RecorderConfig>('/api/config');
      const validDuration = value.maxDurationSeconds === null || (Number.isFinite(value.maxDurationSeconds) && value.maxDurationSeconds > 0);
      if (Number.isFinite(value.maxBytes) && value.maxBytes > 0 && validDuration) setConfig({ ...value, maxMarkdownBytes: Number.isFinite(value.maxMarkdownBytes) && value.maxMarkdownBytes > 0 ? value.maxMarkdownBytes : MAX_MARKDOWN_BYTES, configured: value.configured !== false });
    } catch { setConfig((value) => ({ ...value, configured: false })); }
    finally { setConfigLoaded(true); }
  }, []);

  useEffect(() => {
    void refreshConfig();
    const online = () => { void refreshConfig(); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [refreshConfig]);

  useEffect(() => {
    if (liveVideo.current && capture.stream) {
      liveVideo.current.srcObject = capture.stream;
      void liveVideo.current.play().catch(() => {});
    }
  }, [capture.stream]);

  useEffect(() => {
    if (!capture.blob) { setBlobUrl(''); return; }
    const url = URL.createObjectURL(capture.blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [capture.blob]);

  useEffect(() => {
    if (!active && !capture.blob) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [active, capture.blob]);

  const saveRecording = useCallback(async () => {
    const blob = capture.blob;
    if (!blob || uploadLock.current || blob.size > config.maxBytes || !config.configured) return;
    uploadLock.current = true;
    setSaveError('');
    setSaveState(uploadedSession.current ? 'finalizing' : 'uploading');
    try {
      if (!uploadedSession.current) {
        setProgress(0);
        const recordedSeconds = Math.max(1, Math.round(capture.seconds));
        reservationBody.current ??= JSON.stringify({ id: crypto.randomUUID(), title: `Screen recording · ${new Date().toLocaleDateString('en', { month: 'short', day: 'numeric' })}`, contentType: blob.type, sizeBytes: blob.size, durationSeconds: config.maxDurationSeconds === null ? recordedSeconds : Math.min(config.maxDurationSeconds, recordedSeconds) });
        const upload = await api<Upload>('/api/recordings/uploads', { method: 'POST', body: reservationBody.current });
        if (!upload.id) throw new Error('The upload could not be prepared. Your recording is still here.');
        if (!upload.alreadyUploaded) await uploadBlob(upload, blob, setProgress);
        else setProgress(100);
        uploadedSession.current = { id: upload.id, uploadId: upload.uploadId };
      }
      setSaveState('finalizing');
      const session = uploadedSession.current;
      let result: Recording | null = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await api<Recording | { retryAfterSeconds?: number }>(recordingApiPath(session.id, 'complete'), { method: 'POST', body: JSON.stringify({ uploadId: session.uploadId }) });
        if ('videoUrl' in response && 'id' in response) { result = response; break; }
        const delay = 'retryAfterSeconds' in response && typeof response.retryAfterSeconds === 'number' ? Math.min(10, Math.max(1, response.retryAfterSeconds)) : 2;
        await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
      }
      if (!result) throw new Error('Your video is still being prepared. Try again in a moment; it won’t need to upload again.');
      onSaved(result);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'storage_upload_expired') { uploadedSession.current = null; reservationBody.current = null; }
      setSaveState('idle');
      setSaveError(messageOf(reason, 'Your recording couldn’t be saved. Please try again.'));
    } finally { uploadLock.current = false; }
  }, [capture.blob, capture.seconds, config, onSaved]);

  useEffect(() => {
    if (capture.phase !== 'preview' || !capture.blob || !config.configured || autoStarted.current === capture.blob || tooLarge) return;
    autoStarted.current = capture.blob;
    void saveRecording();
  }, [capture.phase, capture.blob, config.configured, tooLarge, saveRecording]);

  return <>
    <Header><Button variant="ghost" size="sm" disabled={active || saving || !!capture.blob} onClick={() => { setLogoutError(''); void onLogout().catch((error) => setLogoutError(messageOf(error))); }}><LogOut /><span className="logout-label">Sign out</span></Button></Header>
    <main className="studio-main page-width">
      <div className="page-heading"><div><div className="eyebrow">YOUR LITTLE RECORDING STUDIO</div><h1>{preview ? 'That’s a wrap.' : 'Show what you mean.'}</h1></div><span className="heading-meta">{fileSize(capture.maxBytes)} max</span></div>
      <section className={`recorder-card${recording ? ' is-recording' : ''}`} aria-label="Screen recorder">
        <div className="player-topbar"><div className="player-status" role="status" aria-live="polite">{recording ? <><span className={`record-dot${capture.phase === 'paused' ? '' : ' pulsing'}`} /><span>{capture.phase === 'paused' ? 'Paused' : 'Recording'}</span></> : saving ? <Spinner label={saveState === 'finalizing' ? 'Getting your link…' : `Uploading · ${progress}%`} /> : <><span className="status-dot" /><span>{preview ? 'Preview' : 'Ready to record'}</span></>}</div><span className="timecode">{duration(capture.seconds)}</span></div>
        <div className={`video-stage${preview || recording || capture.phase === 'stopping' ? ' video-stage-filled' : ''}`}>
          {preview && blobUrl ? <video key={blobUrl} controls playsInline preload="metadata" src={blobUrl} aria-label="Preview your recording" /> : recording || capture.phase === 'stopping' ? <><video ref={liveVideo} autoPlay playsInline muted aria-label="Live screen preview" />{capture.phase === 'paused' && <span className="preview-state"><Pause size={12} />Paused</span>}{capture.phase === 'stopping' && <div className="video-overlay"><Spinner label="Finishing your recording…" /></div>}</> : <div className="empty-stage"><div className="empty-screen-icon"><Monitor size={31} strokeWidth={1.35} /><span className="empty-record-dot" /></div><h2>{capture.phase === 'requesting' ? 'Pick your screen.' : 'A little video goes a long way.'}</h2><p>{capture.phase === 'requesting' ? 'Choose what to share in the browser prompt.' : 'A tab, a window, or the whole picture.'}</p>{capture.phase === 'requesting' && <LoaderCircle className="spinner" size={18} aria-label="Waiting for screen selection" />}</div>}
        </div>
        {saving && <progress className="upload-progress" aria-label="Upload progress" value={progress} max={100} />}
        <div className="recorder-toolbar">
          {preview ? <><span className="recording-meta">{fileSize(capture.blob?.size ?? 0)}<span>·</span>{saving ? 'Keep this tab open while we save.' : 'Your recording stays here until it’s saved.'}</span><Button asChild variant="ghost" size="sm"><a href={blobUrl} download={`slop-rooster.${capture.blob?.type === 'video/mp4' ? 'mp4' : 'webm'}`}><Download /><span className="download-label">Download video</span></a></Button></> : <><div className="audio-controls"><Button variant="ghost" size="sm" className={microphone ? 'audio-button audio-enabled' : 'audio-button'} aria-pressed={microphone} onClick={() => setMicrophone(!microphone)} disabled={active} title={microphone ? 'Microphone on' : 'Microphone off'}>{microphone ? <Mic /> : <MicOff />}<span>Mic {microphone ? 'on' : 'off'}</span></Button><Button variant="ghost" size="sm" className={systemAudio ? 'audio-button audio-enabled' : 'audio-button'} aria-pressed={systemAudio} onClick={() => setSystemAudio(!systemAudio)} disabled={active} title="System audio is available when supported by your selected screen or tab">{systemAudio ? <Volume2 /> : <VolumeX />}<span>System audio</span></Button></div><div className="capture-actions">{recording ? <><Button variant="outline" size="icon" onClick={capture.pauseOrResume} aria-label={capture.phase === 'paused' ? 'Resume recording' : 'Pause recording'}>{capture.phase === 'paused' ? <Play /> : <Pause />}</Button><Button className="stop-recording-button" onClick={capture.stop}><Square className="stop-icon" /><span>Stop recording</span></Button></> : <Button disabled={!canCapture || active} onClick={() => void capture.start({ microphone, systemAudio })}>{active ? <Spinner label="One moment…" /> : <><span className="button-record-dot" />Start recording</>}</Button>}</div></>}
        </div>
      </section>
      {!preview && <div className="studio-caption"><span><LockKeyhole size={12} />You choose what gets recorded.</span><span>Video saves automatically when you stop.</span></div>}
      {capture.error && <Notice error>{capture.error}</Notice>}
      {capture.notice && <Notice>{capture.notice}</Notice>}
      {logoutError && <Notice error>{logoutError}</Notice>}
      {!canCapture && <Notice>Screen recording needs a desktop browser. Open Slop Rooster in Chrome, Edge, or Firefox on your computer.</Notice>}
      {configLoaded && !config.configured && <Notice error>Uploads are temporarily unavailable. You can still record and download your video. <button className="inline-link" onClick={() => void refreshConfig()}>Check again</button></Notice>}
      {tooLarge && <Notice error>This recording is larger than {fileSize(config.maxBytes)}. Download a copy to keep it.</Notice>}
      {saveError && <Notice error><div className="upload-retry"><span>{saveError}</span><Button size="sm" variant="outline" onClick={() => void saveRecording()} disabled={saving || tooLarge || !config.configured}><RefreshCw />Retry upload</Button></div></Notice>}
    </main>
    <Footer />
  </>;
}

function Viewer({ id, view, token = '', sessionRevision, onLogout }: { id: string; view: RecordingView; token?: string; sessionRevision: number; onLogout: () => Promise<void> }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mediaError, setMediaError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setDenied(false);
    void api<Recording>(recordingApiPath(id, '', token, view)).then((result) => {
      if (cancelled) return;
      if (view === 'manage' && !result.isOwner) {
        window.dispatchEvent(new Event('slop-rooster:session-expired'));
        throw new ApiError('Sign in to manage this recording.', 'authentication_required', 401);
      }
      setRecording(result);
      document.title = `${view === 'manage' ? 'Manage' : 'Watch'} · Slop Rooster`;
    }).catch((reason) => {
      if (!cancelled) { setError(messageOf(reason)); setDenied(view === 'public' && reason instanceof ApiError && reason.status === 403); setRecording(null); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, token, view, sessionRevision, attempt]);

  return <>
    <Header>{view === 'manage' && <><Button asChild variant="outline" size="sm"><a href="/"><Plus />New recording</a></Button><Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void onLogout().catch((reason) => setError(messageOf(reason)))}><LogOut /></Button></>}</Header>
    <main className="viewer-main page-width">
      {loading && !recording ? <div className="page-state"><Spinner label="Getting your recording…" /></div> : !recording ? <div className="page-state"><div className="state-symbol">{denied ? <LockKeyhole /> : <Monitor />}</div><h1>{denied ? 'This link needs its token.' : 'Nothing to play here.'}</h1><p>{denied ? 'Ask the sender for the complete sharing link.' : error}</p><div className="state-actions"><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}><RefreshCw />Try again</Button><Button asChild variant="ghost"><a href="/"><ArrowLeft />Back to the studio</a></Button></div></div> : <>
        <div className="page-heading"><div><div className="eyebrow">{view === 'manage' ? 'YOUR RECORDING' : 'SHARED WITH YOU'}</div><h1>{view === 'manage' ? 'Ready when you are.' : 'A little show & tell.'}</h1></div><span className="heading-meta">{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(recording.createdAt))}<span>·</span>{duration(recording.durationSeconds)}</span></div>
        <section className="recorder-card" aria-label="Shared recording"><div className="video-stage video-stage-filled"><video key={`${recording.videoUrl}:${attempt}`} src={recording.videoUrl} controls playsInline preload="metadata" aria-label="Shared video" onError={() => setMediaError(true)} onLoadedData={() => setMediaError(false)} /></div><div className="recorder-toolbar"><span className="recording-meta">{recording.protected ? <LockKeyhole size={13} /> : <Check size={13} />}{recording.protected ? 'Protected link' : 'Ready to watch'}<span>·</span>{fileSize(recording.sizeBytes)}</span><Button asChild variant="ghost" size="sm"><a href={recording.videoUrl} download={`slop-rooster.${recording.contentType === 'video/mp4' ? 'mp4' : 'webm'}`}><Download /><span>Download video</span></a></Button></div></section>
        {mediaError && <Notice error>This video couldn’t load. <button className="inline-link" onClick={() => { setMediaError(false); setAttempt((value) => value + 1); }}>Try again</button></Notice>}
        {error && <Notice error>{error}</Notice>}
        <RecordingDetails key={`${view}:${id}`} recording={recording} onChange={setRecording} view={view} token={token} />
      </>}
    </main>
    <Footer />
  </>;
}

function readRoute() {
  return { pathname: window.location.pathname, search: window.location.search };
}

export default function App() {
  const [session, setSession] = useState<'loading' | 'authenticated' | 'anonymous'>('loading');
  const [sessionError, setSessionError] = useState('');
  const [sessionRevision, setSessionRevision] = useState(0);
  const [loginRequired, setLoginRequired] = useState(false);
  const [route, setRoute] = useState(readRoute);
  const recordingRoute = /^\/(v|manage)\/([0-9a-f-]{36})\/?$/i.exec(route.pathname);
  const viewerId = recordingRoute?.[1].toLowerCase() === 'v' ? recordingRoute[2] : undefined;
  const manageId = recordingRoute?.[1].toLowerCase() === 'manage' ? recordingRoute[2] : undefined;
  const token = new URLSearchParams(route.search).get('token') ?? '';

  const loadSession = useCallback(async () => {
    setSessionError('');
    try {
      const result = await api<{ authenticated: boolean }>('/api/session');
      setSession(result.authenticated ? 'authenticated' : 'anonymous');
    } catch (reason) { setSessionError(messageOf(reason)); }
  }, []);

  useEffect(() => {
    const changed = () => setRoute(readRoute());
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  useEffect(() => { if (!viewerId) void loadSession(); }, [loadSession, viewerId]);
  useEffect(() => {
    const expired = () => { if (!viewerId) setLoginRequired(true); };
    window.addEventListener('slop-rooster:session-expired', expired);
    return () => window.removeEventListener('slop-rooster:session-expired', expired);
  }, [viewerId]);

  const logout = useCallback(async () => {
    await api('/api/session', { method: 'DELETE' });
    setSession('anonymous');
    setLoginRequired(false);
  }, []);

  const recordingSaved = useCallback((recording: Recording) => {
    window.history.replaceState(null, '', `/manage/${recording.id}`);
    setRoute(readRoute());
    document.title = 'Manage · Slop Rooster';
  }, []);

  const signedIn = () => {
    setSession('authenticated');
    setSessionRevision((revision) => revision + 1);
    setLoginRequired(false);
  };

  // A sharing link always uses reader access, including in the creator's browser.
  if (viewerId) return <Viewer key={`public:${viewerId}:${token}`} id={viewerId} view="public" token={token} sessionRevision={0} onLogout={logout} />;
  if (session === 'loading') return <><Header /><main className="page-state page-width">{sessionError ? <><Notice error>{sessionError}</Notice><Button variant="outline" onClick={() => void loadSession()}><RefreshCw />Try again</Button></> : <Spinner label="Opening the studio…" />}</main><Footer /></>;
  if (session === 'anonymous') return <Login onSuccess={signedIn} />;
  return <>{manageId ? <Viewer key={`manage:${manageId}`} id={manageId} view="manage" sessionRevision={sessionRevision} onLogout={logout} /> : <Recorder onLogout={logout} onSaved={recordingSaved} />}{loginRequired && <Login modal onSuccess={signedIn} onClose={() => setLoginRequired(false)} />}</>;
}
