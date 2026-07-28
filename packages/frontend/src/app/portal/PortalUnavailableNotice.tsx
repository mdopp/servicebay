import ServiceBayLogo from '@/components/ServiceBayLogo';

/**
 * Shown instead of the portal when the page can't build itself — today that
 * means `getConfig()` threw `ConfigReadError` (#2421), i.e. the config read
 * failed its retries and the page can't tell whether the LAN-only gate is on
 * or which services to list.
 *
 * `/portal` and `/portal/requests` are the two anonymous, pre-auth,
 * family-facing surfaces. The app-root `error.tsx` ("Something went wrong",
 * "Run diagnostics", ref digest) is written for an operator with admin
 * recourse; a household member has none, so these pages degrade to this
 * reassuring, transient-sounding notice instead — same shell and wording
 * shape as `PortalLanOnlyNotice`.
 *
 * `children` is the action slot: the server-rendered pages leave it empty
 * (a plain reload is the only recourse), the client `portal/error.tsx`
 * boundary fills it with its `reset()` button.
 */
export default function PortalUnavailableNotice({ children }: { children?: React.ReactNode }) {
  return (
    <main className="relative max-w-2xl mx-auto px-space-5 py-space-8 text-center">
      <div className="flex items-center justify-center gap-space-3 mb-space-5">
        <ServiceBayLogo size={36} className="text-accent shrink-0" />
        <h1 className="text-3xl font-bold text-text">Home</h1>
      </div>
      <p className="text-lg text-text">
        Home is temporarily unavailable.
      </p>
      <p className="mt-space-3 text-sm text-text-muted">
        This is usually brief. Wait a moment and reload — nothing you did caused it,
        and there is nothing you need to fix.
      </p>
      {children}
    </main>
  );
}
