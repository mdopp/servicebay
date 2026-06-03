/**
 * Per-template user-guide.md frontmatter parser for /portal (#242).
 *
 * Each template can ship `user-guide.md` with YAML frontmatter:
 *
 *   ---
 *   icon: "📷"
 *   tagline: "Auto-backup your family photos and browse them like Google Photos."
 *   mobile_apps:
 *     - name: "Immich for iOS"
 *       url: "https://apps.apple.com/app/immich/id1613945652"
 *   ---
 *
 *   # Getting started with Photos
 *   ...
 *
 * Templates without a guide don't appear on the portal. Templates with
 * malformed frontmatter return null with a logged warning so a single
 * bad guide doesn't crash the page render.
 */

import matter from 'gray-matter';
import { logger } from '@/lib/logger';

/** Platforms a recommended app runs on. The UI renders these as
 *  small text badges next to the app name so visitors can see at a
 *  glance whether the recommendation applies to their device. */
export type AppPlatform = 'ios' | 'android' | 'desktop' | 'browser';
const KNOWN_PLATFORMS: ReadonlySet<AppPlatform> = new Set(['ios', 'android', 'desktop', 'browser']);

/**
 * Recommended companion software for a service. Replaces the older
 * narrower `mobile_apps[]` schema — supports desktop apps, browser
 * extensions, and per-app notes explaining the recommendation
 * (e.g. "Obsidian for notes, syncs via Syncthing").
 *
 * Authors using the old `mobile_apps:` shape still work — the parser
 * back-fills platforms/notes from name conventions when both fields
 * are present we use `recommended_apps` and ignore `mobile_apps`.
 */
export interface RecommendedApp {
  name: string;
  url: string;
  /** Platforms this app runs on. Empty/missing = no badge shown. */
  platforms?: AppPlatform[];
  /** One-line "why this app" note, rendered small under the name. */
  note?: string;
}

/** Pre-configured setup artifact a card can offer (#242 follow-up).
 *  Each kind is generated server-side and exposed as a per-template
 *  asset. The portal card renders one button per asset; clicking
 *  either downloads the artifact (e.g. iOS .mobileconfig) or opens
 *  a URL (e.g. abs:// deep link).
 *
 *  Whitelist of recognized kinds:
 *    - `ios_calendar_profile` — Apple-standard .mobileconfig that
 *      adds CalDAV + CardDAV accounts to iOS Settings in two taps.
 *    - `audiobookshelf_deeplink` — `abs://` URL the official
 *      Audiobookshelf app picks up to pre-configure the server.
 *    - `syncthing_qr` — encodes the file-share container's
 *      device ID into a QR; the BasicSync (Syncthing-compatible)
 *      app's "Add Device" → "Scan QR" reads it directly. The server
 *      fetches the device ID at request time via `podman exec`
 *      against the running syncthing container.
 *    - `basicsync_install_qr` — a QR/link to the BasicSync APK
 *      download so the operator can install the recommended sync
 *      client straight onto the phone (point the phone camera at it
 *      → the APK download opens). Pure client-side render of the
 *      `/api/system/downloads/basicsync` URL — no server round-trip.
 */
export type SetupAssetKind =
  | 'ios_calendar_profile'
  | 'audiobookshelf_deeplink'
  | 'syncthing_qr'
  | 'basicsync_install_qr';

const KNOWN_ASSET_KINDS: ReadonlySet<SetupAssetKind> = new Set([
  'ios_calendar_profile',
  'audiobookshelf_deeplink',
  'syncthing_qr',
  'basicsync_install_qr',
]);

export interface SetupAsset {
  kind: SetupAssetKind;
  /** Optional override for the button label. Defaults to a per-kind
   *  built-in label so most templates don't need to set it. */
  label?: string;
  /** Optional one-line description rendered as a tooltip + below
   *  the button on the card. */
  description?: string;
}

/**
 * A one-off interactive setup step the operator has to run by hand,
 * surfaced as a static "manual action required" panel on the card
 * (#1253). The canonical case is Signal pairing for a messaging
 * gateway: `podman exec -it <hermes> signal-cli link -n HermesAgent`
 * renders a QR in *that terminal* and can't be driven from the web
 * (it needs a TTY). We don't try to automate it — we just tell the
 * operator the step exists, why, and the exact command to copy.
 *
 * Distinct from `setup_assets`, which are things the portal can *do*
 * for the visitor (download a profile, render a QR server-side). A
 * `manual_pairing` entry is purely informational: copy the command,
 * run it in a shell.
 */
