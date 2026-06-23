'use client';

import { Server } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { useSettings } from '../SettingsContext';

export default function ServerIdentitySection() {
  const { saving, serverName, setServerName, persistSettings } = useSettings();

  return (
    <Card padding="none" className="w-full overflow-hidden">
      <div className="flex items-center gap-space-3 px-space-4 py-space-3 border-b border-border bg-surface-2">
        <div className="p-2 rounded-card bg-accent/10 text-accent">
          <Server size={20} />
        </div>
        <div>
          <h3 className="font-semibold text-text">Server Identity</h3>
          <p className="text-xs text-text-muted">
            Custom display name shown in the browser tab and system info instead of the detected hostname.
          </p>
        </div>
      </div>
      <div className="p-space-5">
        <div className="flex items-center gap-space-3">
          <input
            type="text"
            value={serverName}
            onChange={e => setServerName(e.target.value)}
            disabled={saving}
            className="flex-1 p-2 rounded-card border border-border bg-surface-2 text-text focus:ring-2 focus:ring-accent outline-none disabled:opacity-50"
            placeholder="e.g. HomeServer, NAS, Production"
          />
          <Button
            onClick={() => persistSettings()}
            disabled={saving}
            className="shrink-0"
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
