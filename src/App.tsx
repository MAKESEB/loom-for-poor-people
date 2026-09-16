import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, uploadBlob, type Recording, type Upload } from './client/api';
import { useScreenRecorder } from './client/useScreenRecorder';

type IconName = 'screen' | 'mic' | 'volume' | 'arrow' | 'link' | 'download' | 'check' | 'pause' | 'play' | 'stop' | 'close' | 'clock' | 'external' | 'lock' | 'refresh' | 'warning';

function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    screen: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8" /></>,
    volume: <><path d="M11 4L6 8H3v8h3l5 4V4zM15 8a6 6 0 010 8M18 5a10 10 0 010 14" /></>,
    arrow: <><path d="M4 12h16M14 6l6 6-6 6" /></>,
    link: <><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-2 2M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l2-2" /></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5M4 16v4a1 1 0 001 1h14a1 1 0 001-1v-4" /></>,
    check: <path d="M5 12l4 4L19 6" />,
    pause: <><path d="M8 5v14M16 5v14" strokeWidth="4" /></>,
    play: <path d="M8 4l12 8-12 8V4z" fill="currentColor" strokeWidth="1" />,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />,
    close: <path d="M6 6l12 12M18 6L6 18" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    external: <><path d="M14 3h7v7M21 3L10 14M10 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 018 0v4M12 14v3" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0113-3l2 3M4 16l2 3a8 8 0 0013-3" /></>,
    warning: <><path d="M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{paths[name]}</svg>;
}

function Brand() {
  return <a className="brand" href="/" aria-label="Little Loom home">
    <span className="brand-mark" aria-hidden="true"><span /></span>
    <span className="brand-name">little loom<span className="brand-caption">Loom for poor people</span></span>
  </a>;
}

function Header({ viewer = false }: { viewer?: boolean }) {
  return <header className="site-header page-width">
    <Brand />
    <div className="header-right">
      {viewer ? <a className="button button-small button-outline" href="/"><Icon name="screen" size={16} /> Make your own</a> : <><span className="header-note">Less meetings. More doing.</span><a className="how-link" href="#how-it-works">How it works <Icon name="arrow" size={15} /></a></>}
    </div>
  </header>;
}

function Footer() {
  return <footer className="site-footer page-width"><span>A small tool for getting your point across.</span><span>Made for the “let me show you” moments.<span className="footer-spark" aria-hidden="true">✳</span></span></footer>;
}

function formatDuration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}

function formatSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date));
}

function Toggle({ checked, onChange, icon, title, description, disabled = false }: {
  checked: boolean; onChange: (checked: boolean) => void; icon: IconName; title: string; description: string; disabled?: boolean;
}) {
  return <label className={`setting ${disabled ? 'setting-disabled' : ''}`}>
    <span className="setting-icon"><Icon name={icon} size={19} /></span>
    <span className="setting-copy"><span className="setting-title">{title}</span><span className="setting-description">{description}</span></span>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} />
    <span className="toggle-track" aria-hidden="true"><span /></span>
  </label>;
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'warning' : 'check'} size={17} /><span>{children}</span></div>;
}

type RecentRecording = Pick<Recording, 'id' | 'title' | 'createdAt' | 'durationSeconds'>;
const RECENT_KEY = 'little-loom:recent';

function readRecent(): RecentRecording[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item: unknown): item is RecentRecording => !!item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' && /^[a-f0-9-]{36}$/i.test(item.id) && 'title' in item && typeof item.title === 'string' && 'createdAt' in item && typeof item.createdAt === 'string' && Number.isFinite(new Date(item.createdAt).getTime()) && 'durationSeconds' in item && typeof item.durationSeconds === 'number').slice(0, 3);
  } catch { return []; }
}

function ScreenIllustration() {
  return <div className="screen-illustration" aria-hidden="true">
    <div className="illustration-window">
      <div className="illustration-toolbar"><i /><i /><i /><span /></div>
      <div className="illustration-content"><div className="illustration-sidebar"><span /><span /><span /></div><div className="illustration-lines"><span /><span /><span /></div></div>
      <div className="illustration-record"><span /></div>
    </div>
    <div className="illustration-cursor"><svg width="34" height="40" viewBox="0 0 34 40" fill="none"><path d="M4 3l23 20-12 2-6 10L4 3z" fill="#252720" stroke="#F8F7F3" strokeWidth="3" strokeLinejoin="round" /></svg></div>
    <span className="illustration-star star-one">✳</span><span className="illustration-star star-two">+</span>
  </div>;
}

