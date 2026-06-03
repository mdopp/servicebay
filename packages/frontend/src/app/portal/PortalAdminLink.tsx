import { Settings } from 'lucide-react';

/**
 * Small, always-visible link to the ServiceBay admin dashboard from the
 * family portal (admin-card design call, #417 follow-up).
 *
 * ServiceBay's admin UI lives on its own `admin.<domain>` host with
 * app-layer login (not Authelia forward-auth), and the apex → /portal
 * rewrite means there's otherwise no way to reach it from the portal.
 * Shown to everyone — it's gated by the ServiceBay login regardless of
 * who clicks — as a subtle top-left link rather than a service-grid
 * tile, so it stays out of the family-facing card grid.
 */
export default function PortalAdminLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="absolute top-6 left-6 inline-flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-blue-600 dark:text-gray-500 dark:hover:text-blue-400 transition-colors"
      title="ServiceBay admin dashboard — sign in to manage this server"
    >
      <Settings size={14} />
      Admin
    </a>
  );
}
