import { useCallback, useEffect, useRef, useState } from 'react';
import fixWebmDuration from 'fix-webm-duration';

export type CapturePhase = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping' | 'preview';

export function useScreenRecorder(maxBytes: number, maxDurationSeconds: number) {
  const [phase, setPhaseState] = useState<CapturePhase>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const phaseRef = useRef<CapturePhase>('idle');
  const recorder = useRef<MediaRecorder | null>(null);
  const sources = useRef<MediaStream[]>([]);
  const context = useRef<AudioContext | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeMs = useRef(0);
  const startedAt = useRef(0);
  const mounted = useRef(true);
  const captureVersion = useRef(0);
  const limits = useRef({ maxBytes, maxDurationSeconds });
  limits.current = { maxBytes, maxDurationSeconds };

  const setPhase = useCallback((next: CapturePhase) => {
    phaseRef.current = next;
    if (mounted.current) setPhaseState(next);
  }, []);

  const releaseDevices = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    sources.current.forEach((source) => source.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    }));
    sources.current = [];
    if (context.current && context.current.state !== 'closed') void context.current.close().catch(() => {});
    context.current = null;
    if (mounted.current) setStream(null);
  }, []);

  const elapsed = useCallback(() => activeMs.current + (phaseRef.current === 'recording' ? performance.now() - startedAt.current : 0), []);

  const stop = useCallback(() => {
    if (!recorder.current || !['recording', 'paused'].includes(phaseRef.current)) return;
    activeMs.current = elapsed();
    setSeconds(activeMs.current / 1000);
    setPhase('stopping');
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (recorder.current.state !== 'inactive') recorder.current.stop();
  }, [elapsed, setPhase]);

  const pauseOrResume = useCallback(() => {
    const current = recorder.current;
    if (!current) return;
    if (current.state === 'recording') {
      activeMs.current = elapsed();
      current.pause();
      setSeconds(activeMs.current / 1000);
      setPhase('paused');
    } else if (current.state === 'paused') {
      startedAt.current = performance.now();
      current.resume();
      setPhase('recording');
    }
  }, [elapsed, setPhase]);

  const start = useCallback(async ({ microphone, systemAudio }: { microphone: boolean; systemAudio: boolean }) => {
    if (!['idle', 'preview'].includes(phaseRef.current)) return;
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      setError('Screen recording isn’t available in this browser. Open Little Loom in a recent desktop version of Chrome, Edge, or Firefox.');
      return;
    }
    const version = ++captureVersion.current;
    setError('');
    setNotice('');
    setPhase('requesting');
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: systemAudio,
      });
      if (!mounted.current || version !== captureVersion.current) {
        display.getTracks().forEach((track) => track.stop());
        return;
      }
      sources.current.push(display);
      const audioTracks = [...display.getAudioTracks()];
      if (microphone) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
          if (!mounted.current || version !== captureVersion.current) {
            mic.getTracks().forEach((track) => track.stop());
            releaseDevices();
            return;
          }
          sources.current.push(mic);
          audioTracks.push(...mic.getAudioTracks());
        } catch {
          if (mounted.current) setNotice('Your microphone wasn’t available. Your screen is being recorded without your voice.');
        }
      }
      if (!mounted.current || version !== captureVersion.current) {
        releaseDevices();
        return;
      }
      const videoTrack = display.getVideoTracks()[0];
      if (!videoTrack || videoTrack.readyState === 'ended') throw new Error('Screen sharing ended before recording could start. Please try again.');
      let recordingAudio = audioTracks;
      if (audioTracks.length > 1) {
        const audioContext = new AudioContext();
        context.current = audioContext;
        const destination = audioContext.createMediaStreamDestination();
        audioTracks.forEach((track) => audioContext.createMediaStreamSource(new MediaStream([track])).connect(destination));
        await audioContext.resume();
        if (!mounted.current || version !== captureVersion.current) {
          destination.stream.getTracks().forEach((track) => track.stop());
          releaseDevices();
          return;
        }
        recordingAudio = destination.stream.getAudioTracks();
        sources.current.push(destination.stream);
      }
      if (display.getVideoTracks()[0]?.readyState !== 'live') throw new Error('Screen sharing ended before recording could start. Please try again.');
      const output = new MediaStream([...display.getVideoTracks(), ...recordingAudio]);
      const mimeType = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This browser can’t save a supported video format. Please try Chrome, Edge, or Firefox on a desktop.');
      const mediaRecorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: 2_500_000 });
      recorder.current = mediaRecorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size) {
          chunks.push(event.data);
          bytes += event.data.size;
        }
        if (bytes >= limits.current.maxBytes - 5 * 1024 * 1024 && ['recording', 'paused'].includes(phaseRef.current)) {
          setNotice('Recording stopped near the file size limit. Your recording is ready to save.');
          stop();
        }
      };
      mediaRecorder.onstop = async () => {
        releaseDevices();
        if (!mounted.current) return;
        let result = new Blob(chunks, { type: mediaRecorder.mimeType.startsWith('video/mp4') ? 'video/mp4' : 'video/webm' });
        recorder.current = null;
        if (!result.size) {
          setError('The browser didn’t capture any video. Please choose a screen or window and try again.');
          setPhase('idle');
          return;
        }
        if (result.type === 'video/webm') {
          try { result = await fixWebmDuration(result, activeMs.current, { logger: false }); } catch { /* Keep the original capture if duration repair is unavailable. */ }
        }
        if (!mounted.current || version !== captureVersion.current) return;
        setBlob(result);
        setSeconds(activeMs.current / 1000);
        setPhase('preview');
      };
      mediaRecorder.onerror = () => {
        setError('The browser interrupted recording. Any video captured so far will be kept for you to download.');
        stop();
      };
      videoTrack.onended = stop;
      activeMs.current = 0;
      startedAt.current = performance.now();
      setSeconds(0);
      setBlob(null);
      setStream(output);
      setPhase('recording');
      mediaRecorder.start(1000);
      timer.current = setInterval(() => {
        const currentSeconds = elapsed() / 1000;
        setSeconds(currentSeconds);
        if (currentSeconds >= limits.current.maxDurationSeconds) {
          setNotice(`You reached the ${Math.round(limits.current.maxDurationSeconds / 60)}-minute limit. Your recording is ready to save.`);
          stop();
        }
      }, 250);
    } catch (reason) {
      releaseDevices();
      if (!mounted.current) return;
      const name = reason instanceof DOMException ? reason.name : '';
      setError(name === 'NotAllowedError' || name === 'AbortError'
        ? 'Screen sharing was cancelled or not allowed. Choose Start recording whenever you’re ready to try again.'
        : reason instanceof Error ? reason.message : 'Recording couldn’t start. Please try again.');
      setPhase('idle');
    }
  }, [elapsed, releaseDevices, setPhase, stop]);

  const reset = useCallback(() => {
    if (['recording', 'paused', 'requesting', 'stopping'].includes(phaseRef.current)) return;
    setBlob(null);
    setSeconds(0);
    setError('');
    setNotice('');
    setPhase('idle');
  }, [setPhase]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      captureVersion.current += 1;
      const current = recorder.current;
      if (current && current.state !== 'inactive') {
        current.onstop = null;
        current.ondataavailable = null;
        current.onerror = null;
        current.stop();
      }
      releaseDevices();
    };
  }, [releaseDevices]);

  return { phase, stream, blob, seconds, error, notice, start, stop, pauseOrResume, reset };
}