export interface ManualPairing {
  /** Short heading, e.g. "Pair the Signal account". */
  title: string;
  /** The exact shell command to run, e.g.
   *  `podman exec -it hermes signal-cli link -n HermesAgent`.
   *  Rendered in a monospace block with a copy button. */
  command: string;
  /** Optional one-line "why this is needed / what to expect" note
   *  (e.g. "Scan the QR shown in the terminal with Signal on your
   *  phone — Settings → Linked devices → Link new device"). */
  why?: string;
}

/**
 * A primary/secondary card action for a service that has no Open-URL
 * (#1618). The canonical case is claude-dev: no subdomain/proxy host,
 * so the card can't offer an "Open" button — instead it offers a
 * deep-link action (open the web terminal at `/terminal?...`) or an
 * external-scheme link (`vscode://...`). Distinct from `manual_pairing`
 * (a copyable command) and `setup_assets` (a server-generated artifact).
 *
 * Two link shapes are recognized:
 *   - `in_app`: a root-relative path served from the same origin
 *     (e.g. `/terminal?node=Local&container=claude-dev`). Rendered as
 *     a normal in-app link.
 *   - `external_scheme`: a custom-scheme URI the OS hands off to a
 *     desktop app (`vscode://`, `zed://`, …). Inherently desktop-only,
 *     so it carries `desktop_only:true` by default and the phone UI
 *     hides/disables it.
 */
export type PortalActionType = 'in_app' | 'external_scheme';

/** External URI schemes a card action may use. Allowlisted so a
 *  template author can't smuggle `javascript:`/`data:` into an action
 *  link. Each is a registered desktop-app handoff scheme. */
const KNOWN_ACTION_SCHEMES = ['vscode', 'vscode-insiders', 'zed', 'jetbrains'] as const;

export interface PortalAction {
  type: PortalActionType;
  /** Button label, e.g. "Open terminal" or "Open in VS Code". */
  label: string;
  /** The link target: a root-relative `/path?...` for `in_app`, or a
   *  `<scheme>://...` URI for `external_scheme`. */
  href: string;
  /** Optional Lucide icon for the button (from the portal allowlist). */
  icon?: PortalIconName;
  /** When true, the phone UI hides/disables this action (the target
   *  needs a desktop app, e.g. `vscode://`). Defaults true for
   *  `external_scheme`, false for `in_app`. */
  desktop_only?: boolean;
}

/**
 * Curated allowlist of Lucide icon names usable on portal cards.
 * Lucide is the same line-art icon set the dashboard sidebar uses,
 * so picking from this set keeps the portal visually consistent
 * with ServiceBay's existing chrome (no emoji, no per-template SVG
 * imports). The whitelist also acts as a safety boundary —
 * frontmatter is template-author input but only these names render;
 * unknown values silently drop to fallback.
 */
const PORTAL_ICONS = [
  'camera', 'image', 'images',          // photos / gallery
  'folder', 'folder-open', 'files',     // files / sharing
  'refresh-cw',                         // sync (Syncthing)
  'calendar', 'calendar-days',          // calendar / contacts
  'music', 'headphones', 'book-open',   // music / audiobooks
  'lock', 'shield', 'key-round',        // passwords / vault
  'house', 'lightbulb',                 // smart home
  'globe', 'router',                    // network
  'mail', 'message-square',             // mail / chat
  'video', 'film',                      // video / streaming
  'bot',                                // AI agent (Hermes / OSCAR)
  'package',                            // generic fallback
] as const;
export type PortalIconName = typeof PORTAL_ICONS[number];

const PORTAL_ICON_SET: ReadonlySet<string> = new Set(PORTAL_ICONS);

/**
 * Per-subdomain card definition. Templates that host multiple
 * services (e.g. `media` runs both Audiobookshelf at `books.<domain>`
 * and Navidrome at `music.<domain>`) declare one entry per service
 * via `cards[]` in the frontmatter, and the portal emits one card
 * per entry.
 *
 * Single-service templates skip `cards[]` entirely — the parser
 * synthesizes a single implicit card from the top-level frontmatter.
 */
