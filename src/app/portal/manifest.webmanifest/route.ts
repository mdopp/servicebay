import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { getActiveDomain } from '@/lib/mode';

export const dynamic = 'force-dynamic';

/**
 * Web App Manifest for the family portal (#242 follow-up).
 *
 * Served at `/portal/manifest.webmanifest`. Mobile browsers + desktop
 * Chrome use this for the "Install app" / "Add to Home Screen"
 * affordance — once installed, the portal launches in its own
 * standalone window with the blue ServiceBay icon, separate from any
 * browser chrome.
 *
 * The `name` field uses the active domain so the home-screen label
 * reads "<your-domain> Portal" instead of generic "ServiceBay".
 * Personal touch; one less reminder this is generic infrastructure.
 */
export async function GET() {
  const config = await getConfig();
  const domain = getActiveDomain(config);
  const manifest = {
    name: domain ? `${domain} — Family Portal` : 'Family Portal',
    short_name: 'Home',
    description: 'Pick a service to use — your family\'s private cloud.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#fafafa',
    theme_color: '#2563eb',
    icons: [
      {
        src: '/portal/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
  return NextResponse.json(manifest, {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
