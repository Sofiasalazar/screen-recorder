import { Download, RotateCcw } from 'lucide-react';
import { formatFileSize } from '../lib/format-time';

interface PlaybackScreenProps {
  recordedUrl: string;
  recordedBlob: Blob;
  onReset: () => void;
}

export function PlaybackScreen({ recordedUrl, recordedBlob, onReset }: PlaybackScreenProps) {
  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = recordedUrl;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `recording-${timestamp}.webm`;
    a.click();
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Video playback */}
      <div className="flex-1 bg-black flex items-center justify-center min-h-0">
        <video
          src={recordedUrl}
          controls
          className="w-full h-full object-contain"
        />
      </div>

      {/* Actions */}
      <div className="p-6 space-y-4">
        <p className="text-center text-sm text-brand-muted">
          File size: {formatFileSize(recordedBlob.size)}
        </p>

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-brand-violet to-brand-purple text-white font-semibold hover:opacity-90 active:scale-[0.98] transition-all"
          >
            <Download className="w-4 h-4" />
            Download Recording
          </button>

          <button
            onClick={onReset}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-brand-surface border border-brand-border text-brand-text font-medium hover:border-brand-violet transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            New Recording
          </button>
        </div>
      </div>
    </div>
  );
}
