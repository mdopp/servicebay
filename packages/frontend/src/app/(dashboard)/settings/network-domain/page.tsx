'use client';

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
      <SettingDisclosure id="public-domain" tier="essential" label="Public domain">
        <PublicDomainSection />
      </SettingDisclosure>
      <SettingDisclosure id="reverse-proxy" tier="advanced" label="Reverse proxy">
        <ReverseProxySection />
      </SettingDisclosure>
      <SettingDisclosure id="gateway" tier="advanced" label="Router / gateway">
        <GatewaySection />
      </SettingDisclosure>
      <SettingDisclosure id="nodes" tier="advanced" label="Nodes & connections">
        <NodesSection />
      </SettingDisclosure>
    </div>
  );
}
