'use client';

import { Globe, Router, Server, Shield } from 'lucide-react';
import GroupIntro from '../_lib/GroupIntro';
import SettingDisclosure from '../_lib/SettingDisclosure';
import { SETTINGS_GROUPS } from '../_lib/ia';
import PublicDomainSection from '../_lib/sections/PublicDomainSection';
import ReverseProxySection from '../_lib/sections/ReverseProxySection';
import GatewaySection from '../_lib/sections/GatewaySection';
import NodesSection from '../_lib/sections/NodesSection';

const GROUP = SETTINGS_GROUPS.find(g => g.id === 'network-domain')!;

export default function NetworkDomainSettingsPage() {
  return (
    <div className="space-y-6">
      <GroupIntro intent={GROUP.intent} />
      <SettingDisclosure
        id="public-domain"
        tier="essential"
        label="Public domain"
        icon={Globe}
        description="Reach the box from the internet over your own domain, or keep it internal-only."
      >
        <PublicDomainSection />
      </SettingDisclosure>
      <SettingDisclosure
        id="reverse-proxy"
        tier="advanced"
        label="Reverse proxy (NPM)"
        icon={Shield}
        iconTone="ok"
        description="ServiceBay owns the Nginx Proxy Manager admin credential automatically — read from NPM's own database, never typed in."
      >
        <ReverseProxySection />
      </SettingDisclosure>
      <SettingDisclosure
        id="gateway"
        tier="advanced"
        label="Router / gateway (FritzBox)"
        icon={Router}
        iconTone="warn"
        description="Credentials for TR-064 access — external IP, port-forward status, and DHCP-DNS push."
      >
        <GatewaySection />
      </SettingDisclosure>
      <SettingDisclosure
        id="nodes"
        tier="advanced"
        label="Nodes & connections"
        icon={Server}
        description="Manage remote Podman nodes."
      >
        <NodesSection />
      </SettingDisclosure>
    </div>
  );
}
