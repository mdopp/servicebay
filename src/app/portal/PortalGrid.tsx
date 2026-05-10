'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronUp, Download, ExternalLink, Loader2, QrCode, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { PortalCard } from '@/lib/portal/services';
import type { AppPlatform, SetupAssetKind } from '@/lib/portal/userGuide';

const PLATFORM_LABELS: Record<AppPlatform, string> = {
  ios: 'iOS',
  android: 'Android',
  desktop: 'Desktop',
  browser: 'Browser',
};

const ASSET_LABELS: Record<SetupAssetKind, { label: string; icon: typeof Download }> = {
  ios_calendar_profile: { label: 'Add to iPhone (Calendar + Contacts)', icon: Download },
  audiobookshelf_deeplink: { label: 'Open in Audiobookshelf app', icon: Smartphone },
  syncthing_qr: { label: 'Pair Syncthing device', icon: QrCode },
};

/**
 * Renders the portal card grid + per-card collapsible Getting-started
 * section. Server passes the per-card payload pre-built (incl. parsed
 * markdown body) — this component handles only the UI state.
 */
export default function PortalGrid({ cards }: { cards: PortalCard[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {cards.map(card => {
        const isExpanded = !!expanded[card.name];
        return (
          <div
            key={card.name}
            className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden flex flex-col"
          >
            <div className="p-6 flex-1">
              <div className="text-5xl mb-3" aria-hidden>{card.icon || '📦'}</div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">{card.label}</h2>
              {card.tagline && (
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{card.tagline}</p>
              )}
            </div>

            <div className="px-6 pb-6 space-y-3">
              <a
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full bg-violet-600 hover:bg-violet-700 text-white font-medium py-2.5 rounded-lg transition-colors"
              >
                Open <ExternalLink size={16} />
              </a>

              {card.setupAssets.length > 0 && (
                <div className="space-y-1.5">
                  {card.setupAssets.map(asset => {
                    const meta = ASSET_LABELS[asset.kind];
                    const Icon = meta.icon;
                    const label = asset.label ?? meta.label;
                    if (asset.kind === 'ios_calendar_profile') {
                      return (
                        <div key={asset.kind}>
                          <a
                            href={`/api/portal/asset/${card.name}/${asset.kind}`}
                            className="flex items-center justify-center gap-2 w-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 rounded-lg transition-colors"
                          >
                            <Icon size={14} /> {label}
                          </a>
                          {asset.description && (
                            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-snug text-center">{asset.description}</p>
                          )}
                        </div>
                      );
                    }
                    if (asset.kind === 'audiobookshelf_deeplink') {
                      return (
                        <DeepLinkButton key={asset.kind} card={card} kind={asset.kind} label={label} description={asset.description} Icon={Icon} />
                      );
                    }
                    if (asset.kind === 'syncthing_qr') {
                      return (
                        <SyncthingQrButton key={asset.kind} card={card} label={label} description={asset.description} Icon={Icon} />
                      );
                    }
                    return null;
                  })}
                </div>
              )}

              {card.recommendedApps.length > 0 && (
                <div className="pt-2 space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide font-medium text-gray-500 dark:text-gray-400">
                    💡 Recommended apps
                  </div>
                  <ul className="space-y-1.5">
                    {card.recommendedApps.map(app => (
                      <li key={app.url} className="text-xs">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <a
                            href={app.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-violet-700 dark:text-violet-300 hover:underline"
                          >
                            {app.name}
                          </a>
                          {app.platforms?.map(p => (
                            <span
                              key={p}
                              className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                            >
                              {PLATFORM_LABELS[p]}
                            </span>
                          ))}
                        </div>
                        {app.note && (
                          <p className="text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
                            {app.note}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {card.body.trim().length > 0 && (
                <div>
                  <button
                    onClick={() => setExpanded(s => ({ ...s, [card.name]: !s[card.name] }))}
                    className="flex items-center gap-1 text-sm text-violet-700 dark:text-violet-300 hover:underline mt-2"
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {isExpanded ? 'Hide getting-started' : 'How do I use this?'}
                  </button>
                  {isExpanded && (
                    <div className="prose prose-sm dark:prose-invert mt-3 max-w-none text-gray-700 dark:text-gray-300">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.body}</ReactMarkdown>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Deep-link button for setup assets that resolve to a custom-scheme
 * URL (`abs://`, etc.). Fetches the URL from the asset endpoint on
 * click, then sets `window.location` so the browser hands off to the
 * registered app — or shows a friendly fallback if no app handles it.
 */
function DeepLinkButton({
  card,
  kind,
  label,
  description,
  Icon,
}: {
  card: PortalCard;
  kind: SetupAssetKind;
  label: string;
  description?: string;
  Icon: typeof Smartphone;
}) {
  const [error, setError] = useState<string | null>(null);
  const onClick = async () => {
    setError(null);
    try {
      const res = await fetch(`/api/portal/asset/${card.name}/${kind}`);
      if (!res.ok) {
        setError(`Couldn't load the link (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json() as { url?: string };
      if (typeof data.url !== 'string') {
        setError('No URL returned.');
        return;
      }
      // Same-tab navigation — the browser hands off to the registered
      // app. If no app is registered, the user just sees a "can't
      // open this URL" prompt; we add a small fallback note below.
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div>
      <button
        onClick={onClick}
        className="flex items-center justify-center gap-2 w-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 rounded-lg transition-colors"
      >
        <Icon size={14} /> {label}
      </button>
      {description && !error && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-snug text-center">{description}</p>
      )}
      {error && (
        <p className="text-[11px] text-red-600 dark:text-red-400 mt-1 leading-snug text-center">{error}</p>
      )}
    </div>
  );
}

/**
 * Syncthing QR pairing button. Fetches the server's device ID
 * lazily on click (it's a podman-exec round-trip, so we don't
 * pre-fetch it on every card render) and opens a modal with the QR
 * code rendered client-side. The Android Syncthing app's "Add
 * Device → Scan QR" reads it directly.
 */
function SyncthingQrButton({
  card,
  label,
  description,
  Icon,
}: {
  card: PortalCard;
  label: string;
  description?: string;
  Icon: typeof QrCode;
}) {
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOpen = async () => {
    setOpen(true);
    if (deviceId || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/asset/${card.name}/syncthing_qr`);
      if (!res.ok) {
        setError(`Couldn't read the device id (HTTP ${res.status}). The Syncthing container might not be running yet — try again in a minute.`);
        return;
      }
      const data = await res.json() as { deviceId?: string };
      if (typeof data.deviceId !== 'string') {
        setError('No device id returned.');
        return;
      }
      setDeviceId(data.deviceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div>
        <button
          onClick={onOpen}
          className="flex items-center justify-center gap-2 w-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 rounded-lg transition-colors"
        >
          <Icon size={14} /> {label}
        </button>
        {description && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-snug text-center">{description}</p>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setOpen(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl max-w-sm w-full p-6 text-center" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">Pair this device</h2>
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
              In the Syncthing Android app, tap <strong>+</strong> → <strong>Add Device</strong> → <strong>Scan QR</strong>, then point your camera here.
            </p>

            <div className="mt-5 flex justify-center min-h-[12rem] items-center">
              {loading && <Loader2 className="animate-spin text-violet-500" size={32} />}
              {!loading && error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
              {!loading && deviceId && (
                <div className="bg-white p-4 rounded-lg">
                  <QRCodeSVG value={deviceId} size={192} level="M" />
                </div>
              )}
            </div>

            {deviceId && (
              <p className="mt-3 text-[10px] font-mono text-gray-500 dark:text-gray-400 break-all">
                {deviceId}
              </p>
            )}

            <button
              onClick={() => setOpen(false)}
              className="mt-4 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
