'use client';

import LogLevelControl from '@/components/LogLevelControl';
import SelfDiagnoseSection from '../_lib/sections/SelfDiagnoseSection';
import ServerIdentitySection from '../_lib/sections/ServerIdentitySection';
import UpdatesSection from '../_lib/sections/UpdatesSection';

export default function SystemSettingsPage() {
  return (
    <>
      <SelfDiagnoseSection />
      <ServerIdentitySection />
      <UpdatesSection />
      <LogLevelControl />
    </>
  );
}
