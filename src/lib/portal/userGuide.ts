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

export interface MobileAppLink {
  name: string;
  url: string;
}

export interface UserGuideFrontmatter {
  icon?: string;
  tagline?: string;
  mobile_apps?: MobileAppLink[];
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
export function parseUserGuide(raw: string | null, templateName: string): ParsedUserGuide | null {
  if (!raw || !raw.trim()) return null;
  try {
    const { data, content } = matter(raw);
    const fm: UserGuideFrontmatter = {};
    if (typeof data.icon === 'string') fm.icon = data.icon;
    if (typeof data.tagline === 'string') fm.tagline = data.tagline;
    if (Array.isArray(data.mobile_apps)) {
      fm.mobile_apps = data.mobile_apps
        .map((entry: unknown): MobileAppLink | null => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          if (typeof e.name !== 'string' || typeof e.url !== 'string') return null;
          // Reject anything that isn't an http(s) URL — frontmatter is
          // template-author input that ends up rendered as a link
          // attribute. Reject `javascript:` etc.
          if (!/^https?:\/\//i.test(e.url)) return null;
          return { name: e.name, url: e.url };
        })
        .filter((e): e is MobileAppLink => e !== null);
    }
    return { frontmatter: fm, body: content };
  } catch (e) {
    logger.warn('portal:userGuide', `Failed to parse user-guide for ${templateName}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
