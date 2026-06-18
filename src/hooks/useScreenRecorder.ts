import { useState, useRef, useCallback } from 'react';
import { RecordingPhase, DevicePreferences, CameraSize, LayoutMode } from '../types';
import { CanvasCompositor, mergeAudioTracks } from '../lib/canvas-compositor';
import { canStreamToDisk, closeWithTimeout, generateRecordingFilename } from '../lib/file-utils';

interface RecorderState {
  phase: RecordingPhase;
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  compositeStream: MediaStream | null;
  recordedBlob: Blob | null;
  recordedUrl: string | null;
  error: string | null;
  layoutMode: LayoutMode;
  canvasWidth: number;
  canvasHeight: number;
}

const DEFAULT_PREFS: DevicePreferences = {
  cameraId: '',
  micId: '',
  cameraEnabled: true,
  micEnabled: true,
  cameraSize: 'medium',
  backgroundMode: 'none',
  chromaKey: false,
  layoutMode: 'pip',
};

function getSupportedMimeType(): string {
  // WebM only. Chrome's MP4 MediaRecorder can silently produce blank
  // video when encoding high-resolution canvas streams. Same failure mode
  // affects Chrome's h264-in-WebM encoder at >1440p, so VP9 is preferred
  // first -- it's the most predictable software encoder for our use case.
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm;codecs=h264',
    'video/webm',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

export function useScreenRecorder() {
  const [state, setState] = useState<RecorderState>({
    phase: 'setup',
    screenStream: null,
    cameraStream: null,
    compositeStream: null,
    recordedBlob: null,
    recordedUrl: null,
    error: null,
    layoutMode: 'pip',
    canvasWidth: 0,
    canvasHeight: 0,
  });

  const [preferences, setPreferences] = useState<DevicePreferences>(DEFAULT_PREFS);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Streaming-to-disk refs. Active only when canStreamToDisk is true and the
  // user confirms the save-file picker. Keeps memory flat regardless of
  // recording length.
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const writableRef = useRef<FileSystemWritableFileStream | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const streamingRef = useRef<boolean>(false);
  // Re-entry guard so a double-click on Start doesn't fire two overlapping
  // startRecording() calls that would clobber each other's refs.
  const startingRef = useRef<boolean>(false);
  // Set to true the first time a disk write fails so subsequent chunks are
  // skipped (no more queueing on a broken writable, no more error spam).
  const writeFailedRef = useRef<boolean>(false);

  const updatePreferences = useCallback((partial: Partial<DevicePreferences>) => {
    setPreferences((prev) => ({ ...prev, ...partial }));
  }, []);

  const startRecording = useCallback(async () => {
    // Re-entry guard: if a previous startRecording is still in flight (e.g.
    // user double-clicked or the file picker is still up), ignore. Without
    // this, two overlapping runs clobber each other's refs and produce
    // empty / corrupted recordings.
    if (startingRef.current) {
      console.warn('[recorder] startRecording already in progress, ignoring duplicate click');
      return;
    }
    startingRef.current = true;
    try {
      setState((s) => ({ ...s, error: null }));
      writeFailedRef.current = false;

      // 0. Defensive teardown of anything from a previous attempt that may
      // not have cleaned up cleanly (silent encoder error, screen-share
      // dialog cancel, etc.). Without this, refs leak across attempts and
      // the second recording inherits broken state from the first.
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop(); } catch { /* ignore */ }
      }
      recorderRef.current = null;
      if (compositorRef.current) {
        try { compositorRef.current.destroy(); } catch { /* ignore */ }
        compositorRef.current = null;
      }
      chunksRef.current = [];
      // Drain + close any orphaned writable from a prior attempt. Best
      // effort -- ignore errors (file may already be closed/aborted).
      if (writableRef.current) {
        try {
          await writeQueueRef.current;
          await writableRef.current.close();
        } catch { /* ignore */ }
      }
      fileHandleRef.current = null;
      writableRef.current = null;
      writeQueueRef.current = Promise.resolve();
      streamingRef.current = false;

      // 1. Get screen stream at maximum resolution. Frame rate hard-capped
      // at 30 -- MediaRecorder's software encoder cannot sustain 4K@60.
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: true,
      });

      // 2. Get camera + mic stream
      let cameraStream: MediaStream | null = null;
      const constraints: MediaStreamConstraints = {};

      if (preferences.cameraEnabled) {
        const camVideo: MediaTrackConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
        };
        if (preferences.cameraId) {
          camVideo.deviceId = { exact: preferences.cameraId };
        }
        constraints.video = camVideo;
      }
      if (preferences.micEnabled) {
        constraints.audio = preferences.micId
          ? { deviceId: { exact: preferences.micId } }
          : true;
      }

      if (constraints.video || constraints.audio) {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch {
          // If camera fails, try mic only
          if (constraints.video && constraints.audio) {
            try {
              cameraStream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio });
            } catch {
              // Continue without camera or mic
            }
          }
        }
      }

      // 3. Create canvas compositor
      const screenVideoTrack = screenStream.getVideoTracks()[0];
      const cameraVideoTrack = (preferences.cameraEnabled && cameraStream?.getVideoTracks()[0]) || null;

      const compositor = new CanvasCompositor(screenVideoTrack, cameraVideoTrack, {
        cameraSize: preferences.cameraSize,
        backgroundMode: preferences.backgroundMode,
        chromaKey: preferences.chromaKey,
        layoutMode: preferences.layoutMode,
      });
      compositorRef.current = compositor;

      // Wait for compositor to detect the actual capture resolution
      await compositor.whenReady();

      // 4. Merge audio tracks
      const audioTracks: MediaStreamTrack[] = [];
      const screenAudio = screenStream.getAudioTracks();
      if (screenAudio.length > 0) audioTracks.push(...screenAudio);
      const micAudio = cameraStream?.getAudioTracks() || [];
      if (micAudio.length > 0) audioTracks.push(...micAudio);

      const mergedAudio = mergeAudioTracks(audioTracks);

      // 5. Build final stream
      const compositeVideoTrack = compositor.getStream().getVideoTracks()[0];
      const finalTracks: MediaStreamTrack[] = [compositeVideoTrack];
      if (mergedAudio) finalTracks.push(mergedAudio);
      const finalStream = new MediaStream(finalTracks);

      // 6. Determine codec + bitrate. Ladder tuned to what Chrome's VP9
      // software encoder sustains at 30fps; 24 Mbps at 4K@30 matches
      // YouTube's recommended ingest.
      const mimeType = getSupportedMimeType();
      const pixels = compositor.width * compositor.height;
      let bitrate = 12_000_000; // <= 1080p: 12 Mbps
      if (pixels > 2_073_600) bitrate = 18_000_000; // > 1080p (1440p): 18 Mbps
      if (pixels > 3_686_400) bitrate = 24_000_000; // > 1440p (up to 4K): 24 Mbps

      // 6a. If File System Access API is available, prompt the user for a
      // save location and open a writable stream. Each MediaRecorder chunk
      // will then be written directly to disk (Pipeline A). Memory stays
      // flat regardless of recording length, and the file is crash-safe.
      streamingRef.current = false;
      fileHandleRef.current = null;
      writableRef.current = null;
      writeQueueRef.current = Promise.resolve();

      if (canStreamToDisk && window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: generateRecordingFilename(mimeType),
            types: [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
          });
          const writable = await handle.createWritable();
          fileHandleRef.current = handle;
          writableRef.current = writable;
          streamingRef.current = true;
          console.info('[recorder] streaming to disk via FileSystemWritableFileStream');
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            // User cancelled the file picker. Stop streams + compositor
            // cleanly and return to setup with no error toast. The
            // `finally` at the bottom of startRecording clears startingRef.
            console.info('[recorder] file picker cancelled -- aborting recording start');
            try { compositor.destroy(); } catch { /* ignore */ }
            compositorRef.current = null;
            screenStream.getTracks().forEach((t) => t.stop());
            cameraStream?.getTracks().forEach((t) => t.stop());
            return;
          }
          throw err;
        }
      }

      // 7. Create MediaRecorder
      const recorder = new MediaRecorder(finalStream, {
        mimeType,
        videoBitsPerSecond: bitrate,
      });

      chunksRef.current = [];
      let totalBytes = 0;
      const startedAt = performance.now();
      let lastSizeLogAt = startedAt;

      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        totalBytes += e.data.size;
        const now = performance.now();
        if (now - lastSizeLogAt > 30_000) {
          lastSizeLogAt = now;
          const seconds = Math.round((now - startedAt) / 1000);
          const mb = Math.round(totalBytes / 1048576);
          console.info('[recorder] size t=%ds mb=%d', seconds, mb);
        }
        if (streamingRef.current && writableRef.current) {
          // Skip if a previous write already failed -- the writable is in an
          // error state and further chunks cannot be saved. We've already
          // stopped the recorder, so onstop will fire shortly with whatever
          // made it to disk.
          if (writeFailedRef.current) return;
          // Serialize writes via a Promise chain. write() returns a Promise;
          // chunks are written in order and each Blob is GC-eligible as soon
          // as its write resolves. Never blocks the ondataavailable callback.
          const writable = writableRef.current;
          const data = e.data;
          writeQueueRef.current = writeQueueRef.current
            .then(() => writable.write(data))
            .catch((err) => {
              if (writeFailedRef.current) return; // already reported; stay silent
              writeFailedRef.current = true;
              console.error('[recorder] disk write failed, halting recording:', err);
              setState((s) => ({
                ...s,
                error: `Disk write failed -- ${(err as Error)?.message ?? err}. Recording stopped. The partial file is on disk and may still play.`,
              }));
              // Stop the recorder -- triggers onstop, which will close the
              // writable (in error state, may throw -- caught there) and
              // transition to playback with what made it to disk.
              try {
                if (recorderRef.current && recorderRef.current.state !== 'inactive') {
                  recorderRef.current.stop();
                }
              } catch { /* ignore */ }
            });
        } else {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const seconds = Math.round((performance.now() - startedAt) / 1000);
        const mb = Math.round(totalBytes / 1048576);
        console.info('[recorder] stopped t=%ds mb=%d', seconds, mb);

        // Snapshot all streaming refs LOCALLY before any await, then clear
        // the shared refs immediately. Without this, a new startRecording()
        // call during the await-chain below would mutate the shared refs
        // (close our writable, swap our fileHandle, etc.) and we'd close
        // somebody else's stream or read stale state.
        const wasStreaming = streamingRef.current;
        const writable = writableRef.current;
        const handle = fileHandleRef.current;
        const queue = writeQueueRef.current;
        const chunks = chunksRef.current;
        streamingRef.current = false;
        writableRef.current = null;
        fileHandleRef.current = null;
        writeQueueRef.current = Promise.resolve();
        chunksRef.current = [];

        if (wasStreaming && writable && handle) {
          try {
            await queue;                                    // drain pending writes
            await closeWithTimeout(writable, 10_000);       // finalize file on disk
            const file = await handle.getFile();
            const url = URL.createObjectURL(file);
            setState((s) => ({
              ...s,
              phase: 'playback',
              recordedBlob: file,
              recordedUrl: url,
            }));
          } catch (err) {
            console.error('[recorder] failed to finalize stream:', err);
            setState((s) => ({
              ...s,
              error: `Could not finalize file -- ${(err as Error).message}. The partial recording may still be on disk; try opening it directly.`,
            }));
          }
        } else {
          const blob = new Blob(chunks, { type: mimeType });
          const url = URL.createObjectURL(blob);
          setState((s) => ({
            ...s,
            phase: 'playback',
            recordedBlob: blob,
            recordedUrl: url,
          }));
        }
      };

      recorder.onerror = (e: Event) => {
        const err = (e as Event & { error?: DOMException }).error;
        const msg = err ? `${err.name}: ${err.message}` : 'unknown MediaRecorder error';
        console.error('[recorder] MediaRecorder error:', err ?? e);
        // Only surface the error if we're still actively recording. If
        // onerror fires AFTER onstop has already transitioned to playback
        // or back to setup, don't clobber that state with a stale error.
        setState((s) => {
          if (s.phase !== 'recording' && s.phase !== 'paused') return s;
          return { ...s, error: `Recording error -- ${msg}. The recorder stopped. Try reducing screen resolution or closing other apps.` };
        });
        // Auto-stop so onstop fires and we transition to playback with
        // whatever made it to disk. MediaRecorder.onerror does NOT
        // automatically stop the recorder per spec.
        try {
          if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            recorderRef.current.stop();
          }
        } catch { /* ignore */ }
      };

      recorderRef.current = recorder;
      // 1000ms chunks (was 250ms): fewer ondataavailable callbacks, less
      // GC churn, less main-thread overhead during long recordings.
      recorder.start(1000);

      console.info(
        '[recorder] mimeType=%s bitrate=%d canvas=%dx%d screenFps=%s',
        mimeType,
        bitrate,
        compositor.width,
        compositor.height,
        screenVideoTrack.getSettings().frameRate ?? 'unknown',
      );

      // Listen for screen share ended (user clicked browser's "Stop sharing"
      // bar) and for the track being muted by the OS (monitor sleep, screen
      // lock, etc.). Both end the recording -- log which fired.
      screenVideoTrack.onended = () => {
        console.info('[recorder] screen track ended -- stopping recording');
        stopRecording();
      };
      screenVideoTrack.onmute = () => {
        console.warn('[recorder] screen track was muted (OS sleep / lock / app switch?) -- recording may stall');
      };
      const cameraVideoTrackForLog = cameraStream?.getVideoTracks()[0];
      if (cameraVideoTrackForLog) {
        cameraVideoTrackForLog.onended = () => {
          console.warn('[recorder] camera track ended unexpectedly');
        };
        cameraVideoTrackForLog.onmute = () => {
          console.warn('[recorder] camera track was muted (another app grabbed the camera?)');
        };
      }

      setState({
        phase: 'recording',
        screenStream,
        cameraStream,
        compositeStream: compositor.getStream(),
        recordedBlob: null,
        recordedUrl: null,
        error: null,
        layoutMode: preferences.layoutMode,
        canvasWidth: compositor.width,
        canvasHeight: compositor.height,
      });
    } catch (err: unknown) {
      // User cancelled screen share dialog
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        return;
      }
      setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to start recording',
      }));
    } finally {
      startingRef.current = false;
    }
  }, [preferences]);

  const pauseRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.pause();
      setState((s) => ({ ...s, phase: 'paused' }));
    }
  }, []);

  const resumeRecording = useCallback(() => {
    if (recorderRef.current?.state === 'paused') {
      recorderRef.current.resume();
      setState((s) => ({ ...s, phase: 'recording' }));
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }

    // Stop all streams
    state.screenStream?.getTracks().forEach((t) => t.stop());
    state.cameraStream?.getTracks().forEach((t) => t.stop());

    // Destroy compositor
    compositorRef.current?.destroy();
    compositorRef.current = null;
  }, [state.screenStream, state.cameraStream]);

  const resetRecording = useCallback(() => {
    if (state.recordedUrl) {
      URL.revokeObjectURL(state.recordedUrl);
    }
    chunksRef.current = [];
    fileHandleRef.current = null;
    writableRef.current = null;
    writeQueueRef.current = Promise.resolve();
    streamingRef.current = false;
    writeFailedRef.current = false;
    recorderRef.current = null;

    setState({
      phase: 'setup',
      screenStream: null,
      cameraStream: null,
      compositeStream: null,
      recordedBlob: null,
      recordedUrl: null,
      error: null,
      layoutMode: 'pip',
      canvasWidth: 0,
      canvasHeight: 0,
    });
  }, [state.recordedUrl]);

  const toggleLayout = useCallback(() => {
    if (!compositorRef.current) return;
    setState((s) => {
      const next: LayoutMode = s.layoutMode === 'pip' ? 'face-full' : 'pip';
      compositorRef.current!.setLayoutMode(next);
      return { ...s, layoutMode: next };
    });
  }, []);

  const setPipPosition = useCallback((x: number, y: number) => {
    compositorRef.current?.setPipPosition(x, y);
  }, []);

  const setCameraSize = useCallback((size: CameraSize) => {
    compositorRef.current?.setCameraSize(size);
  }, []);

  return {
    state,
    preferences,
    updatePreferences,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetRecording,
    toggleLayout,
    setPipPosition,
    setCameraSize,
  };
}
