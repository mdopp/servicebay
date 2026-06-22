'use client';

import Link from 'next/link';
import { Terminal, ChevronRight } from 'lucide-react';
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
      {/* SSH Terminal launch card — the console left the top nav in the IA
          redesign (slice 2), but stays one click away here (and via search).
          Launches the full terminal route; advanced tier keeps it tucked. */}
      <SettingDisclosure id="terminal" tier="advanced" label="SSH Terminal">
        <Link
          href="/terminal"
          data-testid="system-launch-terminal"
          className="flex items-center gap-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm transition-colors"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
            <Terminal className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-gray-900 dark:text-gray-100">Open SSH Terminal</span>
            <span className="block text-sm text-gray-500 dark:text-gray-400">
              A shell on the host for expert tasks — opens the full console.
            </span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-gray-400" />
        </Link>
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
