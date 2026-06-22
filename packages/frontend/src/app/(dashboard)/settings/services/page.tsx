import { redirect } from 'next/navigation';

// Services left Settings (spec §4.4 / §8): the service list lives on the
// Services nav, and each service on its own Operate page. This route is kept
// only so an old `/settings/services` bookmark still resolves — it forwards to
// the real services home. (The per-service Operate redirect at
// `/settings/services/[name]` → `/services/[name]` stays as-is.)
export default function SettingsServicesIndexPage() {
  redirect('/services');
}
