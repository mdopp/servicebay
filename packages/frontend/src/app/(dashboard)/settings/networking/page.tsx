'use client';

import GatewaySection from '../_lib/sections/GatewaySection';
import PortalAccessSection from '../_lib/sections/PortalAccessSection';
import PublicDomainSection from '../_lib/sections/PublicDomainSection';
import ReverseProxySection from '../_lib/sections/ReverseProxySection';

export default function NetworkingSettingsPage() {
  return (
    <>
      <PublicDomainSection />
      <ReverseProxySection />
      <GatewaySection />
      <PortalAccessSection />
    </>
  );
}
