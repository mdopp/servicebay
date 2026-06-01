'use client';

import ApiTokensSection from '../_lib/sections/ApiTokensSection';
import CredentialsSection from '../_lib/sections/CredentialsSection';
import McpSection from '../_lib/sections/McpSection';
import PendingSkillsSection from '../_lib/sections/PendingSkillsSection';

export default function SecuritySettingsPage() {
  return (
    <>
      <CredentialsSection />
      <ApiTokensSection />
      <McpSection />
      <PendingSkillsSection />
    </>
  );
}
