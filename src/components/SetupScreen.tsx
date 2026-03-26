import { Camera, Mic, MonitorUp, AlertTriangle } from 'lucide-react';
import { DeviceInfo, DevicePreferences } from '../types';
import { DeviceSelector } from './DeviceSelector';

interface SetupScreenProps {
  cameras: DeviceInfo[];
  microphones: DeviceInfo[];
  preferences: DevicePreferences;
  permissionGranted: boolean;
  onPreferencesChange: (partial: Partial<DevicePreferences>) => void;
  onRequestPermission: () => void;
  onStart: () => void;
  error: string | null;
}

const isScreenRecordingSupported = typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getDisplayMedia;

export function SetupScreen({
  cameras,
  microphones,
  preferences,
  permissionGranted,
  onPreferencesChange,
  onRequestPermission,
  onStart,
  error,
}: SetupScreenProps) {
  if (!isScreenRecordingSupported) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md space-y-4">
          <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto" />
          <h2 className="text-xl font-semibold text-brand-text">Desktop Browser Required</h2>
          <p className="text-sm text-brand-muted">
            Screen recording requires a desktop browser with screen capture support (Chrome, Edge, or Firefox).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-md space-y-8">
        {/* Hero */}
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-violet to-brand-purple flex items-center justify-center mx-auto">
            <MonitorUp className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-brand-text">Screen Recorder</h2>
          <p className="text-sm text-brand-muted">
            Record your screen with camera overlay and microphone. No uploads, no servers.
          </p>
        </div>

        {/* Device selectors */}
        <div className="space-y-4 p-5 rounded-xl bg-brand-surface border border-brand-border">
          {!permissionGranted ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-brand-muted">
                Grant camera and microphone access to select your devices.
              </p>
              <button
                onClick={onRequestPermission}
                className="px-4 py-2 rounded-lg bg-brand-surface border border-brand-violet text-sm text-brand-violet hover:bg-brand-violet/10 transition-colors"
              >
                Allow Access
              </button>
            </div>
          ) : (
            <>
              <DeviceSelector
                label="Camera"
                icon={<Camera className="w-4 h-4 text-brand-violet" />}
                devices={cameras}
                selectedId={preferences.cameraId}
                enabled={preferences.cameraEnabled}
                onSelect={(id) => onPreferencesChange({ cameraId: id })}
                onToggle={(on) => onPreferencesChange({ cameraEnabled: on })}
              />
              <DeviceSelector
                label="Microphone"
                icon={<Mic className="w-4 h-4 text-brand-violet" />}
                devices={microphones}
                selectedId={preferences.micId}
                enabled={preferences.micEnabled}
                onSelect={(id) => onPreferencesChange({ micId: id })}
                onToggle={(on) => onPreferencesChange({ micEnabled: on })}
              />
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Start button */}
        <button
          onClick={onStart}
          className="w-full py-3.5 rounded-xl bg-gradient-to-r from-brand-violet to-brand-purple text-white font-semibold text-base hover:opacity-90 active:scale-[0.98] transition-all"
        >
          Start Recording
        </button>
      </div>
    </div>
  );
}
