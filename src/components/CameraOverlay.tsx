import { useEffect, useRef } from 'react';

interface CameraOverlayProps {
  stream: MediaStream;
}

export function CameraOverlay({ stream }: CameraOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div className="absolute bottom-4 left-4 w-[20%] min-w-[120px] max-w-[240px] rounded-xl overflow-hidden border-2 border-brand-violet shadow-lg shadow-black/50">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full aspect-video object-cover bg-black"
      />
    </div>
  );
}
