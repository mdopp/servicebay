'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BookOpen, Bot, Calendar, CalendarDays, Camera, Check, Copy,
  Download, ExternalLink, Files, Film, Folder, FolderOpen, Globe,
  Headphones, House, Image as ImageIcon, Images, KeyRound, Lightbulb,
  Lightbulb as LightbulbIcon, Loader2, Lock, Mail, MessageSquare,
  Music, Package, QrCode, RefreshCw, Router, Shield, Smartphone, Terminal, Video,
  Sparkles, X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { PortalCard } from '@/lib/portal/services';
import type { AppPlatform, PortalIconName, SetupAssetKind } from '@/lib/portal/userGuide';

type IconComponent = typeof Camera;

/** Maps the kebab-case Lucide names allowlisted in user-guide
 *  frontmatter to their imported components. Keep in sync with
 *  PORTAL_ICONS in userGuide.ts. */
const PORTAL_ICON_MAP: Record<PortalIconName, IconComponent> = {
  'camera': Camera,
  'image': ImageIcon,
  'images': Images,
  'folder': Folder,
  'folder-open': FolderOpen,
  'files': Files,
  'refresh-cw': RefreshCw,
  'calendar': Calendar,
  'calendar-days': CalendarDays,
  'music': Music,
  'headphones': Headphones,
  'book-open': BookOpen,
  'lock': Lock,
  'shield': Shield,
  'key-round': KeyRound,
  'house': House,
  'lightbulb': Lightbulb,
  'globe': Globe,
  'router': Router,
  'mail': Mail,
  'message-square': MessageSquare,
  'video': Video,
  'film': Film,
  'bot': Bot,
  'package': Package,
};

void LightbulbIcon; // alias kept for parser-friendliness, not used directly

const PLATFORM_LABELS: Record<AppPlatform, string> = {
  ios: 'iOS',
  android: 'Android',
  desktop: 'Desktop',
  browser: 'Browser',
};

const ASSET_LABELS: Record<SetupAssetKind, { label: string; icon: IconComponent }> = {
  ios_calendar_profile: { label: 'Add to iPhone (Calendar + Contacts)', icon: Download },
  audiobookshelf_deeplink: { label: 'Open in Audiobookshelf app', icon: Smartphone },
  syncthing_qr: { label: 'Pair Syncthing device', icon: QrCode },
  basicsync_install_qr: { label: 'Install BasicSync on your phone', icon: Download },
};

/** Coarse user-agent sniff for iOS devices — iPhone / iPad / iPod.
 *  SSR snapshot is `false` (treat as non-iOS during the static paint)
 *  so iOS-only assets briefly hide on hydration mismatch rather than
 *  being shown then yanked. We deliberately *don't* try to detect
 *  Android specifically — the rule is "iOS or not", with desktop
 *  treated as not-iOS but still showing all assets (operator may be
 *  evaluating from a laptop with the phone next to them). See #325.
 *
 *  useSyncExternalStore avoids a setState-in-effect that the
 *  `react-hooks/set-state-in-effect` rule flags. The empty subscribe
 *  is fine — UA doesn't change at runtime so we never need to notify. */
const noopSubscribe = () => () => {};

function useIsIOS(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => /iPhone|iPad|iPod/.test(navigator.userAgent),
    () => false,
  );
}

/** Coarse "is this a phone/tablet" detector. Used together with
 *  `isIOS` to decide whether a `desktop` user gets all assets shown
 *  (yes — they may be evaluating before grabbing the phone) or only
 *  the per-OS subset. */
function useIsMobile(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
    () => false,
  );
}

/** Decide whether to render an asset for the current device. The rule
 *  set is intentionally minimal — the few assets we ship today break
 *  cleanly along OS lines:
 *    - ios_calendar_profile: only useful on iOS (the .mobileconfig is
 *      iOS-only). Hide on Android phones; keep visible on desktop so
 *      the operator can demo it.
 *    - audiobookshelf_deeplink, syncthing_qr: cross-platform (the
 *      iOS Syncthing client is shaky but exists; abs:// works on
 *      both). Always visible.
 */
