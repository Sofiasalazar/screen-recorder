import { DeviceInfo } from '../types';

interface DeviceSelectorProps {
  label: string;
  icon: React.ReactNode;
  devices: DeviceInfo[];
  selectedId: string;
  enabled: boolean;
  onSelect: (deviceId: string) => void;
  onToggle: (enabled: boolean) => void;
}

export function DeviceSelector({
  label,
  icon,
  devices,
  selectedId,
  enabled,
  onSelect,
  onToggle,
}: DeviceSelectorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm font-medium text-brand-text">
          {icon}
          {label}
        </label>
        <button
          onClick={() => onToggle(!enabled)}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            enabled ? 'bg-brand-violet' : 'bg-brand-border'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <select
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        disabled={!enabled}
        className="w-full px-3 py-2 rounded-lg bg-brand-surface border border-brand-border text-sm text-brand-text disabled:opacity-40 disabled:cursor-not-allowed focus:border-brand-violet focus:ring-1 focus:ring-brand-violet transition-colors"
      >
        <option value="">Default</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}
