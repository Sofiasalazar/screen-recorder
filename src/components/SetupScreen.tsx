import { Camera, Mic, MonitorUp, AlertTriangle, Aperture, Maximize2, Minimize2, HardDrive, ShieldAlert, Ban, Library } from 'lucide-react';
import { DeviceInfo, DevicePreferences, CameraSize, LayoutMode, BackgroundMode } from '../types';
import { DeviceSelector } from './DeviceSelector';
import { canStreamToDisk } from '../lib/file-utils';

const SIZE_OPTIONS: { value: CameraSize; label: string }[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
];

const LAYOUT_OPTIONS: { value: LayoutMode; label: string; icon: typeof Minimize2 }[] = [
  { value: 'pip', label: 'Screen + face', icon: Minimize2 },
  { value: 'face-full', label: 'Face only', icon: Maximize2 },
];

const BACKGROUND_OPTIONS: { value: BackgroundMode; label: string; icon: typeof Ban }[] = [
  { value: 'none', label: 'None', icon: Ban },
  { value: 'blur', label: 'Blur', icon: Aperture },
  { value: 'library', label: 'Office', icon: Library },
];

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

              {preferences.cameraEnabled && (
                <>
                  {/* Layout */}
                  <div className="space-y-2">
                    <span className="text-sm text-brand-muted">Layout</span>
                    <div className="grid grid-cols-2 gap-2">
                      {LAYOUT_OPTIONS.map((opt) => {
                        const Icon = opt.icon;
                        const active = preferences.layoutMode === opt.value;
                        return (
                          <button
                            key={opt.value}
                            onClick={() => onPreferencesChange({ layoutMode: opt.value })}
                            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                              active
                                ? 'bg-brand-violet/10 border-brand-violet/40 text-brand-text'
                                : 'bg-brand-bg/40 border-brand-border text-brand-muted hover:border-brand-violet/40 hover:text-brand-text'
                            }`}
                          >
                            <Icon className={`w-4 h-4 ${active ? 'text-brand-violet' : ''}`} />
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Camera size */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-brand-muted">Face size</span>
                    <div className="flex gap-1.5 rounded-lg bg-brand-bg/40 p-1 border border-brand-border">
                      {SIZE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => onPreferencesChange({ cameraSize: opt.value })}
                          className={`w-9 h-7 rounded text-xs font-semibold transition-colors ${
                            preferences.cameraSize === opt.value
                              ? 'bg-brand-violet text-white'
                              : 'text-brand-muted hover:text-brand-text'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Background */}
                  <div className="space-y-2">
                    <span className="text-sm text-brand-muted">Background</span>
                    <div className="grid grid-cols-3 gap-2">
                      {BACKGROUND_OPTIONS.map((opt) => {
                        const Icon = opt.icon;
                        const active = preferences.backgroundMode === opt.value;
                        return (
                          <button
                            key={opt.value}
                            onClick={() => onPreferencesChange({ backgroundMode: opt.value })}
                            className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-xs transition-colors ${
                              active
                                ? 'bg-brand-violet/10 border-brand-violet/40 text-brand-text'
                                : 'bg-brand-bg/40 border-brand-border text-brand-muted hover:border-brand-violet/40 hover:text-brand-text'
                            }`}
                          >
                            <Icon className={`w-4 h-4 ${active ? 'text-brand-violet' : ''}`} />
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                    {preferences.backgroundMode !== 'none' && (
                      <p className="text-[11px] text-brand-muted leading-snug">
                        {preferences.backgroundMode === 'library'
                          ? 'Replaces your camera background with an elegant office scene. Works best with even, bright front lighting and a plain wall behind you.'
                          : 'Blurs whatever is behind you on camera. Works best with even front lighting.'}
                      </p>
                    )}
                  </div>
                </>
              )}

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

        {/* Streaming-to-disk capability notice */}
        {canStreamToDisk ? (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
            <HardDrive className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Recordings stream directly to disk &mdash; crash-safe, no memory limit. You'll be asked where to save when you click Start.</span>
          </div>
        ) : (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
            <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>This browser keeps recordings in memory. Long sessions may freeze or crash &mdash; use Chrome or Edge for unlimited length.</span>
          </div>
        )}

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