function shouldShowAsset(kind: SetupAssetKind, isIOS: boolean, isMobile: boolean): boolean {
  if (kind === 'ios_calendar_profile') {
    if (isMobile && !isIOS) return false; // Android phone — hide
    return true; // iOS phone or desktop
  }
  return true;
}

/** Per-asset label that adapts to the rendering device. Helps the
 *  Android-primary operator see Android-framed CTAs while still
 *  giving iOS visitors the iPhone-flavored copy. See #325. */
function assetLabel(kind: SetupAssetKind, override: string | undefined, isIOS: boolean): string {
  if (override) return override;
  const base = ASSET_LABELS[kind].label;
  if (kind === 'syncthing_qr' && !isIOS) {
    return 'Pair with Android Syncthing';
  }
  return base;
}

/**
 * Renders the portal card grid + per-card collapsible Getting-started
 * section. Server passes the per-card payload pre-built (incl. parsed
 * markdown body) — this component handles only the UI state.
 */
export default function PortalGrid({ cards }: { cards: PortalCard[] }) {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const isIOS = useIsIOS();
  const isMobile = useIsMobile();

  const activeCard = cards.find(c => c.id === activeCardId) ?? null;

  // Esc + body-scroll lock while modal is open. Pure UX — the markdown
  // body inside is read-only, so no focus-trap escape hatches needed
  // beyond the explicit Close button. See #324.
  useEffect(() => {
    if (!activeCard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveCardId(null);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [activeCard]);

  return (
    <>
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {cards.map(card => {
        return (
          <div
            key={card.id}
            className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden flex flex-col"
          >
            {/* Header — icon + title + tagline. The tagline area is
                clamped to 3 lines + min-h so the Open button below
                lands at the same Y on every card in a row. */}
            <div className="p-6 pb-3">
              <CardIcon card={card} />
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">{card.label}</h2>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 line-clamp-3 min-h-[3.75rem]">
                {card.tagline ?? ''}
              </p>
            </div>

            {/* Open button — at fixed offset from card top thanks to
                the clamped header above. Consistent Y across cards. */}
            <div className="px-6">
              <a
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition-colors"
              >
                Open <ExternalLink size={16} />
              </a>
            </div>

            {/* Variable content below — fills the rest of the card so
                grid-cell heights stay equal even with different
                amounts of recommended apps / setup assets. */}
            <div className="px-6 pt-3 pb-6 space-y-3 flex-1">
              {/* (the original wrapper continues; adjusted closing
                   tag is below — left here so the diff is contained.) */}

              {card.setupAssets.length > 0 && (
                <div className="space-y-1.5">
                  {card.setupAssets.map(asset => {
                    if (!shouldShowAsset(asset.kind, isIOS, isMobile)) return null;
                    const meta = ASSET_LABELS[asset.kind];
                    const Icon = meta.icon;
                    const label = assetLabel(asset.kind, asset.label, isIOS);
                    if (asset.kind === 'ios_calendar_profile') {
                      return (
                        <div key={asset.kind}>
                          <a
                            href={`/api/portal/asset/${card.name}/${asset.kind}?subdomain_var=${encodeURIComponent(card.subdomainVar)}`}
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
                    if (asset.kind === 'basicsync_install_qr') {
                      return (
                        <BasicSyncInstallQrButton key={asset.kind} label={label} description={asset.description} Icon={Icon} />
                      );
                    }
                    return null;
                  })}
                </div>
              )}

              {card.manualPairing.length > 0 && (
                <ManualPairingPanel steps={card.manualPairing} />
              )}

              {card.recommendedApps.length > 0 && (
                <div className="pt-2 space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide font-medium text-gray-500 dark:text-gray-400">
                    <Sparkles size={11} className="inline align-middle -mt-0.5" /> Recommended apps
                  </div>
                  <ul className="space-y-1.5">
                    {card.recommendedApps.map(app => (
                      <li key={app.url} className="text-xs">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <a
                            href={app.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-blue-700 dark:text-blue-300 hover:underline"
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
                    onClick={() => setActiveCardId(card.id)}
                    className="flex items-center gap-1 text-sm text-blue-700 dark:text-blue-300 hover:underline mt-2"
                    aria-haspopup="dialog"
                  >
                    How do I use this?
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>

    {activeCard && (
      <CardHelpModal card={activeCard} onClose={() => setActiveCardId(null)} />
    )}
    </>
  );
}

/**
 * Centered modal that renders the markdown getting-started body at a
 * comfortable reading width. Replaces the inline-expand which was
 * unreadable on a 3-column desktop grid (#324).
 *
 * Dismisses on outside-click, Esc (handled by parent), and the close
 * button. We keep the focus-management minimal — the body is read-only
 * + has a single close action, so a full focus-trap library wasn't
 * worth pulling in.
 */
function CardHelpModal({ card, onClose }: { card: PortalCard; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`help-${card.id}-title`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 sm:p-8"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
      >
        <div className="flex items-start justify-between gap-4 p-5 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-3 min-w-0">
            <CardIcon card={card} compact />
            <div className="min-w-0">
              <h2 id={`help-${card.id}-title`} className="text-lg font-bold text-gray-900 dark:text-white truncate">
                {card.label}
              </h2>
              {card.tagline && (
                <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{card.tagline}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <div className="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.body}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Static "manual action required" panel (#1253). Lists the
 * inherently-interactive setup steps a template declared via
 * `manual_pairing` (e.g. Signal `signal-cli link` QR pairing — it
 * needs a TTY, so the web portal can only point at it, not run it).
 * Each step shows its title, an optional why-note, and the exact
 * command in a copyable monospace block.
 */
function ManualPairingPanel({ steps }: { steps: PortalCard['manualPairing'] }) {
  return (
    <div className="pt-2 space-y-2 rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-300">
        <Terminal size={12} className="shrink-0" /> Manual setup needed
      </div>
      {steps.map(step => (
        <div key={step.title} className="space-y-1">
          <p className="text-xs font-medium text-amber-900 dark:text-amber-100">{step.title}</p>
          {step.why && (
            <p className="text-[11px] text-amber-800/90 dark:text-amber-200/80 leading-snug">{step.why}</p>
          )}
          <CommandBlock command={step.command} />
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only command line for a `manual_pairing` step (#1253) — the
 * operator has to run an interactive `podman exec -it … signal-cli
 * link` in a real shell (the QR can't be driven from the web), so we
 * show the exact command in monospace with a one-click copy. Copy
 * falls back gracefully when the Clipboard API is unavailable
 * (non-secure context / older browser): the text stays selectable.
 */
function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the command stays selectable for a
      // manual copy, so we just don't flash the confirmation.
    }
  };
  return (
    <div className="flex items-stretch gap-1.5">
      <code className="flex-1 min-w-0 overflow-x-auto rounded bg-amber-100/70 dark:bg-amber-950/40 px-2 py-1.5 text-[11px] font-mono text-amber-900 dark:text-amber-100 whitespace-pre">
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy command'}
        className="shrink-0 inline-flex items-center justify-center w-8 rounded bg-amber-200/70 dark:bg-amber-800/40 text-amber-800 dark:text-amber-200 hover:bg-amber-300/70 dark:hover:bg-amber-700/50 transition-colors"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
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
      const res = await fetch(`/api/portal/asset/${card.name}/${kind}?subdomain_var=${encodeURIComponent(card.subdomainVar)}`);
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
 * BasicSync install QR. Opens a modal with a QR encoding the static
 * `/api/system/downloads/basicsync` URL so the operator can point a
 * phone camera at it and download the recommended sync client APK
 * directly — no app-store hunt, no server round-trip. This is the
 * "install the app" step; the SyncthingQrButton below is the
 * separate "pair the device" step.
 */
const BASICSYNC_INSTALL_URL = '/api/system/downloads/basicsync?abi=arm64-v8a';

function BasicSyncInstallQrButton({
  label,
  description,
  Icon,
}: {
  label: string;
  description?: string;
  Icon: typeof Download;
}) {
  const [open, setOpen] = useState(false);
  // The QR needs an absolute URL — a phone scanning it has no notion
  // of the portal's origin. Resolve against the current location at
  // render time (the portal is served from the box's public host).
  const absoluteUrl =
    typeof window !== 'undefined'
      ? new URL(BASICSYNC_INSTALL_URL, window.location.origin).toString()
      : BASICSYNC_INSTALL_URL;

  return (
    <>
      <div>
        <button
          onClick={() => setOpen(true)}
          className="flex items-center justify-center gap-2 w-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 rounded-lg transition-colors"
        >
          <Icon size={14} /> {label}
        </button>
        {description && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-snug text-center">{description}</p>
        )}
      </div>

      {open && <BasicSyncInstallModal qrUrl={absoluteUrl} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The QR modal opened by {@link BasicSyncInstallQrButton}. Split out
 *  to keep the button under the per-function line budget. */
function BasicSyncInstallModal({ qrUrl, onClose }: { qrUrl: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl max-w-sm w-full p-6 text-center" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-gray-900 dark:text-white">Install BasicSync</h2>
        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
          Point your phone camera at this QR to download the BasicSync app — a trusted, open-source Syncthing client. Once it&apos;s installed, use the <strong>Pair this device</strong> button to connect.
        </p>

        <div className="mt-5 flex justify-center">
          <div className="bg-white p-4 rounded-lg">
            <QRCodeSVG value={qrUrl} size={192} level="M" />
          </div>
        </div>

        <a
          href={BASICSYNC_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-block text-xs text-blue-700 dark:text-blue-300 hover:underline break-all"
        >
          Or open the download link directly
        </a>
      </div>
    </div>
  );
}

/**
 * Syncthing QR pairing button. Fetches the server's device ID
 * lazily on click (it's a podman-exec round-trip, so we don't
 * pre-fetch it on every card render) and opens a modal with the QR
 * code rendered client-side. The BasicSync app's "Add Device →
 * Scan QR" reads it directly.
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
      const res = await fetch(`/api/portal/asset/${card.name}/syncthing_qr?subdomain_var=${encodeURIComponent(card.subdomainVar)}`);
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
              {loading && <Loader2 className="animate-spin text-blue-500" size={32} />}
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

/**
 * Card hero icon. Renders the Lucide line-art icon when the
 * frontmatter declares `lucide_icon`; falls back to the legacy
 * emoji for any user-guide that hasn't migrated; finally falls
 * back to a neutral Package icon for guides with neither.
 *
 * The line-art rendering matches ServiceBay's dashboard chrome
 * (Sidebar, header logos) so the family portal feels like the
 * same product, not a separate emoji-themed surface.
 */
function CardIcon({ card, compact = false }: { card: PortalCard; compact?: boolean }) {
  // The modal header reuses CardIcon at a smaller size — `compact`
  // shrinks the chip + drops the trailing margin so the icon sits
  // flush with the title block. The card grid keeps the original size.
  const wrapper = compact
    ? 'inline-flex items-center justify-center w-10 h-10 rounded-xl'
    : 'mb-3 inline-flex items-center justify-center w-14 h-14 rounded-2xl';
  const iconSize = compact ? 22 : 28;
  if (card.lucideIcon) {
    const Icon = PORTAL_ICON_MAP[card.lucideIcon];
    return (
      <div className={`${wrapper} bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400`}>
        <Icon size={iconSize} strokeWidth={1.75} />
      </div>
    );
  }
  if (card.icon) {
    return <div className={compact ? 'text-3xl' : 'text-5xl mb-3'} aria-hidden>{card.icon}</div>;
  }
  return (
    <div className={`${wrapper} bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400`}>
      <Package size={iconSize} strokeWidth={1.75} />
    </div>
  );
}
