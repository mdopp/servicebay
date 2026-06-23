'use client';

import GroupIntro from '../_lib/GroupIntro';
import SettingDisclosure from '../_lib/SettingDisclosure';
import { SETTINGS_GROUPS } from '../_lib/ia';
import AccessRequestsSection from '../_lib/sections/AccessRequestsSection';
import CredentialsSection from '../_lib/sections/CredentialsSection';
import ApiTokensSection from '../_lib/sections/ApiTokensSection';
import McpSection from '../_lib/sections/McpSection';
import PortalAccessSection from '../_lib/sections/PortalAccessSection';
import ApprovalsSection from '../_lib/sections/ApprovalsSection';
import FileShareSection from '../_lib/sections/FileShareSection';

const GROUP = SETTINGS_GROUPS.find(g => g.id === 'access')!;

export default function AccessSettingsPage() {
  return (
    <div className="space-y-6">
      <GroupIntro intent={GROUP.intent} />
      <SettingDisclosure id="access-requests" tier="essential" label="Access requests">
        <AccessRequestsSection />
      </SettingDisclosure>
      <SettingDisclosure id="credentials" tier="essential" label="Credentials">
        <CredentialsSection />
      </SettingDisclosure>
      <SettingDisclosure id="api-tokens" tier="advanced" label="API tokens">
        <ApiTokensSection />
      </SettingDisclosure>
      <SettingDisclosure id="mcp" tier="advanced" label="MCP access">
        <McpSection />
      </SettingDisclosure>
      <SettingDisclosure id="portal-access" tier="advanced" label="Portal access">
        <PortalAccessSection />
      </SettingDisclosure>
      <SettingDisclosure id="approvals" tier="advanced" label="Action approvals">
        <ApprovalsSection />
      </SettingDisclosure>
      <SettingDisclosure id="file-share" tier="advanced" label="File sharing">
        <FileShareSection />
      </SettingDisclosure>
    </div>
  );
}
