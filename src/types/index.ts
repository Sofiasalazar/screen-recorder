export type RecordingPhase = 'setup' | 'recording' | 'paused' | 'playback';

export type CameraSize = 'small' | 'medium' | 'large';
export type LayoutMode = 'pip' | 'face-full';

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
  cameraSize: CameraSize;
  blurBackground: boolean;
  layoutMode: LayoutMode;
}
