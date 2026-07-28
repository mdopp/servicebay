import ServiceBayLogo from '@/components/ServiceBayLogo';

/** Shown instead of the portal when `config.portalLanOnly` is on and the
 *  visitor isn't on the home network (#1456). Shared by `/portal` and the
 *  deep-linkable `/portal/requests` route (#2405) so both surfaces apply the
 *  same gate with the same wording. */
export default function PortalLanOnlyNotice() {
  return (
    <main className="relative max-w-2xl mx-auto px-space-5 py-space-8 text-center">
      <div className="flex items-center justify-center gap-space-3 mb-space-5">
        <ServiceBayLogo size={36} className="text-accent shrink-0" />
        <h1 className="text-3xl font-bold text-text">Home</h1>
      </div>
      <p className="text-lg text-text">
        This page is available on the home network only.
      </p>
      <p className="mt-space-3 text-sm text-text-muted">
        Connect to the home Wi-Fi (or its VPN) and reload to request access or open a service.
      </p>
    </main>
  );
}
