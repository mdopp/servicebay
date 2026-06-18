'use client';

import GroupIntro from '../_lib/GroupIntro';
import SettingDisclosure from '../_lib/SettingDisclosure';
import { SETTINGS_GROUPS } from '../_lib/ia';
import EmailNotificationsSection from '../_lib/sections/EmailNotificationsSection';

const GROUP = SETTINGS_GROUPS.find(g => g.id === 'notifications')!;

export default function NotificationsSettingsPage() {
  return (
    <div className="space-y-6">
      <GroupIntro intent={GROUP.intent} />
      <SettingDisclosure id="email" tier="essential" label="Email notifications">
        <EmailNotificationsSection />
      </SettingDisclosure>
    </div>
  );
}
