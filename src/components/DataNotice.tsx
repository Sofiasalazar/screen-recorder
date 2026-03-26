import { Shield } from 'lucide-react';

export function DataNotice() {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-brand-violet/5 border-b border-brand-border text-xs text-brand-muted">
      <Shield className="w-3.5 h-3.5 text-brand-violet flex-shrink-0" />
      <span>Your recordings live only in this browser tab. Refreshing or closing will erase everything. Export before leaving.</span>
    </div>
  );
}
