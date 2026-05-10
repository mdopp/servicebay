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
 *    - `audiobookshelf_deeplink` — \`abs://\` URL the official
 *      Audiobookshelf app picks up to pre-configure the server.
 *
 *  Future kinds (deferred):
 *    - `syncthing_qr` — needs Syncthing REST API to read the
 *      server's device ID at request time.
 */
export type SetupAssetKind = 'ios_calendar_profile' | 'audiobookshelf_deeplink';

const KNOWN_ASSET_KINDS: ReadonlySet<SetupAssetKind> = new Set([
  'ios_calendar_profile',
  'audiobookshelf_deeplink',
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

export interface UserGuideFrontmatter {
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
      if (!/^https?:\/\//i.test(e.url)) return null;
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

export function parseUserGuide(raw: string | null, templateName: string): ParsedUserGuide | null {
  if (!raw || !raw.trim()) return null;
  try {
    const { data, content } = matter(raw);
    const fm: UserGuideFrontmatter = {};
    if (typeof data.icon === 'string') fm.icon = data.icon;
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

    if (Array.isArray(data.setup_assets)) {
      const assets = data.setup_assets
        .map((entry: unknown): SetupAsset | null => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          if (typeof e.kind !== 'string') return null;
          if (!KNOWN_ASSET_KINDS.has(e.kind as SetupAssetKind)) return null;
          const out: SetupAsset = { kind: e.kind as SetupAssetKind };
          if (typeof e.label === 'string' && e.label.trim()) out.label = e.label.trim();
          if (typeof e.description === 'string' && e.description.trim()) out.description = e.description.trim();
          return out;
        })
        .filter((e): e is SetupAsset => e !== null);
      if (assets.length > 0) fm.setup_assets = assets;
    }

    return { frontmatter: fm, body: content };
  } catch (e) {
    logger.warn('portal:userGuide', `Failed to parse user-guide for ${templateName}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
