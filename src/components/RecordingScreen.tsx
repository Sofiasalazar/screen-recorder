import { useEffect, useRef, useState } from 'react';
import { RecordingControls } from './RecordingControls';
import { CameraSize, LayoutMode } from '../types';

interface RecordingScreenProps {
  compositeStream: MediaStream | null;
  cameraStream: MediaStream | null;
  cameraEnabled: boolean;
  isPaused: boolean;
  elapsedSeconds: number;
  layoutMode: LayoutMode;
  cameraSize: CameraSize;
  canvasWidth: number;
  canvasHeight: number;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleLayout: () => void;
  onSetPipPosition: (x: number, y: number) => void;
}

const SIZE_MULTIPLIERS: Record<CameraSize, number> = {
  small: 0.18,
  medium: 0.25,
  large: 0.32,
};

const PIP_MARGIN = 24;

export function RecordingScreen({
  compositeStream,
  cameraStream,
  cameraEnabled,
  isPaused,
  elapsedSeconds,
  layoutMode,
  cameraSize,
  canvasWidth,
  canvasHeight,
  onPause,
  onResume,
  onStop,
  onToggleLayout,
  onSetPipPosition,
}: RecordingScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // PIP position in canvas coordinates (matches compositor's coord system)
  const pipW = Math.round(canvasWidth * SIZE_MULTIPLIERS[cameraSize]);
  const pipH = Math.round(pipW * (9 / 16));

  const [pip, setPip] = useState<{ x: number; y: number }>({
    x: PIP_MARGIN,
    y: Math.max(0, canvasHeight - pipH - PIP_MARGIN),
  });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

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

  // Reset PIP position when canvas size changes (e.g. on new recording)
  useEffect(() => {
    if (canvasWidth > 0 && canvasHeight > 0) {
      const initX = PIP_MARGIN;
      const initY = Math.max(0, canvasHeight - pipH - PIP_MARGIN);
      setPip({ x: initX, y: initY });
      onSetPipPosition(initX, initY);
    }
    // intentional: only when canvas dims first land
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasWidth, canvasHeight]);

  // Re-clamp PIP when size changes
  useEffect(() => {
    if (canvasWidth === 0) return;
    setPip((p) => {
      const x = Math.max(0, Math.min(p.x, canvasWidth - pipW));
      const y = Math.max(0, Math.min(p.y, canvasHeight - pipH));
      onSetPipPosition(x, y);
      return { x, y };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraSize]);

  const showDragHandle = layoutMode === 'pip' && cameraEnabled && canvasWidth > 0;

  // Compute preview scale: the rendered <video> is letterboxed via object-contain inside its container.
  // We need to find the actual rendered video bounding box to position the drag overlay correctly.
  const getPreviewMetrics = () => {
    const container = previewContainerRef.current;
    if (!container || canvasWidth === 0 || canvasHeight === 0) return null;

    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    const canvasRatio = canvasWidth / canvasHeight;
    const containerRatio = containerW / containerH;

    let displayW: number, displayH: number, offsetX: number, offsetY: number;
    if (containerRatio > canvasRatio) {
      // Container is wider than video: letterbox left/right
      displayH = containerH;
      displayW = displayH * canvasRatio;
      offsetX = (containerW - displayW) / 2;
      offsetY = 0;
    } else {
      displayW = containerW;
      displayH = displayW / canvasRatio;
      offsetX = 0;
      offsetY = (containerH - displayH) / 2;
    }
    return { displayW, displayH, offsetX, offsetY, scaleX: displayW / canvasWidth, scaleY: displayH / canvasHeight };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!showDragHandle) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pip.x,
      origY: pip.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const metrics = getPreviewMetrics();
    if (!metrics) return;

    const dxPreview = e.clientX - dragRef.current.startX;
    const dyPreview = e.clientY - dragRef.current.startY;
    const dxCanvas = dxPreview / metrics.scaleX;
    const dyCanvas = dyPreview / metrics.scaleY;

    const newX = Math.max(0, Math.min(dragRef.current.origX + dxCanvas, canvasWidth - pipW));
    const newY = Math.max(0, Math.min(dragRef.current.origY + dyCanvas, canvasHeight - pipH));
    setPip({ x: newX, y: newY });
    onSetPipPosition(newX, newY);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
    }
  };

  const metrics = getPreviewMetrics();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Preview area */}
      <div ref={previewContainerRef} className="flex-1 relative bg-black flex items-center justify-center min-h-0">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain"
        />

        {/* Drag handle overlay -- positioned in the actual rendered video area */}
        {showDragHandle && metrics && (
          <div
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className="absolute border-2 border-brand-violet/70 rounded-xl cursor-grab active:cursor-grabbing bg-brand-violet/5 hover:bg-brand-violet/10 transition-colors"
            style={{
              left: `${metrics.offsetX + pip.x * metrics.scaleX}px`,
              top: `${metrics.offsetY + pip.y * metrics.scaleY}px`,
              width: `${pipW * metrics.scaleX}px`,
              height: `${pipH * metrics.scaleY}px`,
              touchAction: 'none',
            }}
            title="Drag to reposition"
          />
        )}

        {/* Paused overlay */}
        {isPaused && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none">
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
        layoutMode={layoutMode}
        cameraEnabled={cameraEnabled}
        onPause={onPause}
        onResume={onResume}
        onStop={onStop}
        onToggleLayout={onToggleLayout}
      />
    </div>
  );
}
