import { useState, useEffect, useCallback } from 'react';
import { DeviceInfo } from '../types';

export function useMediaDevices() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enumerate = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const filtered = allDevices
        .filter((d) => d.kind === 'audioinput' || d.kind === 'videoinput')
        .filter((d) => d.deviceId !== '')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `${d.kind === 'videoinput' ? 'Camera' : 'Microphone'} ${d.deviceId.slice(0, 4)}`,
          kind: d.kind as 'audioinput' | 'videoinput',
        }));

      setDevices(filtered);
      setPermissionGranted(filtered.some((d) => d.label && !d.label.startsWith('Camera ') && !d.label.startsWith('Microphone ')));
    } catch {
      setError('Could not enumerate devices');
    }
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermissionGranted(true);
      await enumerate();
    } catch {
      setError('Camera/microphone permission denied. Please allow access in your browser settings.');
    }
  }, [enumerate]);

  useEffect(() => {
    enumerate();
  }, [enumerate]);

  useEffect(() => {
    navigator.mediaDevices.addEventListener('devicechange', enumerate);
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate);
  }, [enumerate]);

  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const microphones = devices.filter((d) => d.kind === 'audioinput');

  return { cameras, microphones, permissionGranted, requestPermission, error };
}
