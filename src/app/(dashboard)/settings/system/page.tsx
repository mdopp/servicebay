'use client';

import LogLevelControl from '@/components/LogLevelControl';
import ServerIdentitySection from '../_lib/sections/ServerIdentitySection';
import UpdatesSection from '../_lib/sections/UpdatesSection';

export default function SystemSettingsPage() {
  return (
    <>
      <ServerIdentitySection />
      <UpdatesSection />
      <LogLevelControl />
    </>
  );
}
