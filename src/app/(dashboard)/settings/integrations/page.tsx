'use client';

import AccessRequestsSection from '../_lib/sections/AccessRequestsSection';
import CredentialsSection from '../_lib/sections/CredentialsSection';
import EmailNotificationsSection from '../_lib/sections/EmailNotificationsSection';
import GatewaySection from '../_lib/sections/GatewaySection';
import McpSection from '../_lib/sections/McpSection';
import PublicDomainSection from '../_lib/sections/PublicDomainSection';
import ReverseProxySection from '../_lib/sections/ReverseProxySection';
import TemplateRegistriesSection from '../_lib/sections/TemplateRegistriesSection';
import TemplateVariablesSection from '../_lib/sections/TemplateVariablesSection';

export default function IntegrationsSettingsPage() {
  return (
    <>
      <PublicDomainSection />
      <GatewaySection />
      <AccessRequestsSection />
      <CredentialsSection />
      <ReverseProxySection />
      <EmailNotificationsSection />
      <McpSection />
      <TemplateRegistriesSection />
      <TemplateVariablesSection />
    </>
  );
}
