'use client';

import AccessRequestsSection from '../_lib/sections/AccessRequestsSection';
import ApiTokensSection from '../_lib/sections/ApiTokensSection';
import ApprovalsSection from '../_lib/sections/ApprovalsSection';
import CredentialsSection from '../_lib/sections/CredentialsSection';
import McpSection from '../_lib/sections/McpSection';

export default function SecuritySettingsPage() {
  return (
    <>
      <AccessRequestsSection />
      <CredentialsSection />
      <ApiTokensSection />
      <McpSection />
      <ApprovalsSection />
    </>
  );
}
