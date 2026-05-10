import type { Metadata, Viewport } from 'next';

/**
 * /portal — minimal layout, no admin chrome (#242). Inherits the
 * root layout's providers but skips the (dashboard) sidebar/header.
 *
 * Adds PWA manifest + iOS Safari meta tags so family members can
 * "Add to Home Screen" and the portal launches in its own standalone
 * window with the blue ServiceBay icon. The manifest endpoint at
 * `/portal/manifest.webmanifest` returns a per-install JSON with the
 * active domain in the app name.
 */
export const metadata: Metadata = {
  manifest: '/portal/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Home',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [{ url: '/portal/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/portal/icon.svg' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white dark:from-gray-900 dark:to-gray-950">
      {children}
    </div>
  );
}