function Recorder() {
  const [config, setConfig] = useState({ maxBytes: 50 * 1024 * 1024, maxDurationSeconds: 900, configured: true });
  const [microphone, setMicrophone] = useState(false);
  const [systemAudio, setSystemAudio] = useState(true);
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'uploading' | 'finalizing' | 'saved'>('idle');
  const [progress, setProgress] = useState(0);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState<Recording | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [recent, setRecent] = useState(readRecent);
  const [confirmReset, setConfirmReset] = useState(false);
  const [blobUrl, setBlobUrl] = useState('');
  const uploadedSession = useRef<{ id: string; uploadId: string } | null>(null);
  const reservationId = useRef<string | null>(null);
  const reservationBody = useRef<string | null>(null);
  const liveVideo = useRef<HTMLVideoElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capture = useScreenRecorder(config.maxBytes, config.maxDurationSeconds);
  const recording = capture.phase === 'recording' || capture.phase === 'paused';
  const saving = saveState === 'uploading' || saveState === 'finalizing';
  const preview = capture.phase === 'preview';
  const active = recording || capture.phase === 'requesting' || capture.phase === 'stopping';
  const tooLarge = !!capture.blob && capture.blob.size > config.maxBytes;
  const shareUrl = saved ? `${window.location.origin}/v/${saved.id}` : '';
  const canCapture = !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined';

  const refreshConfig = useCallback(async () => {
    await api<{ maxBytes: number; maxDurationSeconds: number; configured?: boolean }>('/api/config').then((value) => {
      if (Number.isFinite(value.maxBytes) && value.maxBytes > 0 && Number.isFinite(value.maxDurationSeconds) && value.maxDurationSeconds > 0) setConfig({ ...value, configured: value.configured !== false });
    }).catch(() => setConfig((value) => ({ ...value, configured: false })));
  }, []);

  useEffect(() => {
    void refreshConfig();
    const retryWhenOnline = () => { void refreshConfig(); };
    window.addEventListener('online', retryWhenOnline);
    return () => window.removeEventListener('online', retryWhenOnline);
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
    if (!active && (!capture.blob || saveState === 'saved')) return;
    const protectRecording = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protectRecording);
    return () => window.removeEventListener('beforeunload', protectRecording);
  }, [active, capture.blob, saveState]);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  async function saveRecording() {
    const blob = capture.blob;
    if (!blob || saving || tooLarge || !config.configured) return;
    setSaveError('');
    setConfirmReset(false);
    setSaveState(uploadedSession.current ? 'finalizing' : 'uploading');
    try {
      if (!uploadedSession.current) {
        setProgress(0);
        const id = reservationId.current ?? crypto.randomUUID();
        reservationId.current = id;
        reservationBody.current ??= JSON.stringify({ id, title: title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || `Screen recording — ${new Date().toLocaleDateString()}`, contentType: blob.type, sizeBytes: blob.size, durationSeconds: Math.min(config.maxDurationSeconds, Math.max(1, Math.round(capture.seconds))) });
        const upload = await api<Upload>('/api/recordings/uploads', {
          method: 'POST',
          body: reservationBody.current,
        });
        if (!upload.alreadyUploaded) await uploadBlob(upload, blob, setProgress);
        else setProgress(100);
        uploadedSession.current = { id: upload.id ?? id, uploadId: upload.uploadId };
      }
      setSaveState('finalizing');
      const session = uploadedSession.current;
      let result: Recording | null = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await api<Recording | { status?: string; retryAfterSeconds?: number }>(`/api/recordings/${session.id}/complete`, { method: 'POST', body: JSON.stringify({ uploadId: session.uploadId }) });
        if ('videoUrl' in response && 'id' in response) { result = response; break; }
        const delay = 'retryAfterSeconds' in response && typeof response.retryAfterSeconds === 'number' ? Math.min(10, Math.max(1, response.retryAfterSeconds)) : 2;
        await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
      }
      if (!result) throw new Error('Your upload is still being prepared. Try saving again in a moment; the video won’t need to upload again.');
      setSaved(result);
      setSaveState('saved');
      const next = [{ id: result.id, title: result.title, createdAt: result.createdAt, durationSeconds: result.durationSeconds }, ...recent.filter((item) => item.id !== result.id)].slice(0, 3);
      setRecent(next);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* Sharing works when browser storage is unavailable. */ }
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'storage_upload_expired') {
        uploadedSession.current = null;
        reservationId.current = null;
        reservationBody.current = null;
      }
      setSaveState('idle');
      setSaveError(reason instanceof Error ? reason.message : 'Your recording couldn’t be saved. Please try again.');
    }
  }

  async function copyLink() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setCopyError(true);
    }
  }

  function reset() {
    capture.reset();
    setSaved(null);
    setTitle('');
    setSaveState('idle');
    setProgress(0);
    setSaveError('');
    setCopied(false);
    setCopyError(false);
    setConfirmReset(false);
    uploadedSession.current = null;
    reservationId.current = null;
    reservationBody.current = null;
  }

  const stageStatus = recording ? capture.phase === 'paused' ? 'Recording paused' : 'Recording in progress' : capture.phase === 'stopping' ? 'Finishing your recording' : preview ? saveState === 'saved' ? 'Saved & ready to share' : 'Your recording is ready' : 'Recording studio';
  const downloadName = `${(title.trim() || 'little-loom-recording').replace(/[^a-z0-9 _-]/gi, '').slice(0, 100)}.${capture.blob?.type === 'video/mp4' ? 'mp4' : 'webm'}`;

  return <><Header /><main className="page-width">
    <section className="hero" aria-labelledby="hero-title">
      <div><div className="eyebrow"><span /> SMALL TOOL. BIG TIME SAVER.</div><h1 id="hero-title">A little recording.<br /><span>A lot less explaining.</span></h1></div>
      <p className="hero-description">Show what you mean. Record your screen,<br className="desktop-break" /> save your video, and send a link.<br /><span>No account. No complicated anything.</span></p>
    </section>

    <section className={`studio ${preview ? 'studio-preview' : ''}`} aria-label="Screen recording studio">
      <div className="studio-topbar"><div className="studio-label"><Icon name={saveState === 'saved' ? 'check' : 'screen'} size={17} /><span aria-live="polite">{stageStatus}</span></div><div className="studio-limit">{preview && capture.blob ? <><span>{formatDuration(capture.seconds)}</span><span className="meta-dot">·</span><span>{formatSize(capture.blob.size)}</span></> : <><Icon name="clock" size={13} /> UP TO {Math.round(config.maxDurationSeconds / 60)} MINUTES</>}</div></div>
      <div className="studio-body">
        <div className="capture-column">
          <div className={`capture-stage ${recording || preview || capture.phase === 'stopping' ? 'has-video' : ''}`}>
            {preview && blobUrl ? <video className="recording-video" controls playsInline preload="metadata" src={blobUrl} aria-label="Preview your recording" /> : recording || capture.phase === 'stopping' ? <><video className="recording-video live-preview" ref={liveVideo} autoPlay playsInline muted aria-label="Live screen preview" /><div className={`live-badge ${capture.phase === 'paused' ? 'is-paused' : ''}`}><span />{capture.phase === 'paused' ? 'PAUSED' : 'LIVE PREVIEW'}</div>{capture.phase === 'stopping' && <div className="stage-overlay"><span className="spinner" />Finishing up…</div>}</> : <div className="empty-stage"><ScreenIllustration /><h2>{capture.phase === 'requesting' ? 'Pick your screen. We’ll wait.' : 'Your next “let me show you.”'}</h2><p>{capture.phase === 'requesting' ? 'Choose a tab, window, or screen in your browser’s sharing prompt.' : 'A quick walkthrough beats a long explanation.'}</p><span className="stage-caption"><Icon name="screen" size={14} /> Tab, window, or entire screen</span></div>}
          </div>
          <div className="capture-bottom">
            <span className="capture-hint"><Icon name={preview ? 'check' : 'lock'} size={14} />{saveState === 'saved' ? 'Saved. Your link is ready.' : preview ? 'Captured. Give it a quick look.' : recording ? 'Only your selected screen is recorded.' : 'You choose what gets recorded.'}</span>
            <span className={`time-display ${recording ? 'time-active' : ''}`}><span className={capture.phase === 'recording' ? 'recording-dot is-recording' : 'recording-dot'} />{formatDuration(capture.seconds)}</span>
          </div>
        </div>

        <aside className="studio-sidebar" aria-label="Recording controls">
          {preview ? saveState === 'saved' ? <>
            <div className="success-icon"><Icon name="check" size={24} /></div><div className="sidebar-heading"><h2>Good to go.</h2><p>A little link. Ready to do<br className="desktop-break" /> the explaining for you.</p></div>
            <div className="share-field"><label htmlFor="share-link">Your share link</label><input id="share-link" ref={linkInput} value={shareUrl} readOnly onFocus={(event) => event.currentTarget.select()} /><button className="button button-primary" onClick={() => void copyLink()}><Icon name={copied ? 'check' : 'link'} size={18} />{copied ? 'Link copied!' : 'Copy link'}</button><span className="share-disclosure">Anyone with this link can watch.</span></div>
            {copyError && <Notice>Select the link above and copy it with your keyboard.</Notice>}
            <a className="text-button view-recording" href={shareUrl} target="_blank" rel="noreferrer">Open your recording <Icon name="external" size={14} /></a>
            <div className="sidebar-bottom"><button className="button button-outline" onClick={reset}><Icon name="refresh" size={16} /> Record another</button></div>
          </> : <>
            <div className="sidebar-heading"><span className="mini-eyebrow">THAT’S A WRAP</span><h2>Looking good?</h2><p>Give it a name, save it,<br className="desktop-break" /> and pass it on.</p></div>
            <div className="title-field"><label htmlFor="recording-title">Recording title <span>optional</span></label><input id="recording-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What’s this one about?" maxLength={100} disabled={saving || !!reservationId.current} /></div>
            <div className="save-actions"><button className="button button-primary" onClick={() => void saveRecording()} disabled={saving || tooLarge || !config.configured}>{saving ? <><span className="spinner" />{saveState === 'finalizing' ? 'Getting your link…' : `Saving… ${progress}%`}</> : <><Icon name="link" size={18} />{saveError ? 'Try saving again' : 'Save & get link'}</>}</button>{saving && <div className="upload-progress" role="progressbar" aria-label="Upload progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div>}<span className="share-disclosure">Anyone with your link can watch.<br />Keep this tab open until saving is done.</span></div>
            <a className="text-button download-local" href={blobUrl} download={downloadName}><Icon name="download" size={16} /> Download video</a>
            <div className="sidebar-bottom">{confirmReset ? <div className="reset-confirm"><p>Discard this unsaved recording?</p><div><button className="text-button" onClick={() => setConfirmReset(false)}>Keep it</button><button className="text-button text-danger" onClick={reset}>Discard & start over</button></div></div> : <button className="text-button start-over" disabled={saving} onClick={() => setConfirmReset(true)}><Icon name="refresh" size={14} /> Start over</button>}</div>
          </> : <>
            <div className="sidebar-heading"><span className="mini-eyebrow">{recording ? 'YOU’VE GOT THE FLOOR' : 'READY WHEN YOU ARE'}</span><h2>{capture.phase === 'paused' ? 'Take a breather.' : recording ? 'You’re rolling.' : 'Show your thing.'}</h2><p>{capture.phase === 'paused' ? 'Your recording is paused. Pick up right where you left off.' : recording ? 'Do your thing. We’ll keep the screen recording until you’re done.' : 'A walkthrough, a quick fix, or a very good idea. Hit record.'}</p></div>
            <div className="settings"><Toggle checked={microphone} onChange={setMicrophone} icon="mic" title="Microphone" description="Add your voice" disabled={active} /><Toggle checked={systemAudio} onChange={setSystemAudio} icon="volume" title="System audio" description="If your browser allows it" disabled={active} /></div>
            <div className="record-actions">{recording ? <><button className="button button-primary" onClick={capture.stop}><Icon name="stop" size={16} /> Stop recording</button><button className="button button-outline pause-button" onClick={capture.pauseOrResume}><Icon name={capture.phase === 'paused' ? 'play' : 'pause'} size={14} />{capture.phase === 'paused' ? 'Resume recording' : 'Pause recording'}</button></> : <button className="button button-primary" onClick={() => void capture.start({ microphone, systemAudio })} disabled={active || !canCapture}>{active ? <><span className="spinner" />{capture.phase === 'requesting' ? 'Choose your screen…' : 'Finishing up…'}</> : <><span className="button-record-dot" /> Start recording <Icon name="arrow" size={17} /></>}</button>}<p className="record-footnote">{recording ? 'Stop to preview, save, and share.' : `${Math.round(config.maxDurationSeconds / 60)} minutes max · ${formatSize(config.maxBytes)} per video`}</p></div>
            {!recording && <div className="sidebar-bottom browser-tip"><span className="tiny-spark" aria-hidden="true">✳</span><p>Sharing a browser tab? Turn on<br className="desktop-break" /> “Share tab audio” in the picker.</p></div>}
          </>}
        </aside>
      </div>
    </section>

    <div className="notifications">{!config.configured && <Notice error>Sharing is temporarily unavailable. You can still record and download. <button className="inline-button" onClick={() => void refreshConfig()}>Check again</button></Notice>}{!canCapture && !preview && <Notice error>Screen recording needs a desktop browser that supports screen sharing. Try a recent version of Chrome, Edge, or Firefox.</Notice>}{capture.error && <Notice error>{capture.error}</Notice>}{capture.notice && <Notice>{capture.notice}</Notice>}{saveError && <Notice error>{saveError}</Notice>}{tooLarge && <Notice error>This recording is larger than the {formatSize(config.maxBytes)} upload limit. Download it to keep a local copy.</Notice>}</div>

    <section className="how-section" id="how-it-works" aria-label="How it works"><div className="how-intro"><span className="mini-eyebrow">LESS FRICTION. MORE SHOWING.</span><h2>Three steps.<br />Then it’s off your plate.</h2></div><div className="how-step"><span className="step-number">01</span><div><h3>Record your screen</h3><p>Pick what to share.<br />Add your voice, if you like.</p></div></div><div className="how-step"><span className="step-number">02</span><div><h3>Save the good stuff</h3><p>Preview your recording.<br />Give it a name and save.</p></div></div><div className="how-step"><span className="step-number">03</span><div><h3>Send a little link</h3><p>Anyone with the link can watch.<br />No sign-up on either side.</p></div></div></section>

    {recent.length > 0 && <section className="recent-section" aria-labelledby="recent-heading"><div className="recent-heading"><h2 id="recent-heading">Your recent recordings</h2><span>Remembered on this browser</span></div><div className="recent-list">{recent.map((item) => <a className="recent-recording" key={item.id} href={`/v/${item.id}`}><span className="recent-icon"><Icon name="play" size={14} /></span><span className="recent-copy"><strong>{item.title}</strong><span>{formatDate(item.createdAt)} <span aria-hidden="true">·</span> {formatDuration(item.durationSeconds)}</span></span><Icon name="arrow" size={17} /></a>)}</div></section>}
  </main><Footer /></>;
}

