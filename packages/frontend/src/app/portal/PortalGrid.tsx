'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BookOpen, Bot, Calendar, CalendarDays, Camera, Check, Code, Copy,
  Download, ExternalLink, Files, Film, Folder, FolderOpen, Globe,
  Headphones, House, Image as ImageIcon, Images, KeyRound, Lightbulb,
  Lightbulb as LightbulbIcon, Loader2, Lock, Mail, MessageSquare,
  Music, Package, QrCode, RefreshCw, Router, Shield, Smartphone,
  Terminal, TerminalSquare, Video,
  Sparkles, X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Card } from '@/components/ui';
import type { PortalCard } from '@/lib/portal/services';
import type { AppPlatform, PortalAction, PortalIconName, SetupAssetKind } from '@/lib/portal/userGuide';

type IconComponent = typeof Camera;

/** Per-tier column span on the 12-col `md` grid (#1700). Action-rich
 *  cards get more width; light cards get less; height stays
 *  content-driven (the grid uses `items-start`, not stretch). These MUST
 *  be literal Tailwind classes — Tailwind can't see an interpolated
 *  `col-span-${n}`, so they'd get purged. Keyed by the server-derived
 *  `sizeTier` (`packages/backend/src/lib/portal/services.ts`). */
const SIZE_TIER_SPAN: Record<PortalCard['sizeTier'], string> = {
  compact: 'md:col-span-3', // 4 per row
  regular: 'md:col-span-4', // 3 per row
  feature: 'md:col-span-6', // 2 per row
};

/**
 * Shared anchor/button class-chains on the design-system tokens (epic
 * #2071). The portal's primary affordances are links (Open the service,
 * download an asset) rather than <button>s, so they can't use the
 * <Button> primitive directly — these mirror its primary/secondary
 * padding/radius/hover story on the same `accent`/`surface` tokens so
 * the portal stays coherent with the admin dashboard. The portal keeps a
 * slightly friendlier full-width pill feel, but every colour resolves
 * through a token (dark-mode-correct, no raw hex / blue-600 literals).
 */
const PORTAL_CTA_BUTTON =
  'flex items-center justify-center gap-space-2 w-full rounded-card font-medium py-2.5 ' +
  'bg-accent text-on-accent hover:bg-accent-strong transition-colors';
/** Smaller full-width accent link for per-card setup-asset actions
 *  (download / pair / install). Same accent token, compact height. */
const PORTAL_LINK_BUTTON =
  'flex items-center justify-center gap-space-2 w-full rounded-card text-sm font-medium py-2 ' +
  'bg-accent text-on-accent hover:bg-accent-strong transition-colors';
