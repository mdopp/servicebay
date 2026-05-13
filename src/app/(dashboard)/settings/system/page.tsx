'use client';

import LogLevelControl from '@/components/LogLevelControl';
import ServerIdentitySection from '../_lib/sections/ServerIdentitySection';
import UpdatesSection from '../_lib/sections/UpdatesSection';
import OsUpdateWindowSection from '../_lib/sections/OsUpdateWindowSection';

export default function SystemSettingsPage() {
  return (
    <>
      <ServerIdentitySection />
      <UpdatesSection />
      <OsUpdateWindowSection />
      <LogLevelControl />
    </>
  );
}
