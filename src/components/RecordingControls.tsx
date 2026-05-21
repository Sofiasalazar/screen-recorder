import { Pause, Play, Square, Maximize2, Minimize2 } from 'lucide-react';
import { formatTime } from '../lib/format-time';
import { LayoutMode } from '../types';

interface RecordingControlsProps {
  isPaused: boolean;
  elapsedSeconds: number;
  layoutMode: LayoutMode;
  cameraEnabled: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleLayout: () => void;
}

export function RecordingControls({
  isPaused,
  elapsedSeconds,
  layoutMode,
  cameraEnabled,
  onPause,
  onResume,
  onStop,
  onToggleLayout,
}: RecordingControlsProps) {
  return (
    <div className="flex items-center justify-center gap-4 py-4">
      {/* Timer */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-brand-surface border border-brand-border">
        {!isPaused && (
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 recording-pulse" />
        )}
        {isPaused && (
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
        )}
        <span className="text-sm font-mono font-medium text-brand-text">
          {formatTime(elapsedSeconds)}
        </span>
      </div>

      {/* Layout toggle (only if camera is on) */}
      {cameraEnabled && (
        <button
          onClick={onToggleLayout}
          className="w-10 h-10 rounded-full bg-brand-surface border border-brand-border flex items-center justify-center hover:border-brand-violet transition-colors"
          title={layoutMode === 'pip' ? 'Switch to face fullscreen' : 'Switch to screen + face PIP'}
        >
          {layoutMode === 'pip' ? (
            <Maximize2 className="w-4 h-4 text-brand-text" />
          ) : (
            <Minimize2 className="w-4 h-4 text-brand-text" />
          )}
        </button>
      )}

      {/* Pause / Resume */}
      <button
        onClick={isPaused ? onResume : onPause}
        className="w-10 h-10 rounded-full bg-brand-surface border border-brand-border flex items-center justify-center hover:border-brand-violet transition-colors"
        title={isPaused ? 'Resume' : 'Pause'}
      >
        {isPaused ? (
          <Play className="w-4 h-4 text-brand-text" />
        ) : (
          <Pause className="w-4 h-4 text-brand-text" />
        )}
      </button>

      {/* Stop */}
      <button
        onClick={onStop}
        className="w-10 h-10 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center hover:bg-red-500/30 transition-colors"
        title="Stop Recording"
      >
        <Square className="w-4 h-4 text-red-400 fill-red-400" />
      </button>
    </div>
  );
}
