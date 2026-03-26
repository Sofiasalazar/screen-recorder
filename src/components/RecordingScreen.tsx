import { useEffect, useRef } from 'react';
import { CameraOverlay } from './CameraOverlay';
import { RecordingControls } from './RecordingControls';

interface RecordingScreenProps {
  compositeStream: MediaStream | null;
  cameraStream: MediaStream | null;
  cameraEnabled: boolean;
  isPaused: boolean;
  elapsedSeconds: number;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function RecordingScreen({
  compositeStream,
  cameraStream,
  cameraEnabled,
  isPaused,
  elapsedSeconds,
  onPause,
  onResume,
  onStop,
}: RecordingScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && compositeStream) {
      videoRef.current.srcObject = compositeStream;
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [compositeStream]);

  const showCameraOverlay = cameraEnabled && cameraStream && cameraStream.getVideoTracks().length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Preview area */}
      <div className="flex-1 relative bg-black flex items-center justify-center min-h-0">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain"
        />

        {showCameraOverlay && <CameraOverlay stream={cameraStream} />}

        {/* Paused overlay */}
        {isPaused && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <span className="px-4 py-2 rounded-lg bg-yellow-500/20 border border-yellow-500/30 text-yellow-400 text-sm font-medium">
              Paused
            </span>
          </div>
        )}
      </div>

      {/* Controls */}
      <RecordingControls
        isPaused={isPaused}
        elapsedSeconds={elapsedSeconds}
        onPause={onPause}
        onResume={onResume}
        onStop={onStop}
      />
    </div>
  );
}
