import { redirect } from 'next/navigation';

import { DEFAULT_GROUP } from './_lib/ia';

// Settings lands on the first cross-cutting group (Network & Domain). Services
// no longer live in Settings (spec §4.4 / §8) — they're on the Services nav and
// their own Operate page.
export default function SettingsRootPage() {
  redirect(`/settings/${DEFAULT_GROUP.id}`);
}
