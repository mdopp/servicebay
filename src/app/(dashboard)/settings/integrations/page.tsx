'use client';

import EmailNotificationsSection from '../_lib/sections/EmailNotificationsSection';
import TemplateRegistriesSection from '../_lib/sections/TemplateRegistriesSection';
import TemplateVariablesSection from '../_lib/sections/TemplateVariablesSection';

export default function IntegrationsSettingsPage() {
  return (
    <>
      <EmailNotificationsSection />
      <TemplateRegistriesSection />
      <TemplateVariablesSection />
    </>
  );
}
