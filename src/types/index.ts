export type RecordingPhase = 'setup' | 'recording' | 'paused' | 'playback';

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'videoinput';
}

export interface DevicePreferences {
  cameraId: string;
  micId: string;
  cameraEnabled: boolean;
  micEnabled: boolean;
}