/** Neutral, bordered secondary action on surface tokens. */
const PORTAL_SECONDARY_BUTTON =
  'flex items-center justify-center gap-space-2 w-full rounded-card text-sm font-medium py-2 ' +
  'bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong transition-colors';

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
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
      {cards.map(card => {
        return (
          <Card
            key={card.id}
            padding="none"
            className={`overflow-hidden flex flex-col col-span-1 ${SIZE_TIER_SPAN[card.sizeTier]}`}
          >
            {/* Header — icon + title + tagline. The tagline is clamped
                to 3 lines; height is content-driven now (#1700), so the
                old `min-h` equal-Y filler is dropped — `items-start` on
                the grid stops the row-stretch. */}
            <div className="p-space-5 pb-space-3">
              <CardIcon card={card} />
              <div className="flex items-center gap-space-2">
                <h2 className="text-xl font-bold text-text">{card.label}</h2>
                <StatusBadge status={card.status} reason={card.statusReason} />
              </div>
              <p className="mt-space-2 text-sm text-text-muted line-clamp-3">
                {card.tagline ?? ''}
              </p>
            </div>

            {/* CTA — at fixed offset from card top thanks to the
                clamped header above. Consistent Y across cards. An
                Open-URL card shows the accent "Open" button; a URL-less
                appless card (#1618) shows its primary action instead,
                followed by any secondary action buttons. */}
            <div className="px-space-5 space-y-space-2">
              <CardCta card={card} isMobile={isMobile} />
            </div>

            {/* Variable content below. Height is content-driven (#1700) —
                no `flex-1` filler; cards no longer stretch to a row's
                tallest sibling. */}
            <div className="px-space-5 pt-space-3 pb-space-5 space-y-space-3">

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
                            className={PORTAL_LINK_BUTTON}
                          >
                            <Icon size={14} /> {label}
                          </a>
                          {asset.description && (
                            <p className="text-[11px] text-text-subtle mt-space-1 leading-snug text-center">{asset.description}</p>
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
                <div className="pt-space-2 space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide font-medium text-text-muted">
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
                            className="font-medium text-accent hover:underline"
                          >
                            {app.name}
                          </a>
                          {app.platforms?.map(p => (
                            <span
                              key={p}
                              className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-chip bg-surface-2 text-text-muted"
                            >
                              {PLATFORM_LABELS[p]}
                            </span>
                          ))}
                        </div>
                        {app.note && (
                          <p className="text-text-subtle mt-0.5 leading-snug">
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
                    className="flex items-center gap-1 text-sm text-accent hover:underline mt-space-2"
                    aria-haspopup="dialog"
                  >
                    How do I use this?
                  </button>
                </div>
              )}
            </div>
          </Card>
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
 * Per-service up/down badge (#1654). Server-derived at page load from
 * the twin health probe + domain reachability check + pod-active state.
 *   - down     → red dot + "Down"
 *   - degraded → amber dot + "Degraded"
 *   - ok       → quiet green dot, no label (the default healthy state
 *                shouldn't shout — only problems draw the eye).
 *   - unknown  → nothing (no signal yet — don't imply a verdict).
 * The portal is anonymous-readable (LAN), so the badge is a bare
 * up/down indicator; `reason` is a short generic title, no internals.
 */
function StatusBadge({ status, reason }: { status: PortalCard['status']; reason?: string }) {
  if (status === 'unknown') return null;
  if (status === 'ok') {
    return (
      <span
        title={reason ?? 'Online'}
        className="inline-block w-2 h-2 rounded-chip bg-status-ok shrink-0"
        aria-label="Online"
      />
    );
  }
  const isDown = status === 'down';
  const classes = isDown
    ? 'bg-status-fail/15 text-status-fail'
    : 'bg-status-warn/15 text-status-warn';
  const dot = isDown ? 'bg-status-fail' : 'bg-status-warn';
  return (
    <span
      title={reason ?? (isDown ? 'Down' : 'Degraded')}
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-chip shrink-0 ${classes}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-chip ${dot}`} />
      {isDown ? 'Down' : 'Degraded'}
    </span>
  );
}

/**
 * Card call-to-action (#1618). An ordinary Open-URL card renders the
 * blue "Open" button pointing at the resolved subdomain. A URL-less
 * appless card (e.g. claude-dev — no subdomain/proxy host) has an
 * empty `url` and a `primaryAction` instead: that action becomes the
 * CTA. Secondary actions render underneath as smaller buttons.
 *
 * Desktop-only actions (`desktop_only`, e.g. `vscode://` which needs a
 * desktop app installed) are hidden on a phone/tablet so the mobile
 * visitor isn't offered a link that can't open.
 */
function CardCta({ card, isMobile }: { card: PortalCard; isMobile: boolean }) {
  if (card.url) {
    return (
      <a
        href={card.url}
        target="_blank"
        rel="noopener noreferrer"
        className={PORTAL_CTA_BUTTON}
      >
        Open <ExternalLink size={16} />
      </a>
    );
  }
  // Appless card: primary action as the CTA, secondaries below.
  const primaryHidden = card.primaryAction?.desktop_only && isMobile;
  return (
    <>
      {card.primaryAction && !primaryHidden && (
        <ActionButton action={card.primaryAction} variant="primary" />
      )}
      {card.primaryAction && primaryHidden && (
        <p className="text-[11px] text-text-subtle text-center leading-snug">
          {card.primaryAction.label} is available on desktop.
        </p>
      )}
      {card.secondaryActions
        .filter(a => !(a.desktop_only && isMobile))
        .map(a => (
          <ActionButton key={a.href} action={a} variant="secondary" />
        ))}
    </>
  );
}

/**
 * Renders one {@link PortalAction} as a button/link. `in_app` actions
 * are root-relative same-origin links (open in the same tab — they're
 * other ServiceBay surfaces like the web terminal); `external_scheme`
 * actions (`vscode://`, …) hand off to a desktop app, so they open via
 * a plain anchor the OS intercepts.
 */
function ActionButton({
  action,
  variant,
}: {
  action: PortalAction;
  variant: 'primary' | 'secondary';
}) {
  const Icon = action.icon ? PORTAL_ICON_MAP[action.icon] : action.type === 'external_scheme' ? Code : TerminalSquare;
  const className = variant === 'primary' ? PORTAL_CTA_BUTTON : PORTAL_SECONDARY_BUTTON;
  // in_app links stay in the tab (same-origin app surface); external
  // schemes open via the same anchor — the OS intercepts the scheme.
  const sameTab = action.type === 'in_app';
  return (
    <a
      href={action.href}
      {...(sameTab ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
      className={className}
    >
      <Icon size={variant === 'primary' ? 16 : 14} /> {action.label}
    </a>
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
      <Card
        padding="none"
        onClick={e => e.stopPropagation()}
        className="shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
      >
        <div className="flex items-start justify-between gap-space-4 p-space-4 border-b border-border">
          <div className="flex items-center gap-space-3 min-w-0">
            <CardIcon card={card} compact />
            <div className="min-w-0">
              <h2 id={`help-${card.id}-title`} className="text-lg font-bold text-text truncate">
                {card.label}
              </h2>
              {card.tagline && (
                <p className="text-sm text-text-muted truncate">{card.tagline}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 p-1 rounded-card text-text-subtle hover:text-text hover:bg-surface-2"
          >
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto px-space-5 py-space-4">
          <div className="prose prose-sm dark:prose-invert max-w-none text-text-muted">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.body}</ReactMarkdown>
          </div>
        </div>
      </Card>
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
    <div className="pt-space-2 space-y-space-2 rounded-card border border-status-warn/40 bg-status-warn/10 p-space-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-status-warn">
        <Terminal size={12} className="shrink-0" /> Manual setup needed
      </div>
      {steps.map(step => (
        <div key={step.title} className="space-y-space-1">
          <p className="text-xs font-medium text-text">{step.title}</p>
          {step.why && (
            <p className="text-[11px] text-text-muted leading-snug">{step.why}</p>
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
      <code className="flex-1 min-w-0 overflow-x-auto rounded-chip bg-surface-muted px-2 py-1.5 text-[11px] font-mono text-text whitespace-pre">
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy command'}
        className="shrink-0 inline-flex items-center justify-center w-8 rounded-chip bg-surface-2 text-text-muted hover:bg-surface-muted hover:text-text transition-colors"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/**
 * Maps a failed setup-asset fetch to a user-facing message. A 401/403
 * means the visitor isn't signed in (public mode requires an SSO or SB
 * session — #1628), which is distinct from the service genuinely not
 * being up yet (the `notReady` text).
 */
function assetFetchError(status: number, notReady: string): string {
  if (status === 401 || status === 403) {
    return `You don't seem to be signed in (HTTP ${status}). Sign in and try again.`;
  }
  return notReady;
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
        setError(assetFetchError(res.status, `Couldn't load the link (HTTP ${res.status}).`));
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
        className={PORTAL_LINK_BUTTON}
      >
        <Icon size={14} /> {label}
      </button>
      {description && !error && (
        <p className="text-[11px] text-text-subtle mt-space-1 leading-snug text-center">{description}</p>
      )}
      {error && (
        <p className="text-[11px] text-status-fail mt-space-1 leading-snug text-center">{error}</p>
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
          className={PORTAL_LINK_BUTTON}
        >
          <Icon size={14} /> {label}
        </button>
        {description && (
          <p className="text-[11px] text-text-subtle mt-space-1 leading-snug text-center">{description}</p>
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-space-4 z-50" onClick={onClose}>
      <Card className="shadow-xl max-w-sm w-full p-space-5 text-center" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-text">Install BasicSync</h2>
        <p className="text-xs text-text-muted mt-space-1">
          Point your phone camera at this QR to download the BasicSync app — a trusted, open-source Syncthing client. Once it&apos;s installed, use the <strong>Pair this device</strong> button to connect.
        </p>

        <div className="mt-space-4 flex justify-center">
          {/* QR stays on a literal white tile — scanners need maximum
              contrast regardless of light/dark theme. */}
          <div className="bg-white p-space-3 rounded-card">
            <QRCodeSVG value={qrUrl} size={192} level="M" />
          </div>
        </div>

        <a
          href={BASICSYNC_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-space-3 inline-block text-xs text-accent hover:underline break-all"
        >
          Or open the download link directly
        </a>
      </Card>
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
        setError(assetFetchError(
          res.status,
          `Couldn't read the device id (HTTP ${res.status}). The Syncthing container might not be running yet — try again in a minute.`,
        ));
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
          className={PORTAL_LINK_BUTTON}
        >
          <Icon size={14} /> {label}
        </button>
        {description && (
          <p className="text-[11px] text-text-subtle mt-space-1 leading-snug text-center">{description}</p>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-space-4 z-50" onClick={() => setOpen(false)}>
          <Card className="shadow-xl max-w-sm w-full p-space-5 text-center" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-text">Pair this device</h2>
            <p className="text-xs text-text-muted mt-space-1">
              In the Syncthing Android app, tap <strong>+</strong> → <strong>Add Device</strong> → <strong>Scan QR</strong>, then point your camera here.
            </p>

            <div className="mt-space-4 flex justify-center min-h-[12rem] items-center">
              {loading && <Loader2 className="animate-spin text-accent" size={32} />}
              {!loading && error && (
                <p className="text-sm text-status-fail">{error}</p>
              )}
              {!loading && deviceId && (
                /* QR stays on a literal white tile for scanner contrast. */
                <div className="bg-white p-space-3 rounded-card">
                  <QRCodeSVG value={deviceId} size={192} level="M" />
                </div>
              )}
            </div>

            {deviceId && (
              <p className="mt-space-3 text-[10px] font-mono text-text-subtle break-all">
                {deviceId}
              </p>
            )}

            <button
              onClick={() => setOpen(false)}
              className="mt-space-4 px-space-4 py-space-2 text-sm text-text-muted hover:text-text"
            >
              Close
            </button>
          </Card>
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
    ? 'inline-flex items-center justify-center w-10 h-10 rounded-card'
    : 'mb-space-3 inline-flex items-center justify-center w-14 h-14 rounded-card';
  const iconSize = compact ? 22 : 28;
  if (card.lucideIcon) {
    const Icon = PORTAL_ICON_MAP[card.lucideIcon];
    return (
      <div className={`${wrapper} bg-accent/15 text-accent`}>
        <Icon size={iconSize} strokeWidth={1.75} />
      </div>
    );
  }
  if (card.icon) {
    return <div className={compact ? 'text-3xl' : 'text-5xl mb-space-3'} aria-hidden>{card.icon}</div>;
  }
  return (
    <div className={`${wrapper} bg-surface-2 text-text-muted`}>
      <Package size={iconSize} strokeWidth={1.75} />
    </div>
  );
}