export interface UserGuideCard {
  /** Variable name in the template's `variables.json` to use as the
   *  subdomain. e.g. `"ABS_SUBDOMAIN"` for Audiobookshelf. */
  subdomain_var: string;
  /** Optional override label; falls back to the template label. */
  label?: string;
  lucide_icon?: PortalIconName;
  icon?: string;
  tagline?: string;
  recommended_apps?: RecommendedApp[];
  setup_assets?: SetupAsset[];
  manual_pairing?: ManualPairing[];
  /** Primary action when this card has no Open-URL (#1618). When set,
   *  the card renders even without a resolvable subdomain. */
  primary_action?: PortalAction;
  /** Additional actions rendered as secondary buttons. */
  actions?: PortalAction[];
}

export interface UserGuideFrontmatter {
  /** Multi-service templates (`media`) declare per-subdomain cards
   *  here. When present, top-level icon/tagline/etc. are ignored and
   *  one PortalCard is emitted per entry. */
  cards?: UserGuideCard[];

  /** Lucide icon name (line-art, matches ServiceBay's dashboard
   *  chrome). Preferred over the legacy emoji `icon` field. Used
   *  when `cards` is absent. */
  lucide_icon?: PortalIconName;
  /** Legacy emoji icon (📷 / 🏠 / …). Kept for back-compat;
   *  templates should migrate to `lucide_icon` for visual
   *  consistency with the dashboard. */
  icon?: string;
  tagline?: string;
  /** Preferred — richer recommended-apps with platforms + notes. */
  recommended_apps?: RecommendedApp[];
  /** Legacy mobile-app shape (#242 v1). Lifted into recommended_apps
   *  by the parser when present and recommended_apps isn't. Kept as
   *  inline type rather than a named export so knip doesn't flag the
   *  back-compat-only interface. */
  mobile_apps?: { name: string; url: string }[];
  /** Per-template setup artifacts (iOS profile, deep links, …). */
  setup_assets?: SetupAsset[];
  /** Manual, inherently-interactive setup steps the operator runs by
   *  hand (e.g. `signal-cli link` QR pairing). Surfaced as a static
   *  "manual action required" panel — informational only (#1253). */
  manual_pairing?: ManualPairing[];
  /** Primary card action for a URL-less service (#1618). When present,
   *  the portal renders the card even without a resolvable subdomain;
   *  the CTA becomes this action instead of an Open-URL button. */
  primary_action?: PortalAction;
  /** Secondary actions rendered as extra buttons below the CTA. */
  actions?: PortalAction[];
}

export interface ParsedUserGuide {
  frontmatter: UserGuideFrontmatter;
  /** Markdown body with frontmatter stripped. May be empty. */
  body: string;
}

/**
 * Parse the raw markdown into frontmatter + body. Returns null when
 * the input is empty or the YAML is unparseable; missing fields are
 * tolerated (the caller renders best-effort with whatever's there).
 */
/** Filter array of unknown entries down to a clean { name, url, ... }
 *  list, dropping any that fail validation (non-string fields,
 *  non-http URLs, unknown platforms). Frontmatter is template-author
 *  input — we do basic sanitization so a hostile guide can't smuggle
 *  e.g. `javascript:` URLs or arbitrary platform values into the UI. */
function parseRecommendedApps(input: unknown): RecommendedApp[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry: unknown): RecommendedApp | null => {
      if (!entry || typeof entry !== 'object') return null;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== 'string' || typeof e.url !== 'string') return null;
      // Accept absolute http(s) links and same-origin root-relative paths
      // (e.g. `/api/system/downloads/...` for a dynamically-resolved, always-
      // latest download). Reject protocol-relative `//host` and dangerous
      // schemes (`javascript:`, `data:`) — these become an `href`.
      const isHttp = /^https?:\/\//i.test(e.url);
      const isRootRelative = e.url.startsWith('/') && !e.url.startsWith('//');
      if (!isHttp && !isRootRelative) return null;
      const out: RecommendedApp = { name: e.name, url: e.url };
      if (Array.isArray(e.platforms)) {
        const platforms = e.platforms
          .filter((p): p is string => typeof p === 'string')
          .map(p => p.toLowerCase())
          .filter((p): p is AppPlatform => KNOWN_PLATFORMS.has(p as AppPlatform));
        if (platforms.length > 0) out.platforms = platforms;
      }
      if (typeof e.note === 'string' && e.note.trim()) {
        out.note = e.note.trim();
      }
      return out;
    })
    .filter((e): e is RecommendedApp => e !== null);
}

