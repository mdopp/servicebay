'use client';

/**
 * Generic, service-agnostic URL-driven portal setup-asset cards (#2295).
 *
 * Split out of PortalGrid.tsx to keep that file under the max-lines
 * budget. These two cards render entirely from a `url` declared in a
 * service's `user-guide.md` `setup_assets` frontmatter — nothing here is
 * hard-coded to any particular service:
 *
 *   - {@link PwaInstallButton} — an "Add to Home Screen" card: a QR to the
 *     service URL + a CTA that opens it so the visitor can install the PWA
 *     via their browser's own Add-to-Home-Screen.
 *   - {@link ApkDownloadButton} — an APK-download card: a direct download
 *     link + a QR to the release URL so a phone can grab the APK.
 *
 * Both mirror the BasicSync install-QR precedent (client-side QR from a
 * static/declared URL, no server round-trip).
 */

import { useState } from 'react';
import { QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Card } from '@/components/ui';

type IconComponent = typeof QrCode;

/** Compact full-width accent link — mirrors PortalGrid's PORTAL_LINK_BUTTON
 *  so these cards read the same as the other setup-asset actions. */
const LINK_BUTTON =
  'flex items-center justify-center gap-space-2 w-full rounded-card text-sm font-medium py-2 ' +
  'bg-accent text-on-accent hover:bg-accent-strong transition-colors';
/** Neutral, bordered secondary action — mirrors PORTAL_SECONDARY_BUTTON. */
const SECONDARY_BUTTON =
  'flex items-center justify-center gap-space-2 w-full rounded-card text-sm font-medium py-2 ' +
  'bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong transition-colors';

/**
 * Generic, service-agnostic "Add to Home Screen" card (#2295). Opens a
 * modal with a QR to the service `url` (declared in the template's
 * user-guide.md `setup_assets` frontmatter) plus a direct CTA that opens
 * that URL. The visitor then uses the browser's own Add-to-Home-Screen to
 * install the PWA. URL-driven — nothing here is tied to a specific service.
 */
export function PwaInstallButton({
  url,
  label,
  description,
  Icon,
}: {
  url: string;
  label: string;
  description?: string;
  Icon: IconComponent;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div>
        <button onClick={() => setOpen(true)} className={LINK_BUTTON}>
          <Icon size={14} /> {label}
        </button>
        {description && (
          <p className="text-[11px] text-text-subtle mt-space-1 leading-snug text-center">{description}</p>
        )}
      </div>
      {open && (
        <AssetQrModal
          title="Add to Home Screen"
          qrUrl={url}
          onClose={() => setOpen(false)}
          instructions="Open this on your phone, then use your browser's Share → Add to Home Screen to install the app."
          ctaHref={url}
          ctaLabel="Open to install"
        />
      )}
    </>
  );
}

/**
 * Generic, service-agnostic APK-download card (#2295). Offers a direct
 * download button plus a modal with a QR pointing at the release `url`
 * (from the template's user-guide.md `setup_assets` frontmatter) so a
 * phone can grab the APK by scanning. URL-driven — not tied to any one
 * service (the Solaris companion APK is just one caller once its release
 * artifact exists, solarisbay#823).
 */
export function ApkDownloadButton({
  url,
  label,
  description,
  Icon,
}: {
  url: string;
  label: string;
  description?: string;
  Icon: IconComponent;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="space-y-1.5">
        <a href={url} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
          <Icon size={14} /> {label}
        </a>
        <button onClick={() => setOpen(true)} className={SECONDARY_BUTTON}>
          <QrCode size={14} /> Scan QR to phone
        </button>
        {description && (
          <p className="text-[11px] text-text-subtle mt-space-1 leading-snug text-center">{description}</p>
        )}
      </div>
      {open && (
        <AssetQrModal
          title="Download the app"
          qrUrl={url}
          onClose={() => setOpen(false)}
          instructions="Point your phone camera at this QR to download the app directly."
          ctaHref={url}
          ctaLabel="Or open the download link directly"
        />
      )}
    </>
  );
}

/**
 * Shared QR modal for the URL-driven asset kinds (#2295). Renders a QR
 * encoding an absolute `qrUrl` plus a short instruction line and a
 * direct-link CTA. The QR sits on a literal white tile for scanner
 * contrast regardless of theme (mirrors the BasicSync modal).
 */
function AssetQrModal({
  title,
  qrUrl,
  instructions,
  ctaHref,
  ctaLabel,
  onClose,
}: {
  title: string;
  qrUrl: string;
  instructions: string;
  ctaHref: string;
  ctaLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-space-4 z-50" onClick={onClose}>
      <Card className="shadow-xl max-w-sm w-full p-space-5 text-center" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-text">{title}</h2>
        <p className="text-xs text-text-muted mt-space-1">{instructions}</p>
        <div className="mt-space-4 flex justify-center">
          <div className="bg-white p-space-3 rounded-card">
            <QRCodeSVG value={qrUrl} size={192} level="M" />
          </div>
        </div>
        <a
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-space-3 inline-block text-xs text-accent hover:underline break-all"
        >
          {ctaLabel}
        </a>
      </Card>
    </div>
  );
}
