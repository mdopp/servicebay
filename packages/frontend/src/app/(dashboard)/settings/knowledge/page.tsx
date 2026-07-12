'use client';

import { BookOpen } from 'lucide-react';
import GroupIntro from '../_lib/GroupIntro';
import SettingDisclosure from '../_lib/SettingDisclosure';
import { SETTINGS_GROUPS } from '../_lib/ia';
import KnowledgeSection from '../_lib/sections/KnowledgeSection';

const GROUP = SETTINGS_GROUPS.find(g => g.id === 'knowledge')!;

export default function KnowledgeSettingsPage() {
  return (
    <div className="space-y-6">
      <GroupIntro intent={GROUP.intent} />
      <SettingDisclosure
        id="catalog"
        tier="essential"
        label="Assist catalog"
        icon={BookOpen}
        description="Browse, view, edit and revert the assist knowledge base (guides, recipes, ADRs, footguns). Every edit goes through the admin approval gate; the secret scan blocks a key or token before it can be proposed."
      >
        <KnowledgeSection />
      </SettingDisclosure>
    </div>
  );
}