/** Lift a legacy `mobile_apps[]` entry list into the richer
 *  `recommended_apps[]` shape — used as a fallback when a template
 *  hasn't migrated yet. Heuristically infers the platform from the
 *  link's host (App Store → ios, Play Store → android). */
function liftMobileApps(input: unknown): RecommendedApp[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry: unknown): RecommendedApp | null => {
      if (!entry || typeof entry !== 'object') return null;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== 'string' || typeof e.url !== 'string') return null;
      if (!/^https?:\/\//i.test(e.url)) return null;
      const platforms: AppPlatform[] = [];
      if (/apps\.apple\.com|itunes\.apple\.com/.test(e.url)) platforms.push('ios');
      if (/play\.google\.com/.test(e.url)) platforms.push('android');
      const out: RecommendedApp = { name: e.name, url: e.url };
      if (platforms.length > 0) out.platforms = platforms;
      return out;
    })
    .filter((e): e is RecommendedApp => e !== null);
}

/** Parse a `manual_pairing[]` list. Each entry needs a non-empty
 *  `title` + `command` (both template-author strings, rendered as
 *  text — never executed); `why` is optional. Entries missing either
 *  required field are dropped so a malformed one doesn't render a
 *  blank panel. */
function parseManualPairing(input: unknown): ManualPairing[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry: unknown): ManualPairing | null => {
      if (!entry || typeof entry !== 'object') return null;
      const e = entry as Record<string, unknown>;
      if (typeof e.title !== 'string' || !e.title.trim()) return null;
      if (typeof e.command !== 'string' || !e.command.trim()) return null;
      const out: ManualPairing = { title: e.title.trim(), command: e.command.trim() };
      if (typeof e.why === 'string' && e.why.trim()) out.why = e.why.trim();
      return out;
    })
    .filter((e): e is ManualPairing => e !== null);
}

/** Validate a single action link (#1618). Returns null when the entry
 *  is malformed or the href fails the per-type safety check:
 *    - `in_app`: a same-origin root-relative path (`/...`, not `//`).
 *    - `external_scheme`: a `<scheme>://...` URI whose scheme is in the
 *      allowlist (`vscode`, `zed`, …) — blocks `javascript:`/`data:`.
 *  `desktop_only` defaults to true for external-scheme links (they
 *  hand off to a desktop app) and false for in-app links. */
function isValidActionHref(type: PortalActionType, href: string): boolean {
  if (type === 'in_app') {
    // Root-relative same-origin path only; reject `//host` and any scheme.
    return href.startsWith('/') && !href.startsWith('//');
  }
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(href);
  return !!m && (KNOWN_ACTION_SCHEMES as readonly string[]).includes(m[1].toLowerCase());
}

function parsePortalAction(entry: unknown): PortalAction | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (e.type !== 'in_app' && e.type !== 'external_scheme') return null;
  if (typeof e.label !== 'string' || !e.label.trim()) return null;
  if (typeof e.href !== 'string' || !e.href.trim()) return null;
  const type = e.type;
  const href = e.href.trim();
  if (!isValidActionHref(type, href)) return null;
  const out: PortalAction = { type, label: e.label.trim(), href };
  if (typeof e.icon === 'string' && PORTAL_ICON_SET.has(e.icon)) {
    out.icon = e.icon as PortalIconName;
  }
  // Explicit desktop_only wins; otherwise default by link type.
  out.desktop_only =
    typeof e.desktop_only === 'boolean' ? e.desktop_only : type === 'external_scheme';
  return out;
}

/** Parse the optional secondary `actions[]` list. */
function parsePortalActions(input: unknown): PortalAction[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(parsePortalAction)
    .filter((a): a is PortalAction => a !== null);
}

/** Parse a `setup_assets[]` list down to whitelisted-kind entries.
 *  Shared by the top-level frontmatter and the per-card `cards[]`
 *  path. Unknown/non-string kinds drop silently. */
