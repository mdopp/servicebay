'use client';

import LogLevelControl from '@/components/LogLevelControl';
import GroupIntro from '../_lib/GroupIntro';
import SettingDisclosure from '../_lib/SettingDisclosure';
import { SETTINGS_GROUPS } from '../_lib/ia';
import ServerIdentitySection from '../_lib/sections/ServerIdentitySection';
import UpdatesSection from '../_lib/sections/UpdatesSection';
import UpdateWindowSection from '../_lib/sections/UpdateWindowSection';
import FactoryResetSection from '../_lib/sections/FactoryResetSection';
import StacksSection from '../_lib/sections/StacksSection';

const GROUP = SETTINGS_GROUPS.find(g => g.id === 'system')!;

export default function SystemSettingsPage() {
  return (
    <div className="space-y-6">
      <GroupIntro intent={GROUP.intent} />
      <SettingDisclosure id="server-identity" tier="essential" label="Server identity">
        <ServerIdentitySection />
      </SettingDisclosure>
      <SettingDisclosure id="updates" tier="essential" label="Updates">
        <UpdatesSection />
      </SettingDisclosure>
      <SettingDisclosure id="update-window" tier="advanced" label="Update window">
        <UpdateWindowSection />
      </SettingDisclosure>
      <SettingDisclosure id="log-level" tier="advanced" label="Log level">
        <LogLevelControl />
      </SettingDisclosure>
      <SettingDisclosure id="stacks" tier="advanced" label="Stacks & templates">
        <StacksSection />
      </SettingDisclosure>
      {/* Disk import left Settings for its own app + launch tile (#1949/#1953):
          the heavy job runs in a resource-capped worker container, reached via a
          dashboard tile — not an in-process Settings subsection. */}
      <SettingDisclosure id="factory-reset" tier="advanced" label="Factory reset">
        <FactoryResetSection />
      </SettingDisclosure>
    </div>
  );
}
