'use client';

import { Button } from '@/components/ui';
import { useSettings } from '../SettingsContext';

export default function ServerIdentitySection() {
  const { saving, serverName, setServerName, persistSettings } = useSettings();

  return (
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
  );
}
