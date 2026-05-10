/**
 * /portal — minimal layout, no admin chrome (#242). Inherits the
 * root layout's providers but skips the (dashboard) sidebar/header.
 *
 * Auth: anonymous on the LAN (per the v1 design conversation). The
 * route handler in `page.tsx` short-circuits to 404 when the install
 * is in public-domain mode — until #265 ships the migration there's
 * no way to expose this safely outside the LAN.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 to-white dark:from-gray-900 dark:to-gray-950">
      {children}
    </div>
  );
}