function Viewer({ id }: { id: string | null }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState(id ? '' : 'This recording link doesn’t look quite right.');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [reload, setReload] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setVideoError(false);
    void api<Recording>(`/api/recordings/${id}`).then((result) => {
      if (cancelled) return;
      setRecording(result);
      document.title = `${result.title} — Little Loom`;
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'This recording couldn’t be loaded.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, reload]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setCopyError(false);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch { setCopyError(true); }
  }

  return <><Header viewer /><main className="page-width viewer-main">
    {loading ? <div className="viewer-empty" role="status"><span className="spinner" /><h1>Getting your recording…</h1><p>A little moment, please.</p></div> : error ? <div className="viewer-empty"><span className="empty-icon"><Icon name="link" size={28} /></span><span className="mini-eyebrow">A LITTLE DETOUR</span><h1>No recording here.</h1><p>{error}</p><p className="muted">Check the full link with the person who shared it.</p><div className="viewer-empty-actions">{id && <button className="button button-outline" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={16} />Try again</button>}<a href="/" className="button button-primary">Make a recording <Icon name="arrow" size={17} /></a></div></div> : recording ? <>
      <div className="viewer-heading"><div><div className="eyebrow"><span /> A LITTLE SOMETHING TO SHOW YOU</div><h1>{recording.title}</h1><p className="viewer-meta"><span>{formatDate(recording.createdAt)}</span><span>·</span><span><Icon name="clock" size={14} />{formatDuration(recording.durationSeconds)}</span><span>·</span><span>{formatSize(recording.sizeBytes)}</span></p></div><button className="button button-outline" onClick={() => void copy()}><Icon name={copied ? 'check' : 'link'} size={17} />{copied ? 'Copied!' : 'Copy link'}</button></div>
      {copyError && <Notice>Copy the link from your browser’s address bar to share this recording.</Notice>}
      <div className="viewer-player"><video key={recording.videoUrl} src={recording.videoUrl} controls playsInline preload="metadata" aria-label={recording.title} onError={() => setVideoError(true)} /></div>
      {videoError && <Notice error>This video couldn’t be played. <button className="inline-button" onClick={() => setReload((value) => value + 1)}>Refresh the video</button> or use the download link below to watch it locally.</Notice>}
      <div className="viewer-below"><span><Icon name="link" size={15} />Anyone with this link can watch.</span><a className="text-button" href={recording.videoUrl} download><Icon name="download" size={17} />Download video</a></div>
      <div className="viewer-cta"><div><span className="mini-eyebrow">HAVE SOMETHING TO SHOW?</span><h2>Skip the paragraph. Send a recording.</h2><p>Your screen, your voice, one simple link.</p></div><a className="button button-primary" href="/"><span className="button-record-dot" />Make your own recording<Icon name="arrow" size={17} /></a></div>
    </> : null}
  </main><Footer /></>;
}

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith('/v/')) {
    const match = /^\/v\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(path);
    return <Viewer id={match?.[1] ?? null} />;
  }
  return <Recorder />;
}
