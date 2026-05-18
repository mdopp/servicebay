'use client';

import LogLevelControl from '@/components/LogLevelControl';
import ServerIdentitySection from '../_lib/sections/ServerIdentitySection';
import UpdatesSection from '../_lib/sections/UpdatesSection';
import UpdateWindowSection from '../_lib/sections/UpdateWindowSection';
import FactoryResetSection from '../_lib/sections/FactoryResetSection';

export default function SystemSettingsPage() {
  return (
    <>
      <ServerIdentitySection />
      <UpdatesSection />
      <UpdateWindowSection />
      <LogLevelControl />
      <FactoryResetSection />
    </>
  );
}
