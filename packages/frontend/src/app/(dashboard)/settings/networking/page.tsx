'use client';

import AccessRequestsSection from '../_lib/sections/AccessRequestsSection';
import GatewaySection from '../_lib/sections/GatewaySection';
import NginxConfigSection from '../_lib/sections/NginxConfigSection';
import PortalAccessSection from '../_lib/sections/PortalAccessSection';
import PublicDomainSection from '../_lib/sections/PublicDomainSection';
import ReverseProxySection from '../_lib/sections/ReverseProxySection';

export default function NetworkingSettingsPage() {
  return (
    <>
      <PublicDomainSection />
      <ReverseProxySection />
      <NginxConfigSection />
      <GatewaySection />
      <PortalAccessSection />
      <AccessRequestsSection />
    </>
  );
}
