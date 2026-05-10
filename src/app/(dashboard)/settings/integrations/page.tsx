'use client';

import EmailNotificationsSection from '../_lib/sections/EmailNotificationsSection';
import McpSection from '../_lib/sections/McpSection';
import PublicDomainSection from '../_lib/sections/PublicDomainSection';
import ReverseProxySection from '../_lib/sections/ReverseProxySection';
import TemplateRegistriesSection from '../_lib/sections/TemplateRegistriesSection';
import TemplateVariablesSection from '../_lib/sections/TemplateVariablesSection';

export default function IntegrationsSettingsPage() {
  return (
    <>
      <PublicDomainSection />
      <ReverseProxySection />
      <EmailNotificationsSection />
      <McpSection />
      <TemplateRegistriesSection />
      <TemplateVariablesSection />
    </>
  );
}
