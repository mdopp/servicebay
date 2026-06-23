'use client';

import { AlertTriangle, CalendarClock, RefreshCw, Server } from 'lucide-react';
import LogLevelControl from '@/components/LogLevelControl';
import GroupIntro from '../_lib/GroupIntro';
import SettingDisclosure from '../_lib/SettingDisclosure';
import { SETTINGS_GROUPS } from '../_lib/ia';
import ServerIdentitySection from '../_lib/sections/ServerIdentitySection';
import UpdatesSection from '../_lib/sections/UpdatesSection';
import UpdateWindowSection from '../_lib/sections/UpdateWindowSection';
import FactoryResetSection from '../_lib/sections/FactoryResetSection';

const GROUP = SETTINGS_GROUPS.find(g => g.id === 'system')!;

export default function SystemSettingsPage() {
  return (
    <div className="space-y-6">
      <GroupIntro intent={GROUP.intent} />
      <SettingDisclosure
        id="server-identity"
        tier="essential"
        label="Server identity"
        icon={Server}
        description="Custom display name shown in the browser tab and system info instead of the detected hostname."
      >
        <ServerIdentitySection />
      </SettingDisclosure>
      <SettingDisclosure
        id="updates"
        tier="essential"
        label="Updates"
        icon={RefreshCw}
        description="Keep ServiceBay current, and reinstall or recover the base OS from a boot USB."
      >
        <UpdatesSection />
      </SettingDisclosure>
      <SettingDisclosure
        id="update-window"
        tier="advanced"
        label="Update window"
        icon={CalendarClock}
        iconTone="warn"
        description="Decide when ServiceBay applies OS, container, and its own updates. Until you save a window, auto-updates stay locked."
      >
        <UpdateWindowSection />
      </SettingDisclosure>
      <SettingDisclosure id="log-level" tier="advanced" label="Log level">
        <LogLevelControl />
      </SettingDisclosure>
      {/* Stacks & templates left Settings (#2081): stack management now lives on
          the /services overview, grouped under each stack header with a scoped
          per-stack wipe — no separate Settings subsection. */}
      {/* Terminal returned to the sidebar nav (#2083): a host shell is a recovery
          tool, not a buried Settings launch card. It is reached from the desktop
          sidebar (config/navigation.ts) and served at /terminal — no Settings
          embedding here. */}
      {/* Disk import left Settings for its own app + launch tile (#1949/#1953):
          the heavy job runs in a resource-capped worker container, reached via a
          dashboard tile — not an in-process Settings subsection. */}
      <SettingDisclosure
        id="factory-reset"
        tier="advanced"
        label="Factory reset"
        icon={AlertTriangle}
        iconTone="fail"
        description="Wipe every service + clear saved credentials. Start from zero."
      >
        <FactoryResetSection />
      </SettingDisclosure>
    </div>
  );
}