function parseSetupAssets(input: unknown): SetupAsset[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry: unknown): SetupAsset | null => {
      if (!entry || typeof entry !== 'object') return null;
      const e = entry as Record<string, unknown>;
      if (typeof e.kind !== 'string' || !KNOWN_ASSET_KINDS.has(e.kind as SetupAssetKind)) return null;
      const out: SetupAsset = { kind: e.kind as SetupAssetKind };
      if (typeof e.label === 'string' && e.label.trim()) out.label = e.label.trim();
      if (typeof e.description === 'string' && e.description.trim()) out.description = e.description.trim();
      return out;
    })
    .filter((a): a is SetupAsset => a !== null);
}

/** Parse one `cards[]` entry (per-subdomain card). Returns null when
 *  the entry is malformed or lacks a valid `*_SUBDOMAIN` var. */
function applyCardLists(card: UserGuideCard, e: Record<string, unknown>): void {
  const apps = parseRecommendedApps(e.recommended_apps);
  if (apps.length > 0) card.recommended_apps = apps;
  const assets = parseSetupAssets(e.setup_assets);
  if (assets.length > 0) card.setup_assets = assets;
  const pairing = parseManualPairing(e.manual_pairing);
  if (pairing.length > 0) card.manual_pairing = pairing;
  const primaryAction = parsePortalAction(e.primary_action);
  if (primaryAction) card.primary_action = primaryAction;
  const actions = parsePortalActions(e.actions);
  if (actions.length > 0) card.actions = actions;
}

function parseCardEntry(entry: unknown): UserGuideCard | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.subdomain_var !== 'string' || !/^[A-Z][A-Z0-9_]*_SUBDOMAIN$/.test(e.subdomain_var)) {
    return null;
  }
  const card: UserGuideCard = { subdomain_var: e.subdomain_var };
  if (typeof e.label === 'string' && e.label.trim()) card.label = e.label.trim();
  if (typeof e.icon === 'string') card.icon = e.icon;
  if (typeof e.lucide_icon === 'string' && PORTAL_ICON_SET.has(e.lucide_icon)) {
    card.lucide_icon = e.lucide_icon as PortalIconName;
  }
  if (typeof e.tagline === 'string') card.tagline = e.tagline;
  applyCardLists(card, e);
  return card;
}

/** Extract frontmatter fields from parsed YAML data. */
function parseUserGuideSection(data: Record<string, unknown>): UserGuideFrontmatter {
  const fm: UserGuideFrontmatter = {};
  if (typeof data.icon === 'string') fm.icon = data.icon;
  if (typeof data.lucide_icon === 'string' && PORTAL_ICON_SET.has(data.lucide_icon)) {
    fm.lucide_icon = data.lucide_icon as PortalIconName;
  }
  if (typeof data.tagline === 'string') fm.tagline = data.tagline;

  // Prefer `recommended_apps` when present; fall back to lifting
  // legacy `mobile_apps` so older guides keep working.
  if (Array.isArray(data.recommended_apps)) {
    const apps = parseRecommendedApps(data.recommended_apps);
    if (apps.length > 0) fm.recommended_apps = apps;
  } else if (Array.isArray(data.mobile_apps)) {
    const lifted = liftMobileApps(data.mobile_apps);
    if (lifted.length > 0) fm.recommended_apps = lifted;
  }

  if (Array.isArray(data.cards)) {
    const cards = data.cards
      .map(parseCardEntry)
      .filter((c): c is UserGuideCard => c !== null);
    if (cards.length > 0) fm.cards = cards;
  }

  const assets = parseSetupAssets(data.setup_assets);
  if (assets.length > 0) fm.setup_assets = assets;

  const pairing = parseManualPairing(data.manual_pairing);
  if (pairing.length > 0) fm.manual_pairing = pairing;

  const primaryAction = parsePortalAction(data.primary_action);
  if (primaryAction) fm.primary_action = primaryAction;
  const actions = parsePortalActions(data.actions);
  if (actions.length > 0) fm.actions = actions;

  return fm;
}

export function parseUserGuide(raw: string | null, templateName: string): ParsedUserGuide | null {
  if (!raw || !raw.trim()) return null;
  try {
    const { data, content } = matter(raw);
    const frontmatter = parseUserGuideSection(data as Record<string, unknown>);
    return { frontmatter, body: content };
  } catch (e) {
    logger.warn('portal:userGuide', `Failed to parse user-guide for ${templateName}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
