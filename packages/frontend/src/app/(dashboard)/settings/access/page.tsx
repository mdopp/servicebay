'use client';

import { Bot, Key, ShieldAlert, UserPlus, Users } from 'lucide-react';
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
      <SettingDisclosure
        id="access-requests"
        tier="essential"
        label="People & access requests"
        icon={UserPlus}
        description={<>Family members on the LAN can request access from the portal at <span className="font-mono">/portal</span>. Approve to provision the user in LLDAP.</>}
      >
        <AccessRequestsSection />
      </SettingDisclosure>
      <SettingDisclosure
        id="credentials"
        tier="essential"
        label="Saved credentials"
        icon={Key}
        description="Credentials the install wizard persisted — encrypted at rest, visible to logged-in admins."
      >
        <CredentialsSection />
      </SettingDisclosure>
      <SettingDisclosure
        id="api-tokens"
        tier="advanced"
        label="API tokens"
        icon={Key}
        iconTone="ok"
        description="Named, revocable, scoped credentials. One token authenticates both the MCP server and opt-in REST API routes."
      >
        <ApiTokensSection />
      </SettingDisclosure>
      <SettingDisclosure
        id="mcp"
        tier="advanced"
        label="MCP access"
        icon={Bot}
        description="Let an AI assistant (Claude Code, Claude Desktop, …) drive ServiceBay through the Model Context Protocol."
      >
        <McpSection />
      </SettingDisclosure>
      <SettingDisclosure
        id="portal-access"
        tier="advanced"
        label="Portal access"
        icon={Users}
        description={<>Limits for the family portal at <span className="font-mono">/portal</span>.</>}
      >
        <PortalAccessSection />
      </SettingDisclosure>
      <SettingDisclosure
        id="approvals"
        tier="advanced"
        label="Action approvals"
        icon={ShieldAlert}
        iconTone="warn"
        description="Requests that need your review before a service runs them. Inspect, then Approve or Reject."
      >
        <ApprovalsSection />
      </SettingDisclosure>
      <SettingDisclosure
        id="file-share"
        tier="advanced"
        label="File sharing"
        icon={Users}
        iconTone="ok"
        description="Per-LLDAP-user Samba passwords. Samba can't speak OIDC, so the password lives in its own DB — set it here."
      >
        <FileShareSection />
      </SettingDisclosure>
    </div>
  );
}
