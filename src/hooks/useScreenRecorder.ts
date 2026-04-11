import { useState, useRef, useCallback } from 'react';
import { RecordingPhase, DevicePreferences } from '../types';
import { CanvasCompositor, mergeAudioTracks } from '../lib/canvas-compositor';

interface RecorderState {
  phase: RecordingPhase;
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  compositeStream: MediaStream | null;
  recordedBlob: Blob | null;
  recordedUrl: string | null;
  error: string | null;
}

const DEFAULT_PREFS: DevicePreferences = {
  cameraId: '',
  micId: '',
  cameraEnabled: true,
  micEnabled: true,
};

function getSupportedMimeType(): string {
  const types = [
    // Prefer MP4 (Chrome 116+) for universal playback
    'video/mp4;codecs=avc1,opus',
    'video/mp4;codecs=avc1,aac',
    'video/mp4',
    // Fallback to WebM (existing behavior, unchanged)
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

function getFileExtension(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
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
  });

  const [preferences, setPreferences] = useState<DevicePreferences>(DEFAULT_PREFS);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const updatePreferences = useCallback((partial: Partial<DevicePreferences>) => {
    setPreferences((prev) => ({ ...prev, ...partial }));
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setState((s) => ({ ...s, error: null }));

      // 1. Get screen stream at maximum resolution
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30, max: 60 },
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

      const compositor = new CanvasCompositor(screenVideoTrack, cameraVideoTrack);
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

      // 6. Create MediaRecorder with bitrate scaled to actual resolution
      const mimeType = getSupportedMimeType();
      const pixels = compositor.width * compositor.height;
      let bitrate = 16_000_000; // 16 Mbps baseline for <= 1080p
      if (pixels > 2_073_600) bitrate = 25_000_000; // > 1080p: 25 Mbps
      if (pixels > 3_686_400) bitrate = 40_000_000; // > 1440p: 40 Mbps

      const recorder = new MediaRecorder(finalStream, {
        mimeType,
        videoBitsPerSecond: bitrate,
      });

      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setState((s) => ({
          ...s,
          phase: 'playback',
          recordedBlob: blob,
          recordedUrl: url,
        }));
      };

      recorderRef.current = recorder;
      recorder.start(250); // Collect data every 250ms for smoother output

      // Listen for screen share ended
      screenVideoTrack.onended = () => {
        stopRecording();
      };

      setState({
        phase: 'recording',
        screenStream,
        cameraStream,
        compositeStream: compositor.getStream(),
        recordedBlob: null,
        recordedUrl: null,
        error: null,
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
    recorderRef.current = null;

    setState({
      phase: 'setup',
      screenStream: null,
      cameraStream: null,
      compositeStream: null,
      recordedBlob: null,
      recordedUrl: null,
      error: null,
    });
  }, [state.recordedUrl]);

  return {
    state,
    preferences,
    updatePreferences,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetRecording,
  };
}
