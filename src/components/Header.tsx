import { Monitor } from 'lucide-react';
import { RecordingPhase } from '../types';

interface HeaderProps {
  phase: RecordingPhase;
}

export function Header({ phase }: HeaderProps) {
  const statusMap: Record<RecordingPhase, { label: string; color: string }> = {
    setup: { label: 'Ready', color: 'bg-brand-muted/20 text-brand-muted' },
    recording: { label: 'Recording', color: 'bg-red-500/20 text-red-400' },
    paused: { label: 'Paused', color: 'bg-yellow-500/20 text-yellow-400' },
    playback: { label: 'Complete', color: 'bg-brand-lime/20 text-brand-lime' },
  };

  const status = statusMap[phase];

  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-brand-border">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand-violet to-brand-purple flex items-center justify-center">
          <Monitor className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-brand-text">Screen Recorder</h1>
          <p className="text-xs text-brand-muted">by Agenticsis</p>
        </div>
      </div>

      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${status.color}`}>
        {phase === 'recording' && (
          <span className="w-2 h-2 rounded-full bg-red-500 recording-pulse" />
        )}
        {status.label}
      </div>
    </header>
  );
}
