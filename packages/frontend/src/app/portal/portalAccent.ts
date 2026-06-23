/**
 * Per-service accent identity + light section grouping for the family
 * portal (#2126). Keyed off the card's stable `lucideIcon` (the
 * frontmatter icon a template ships) with a label fallback, so the
 * launcher-style tint and the section a card files under travel with the
 * service rather than a hand-maintained id list.
 *
 * The accent is purely the icon-chip tint — a named class from the
 * `.svc-chip-*` utilities defined in globals.css (an intentional,
 * dark-mode-correct per-service accent map, distinct from the semantic
 * token chrome). No raw colour literals leak into the component; this
 * module only ever returns a literal class name Tailwind can see.
 */
import type { PortalCard } from '@/lib/portal/services';
import type { PortalIconName } from '@/lib/portal/userGuide';

/** The named accent hues (→ `.svc-chip-<hue>` in globals.css). */
export type ServiceAccent =
  | 'amber' | 'blue' | 'teal' | 'orange' | 'violet'
  | 'rose' | 'red' | 'indigo' | 'green' | 'neutral';

/** Icon-chip utility class per accent. `neutral` is the default token
 *  tint for any service without a mapped identity (keeps the grid calm
 *  rather than guessing a hue). */
export const ACCENT_CHIP_CLASS: Record<ServiceAccent, string> = {
  amber: 'svc-chip-amber',
  blue: 'svc-chip-blue',
  teal: 'svc-chip-teal',
  orange: 'svc-chip-orange',
  violet: 'svc-chip-violet',
  rose: 'svc-chip-rose',
  red: 'svc-chip-red',
  indigo: 'svc-chip-indigo',
  green: 'svc-chip-green',
  neutral: 'bg-accent/15 text-accent',
};

/** Map a card's lucide icon → its service accent. Photos=teal,
 *  Passwords=blue, Files=orange, Audiobooks=violet, Music=rose,
 *  Calendar=red, Smart Home=amber, Claude Dev=indigo, Syncthing=green. */
const ICON_ACCENT: Partial<Record<PortalIconName, ServiceAccent>> = {
  'camera': 'teal', 'image': 'teal', 'images': 'teal',          // Photos
  'shield': 'blue', 'lock': 'blue', 'key-round': 'blue',        // Passwords
  'folder-open': 'orange', 'folder': 'orange', 'files': 'orange', // Files
  'book-open': 'violet',                                         // Audiobooks
  'music': 'rose', 'headphones': 'rose',                        // Music
  'calendar': 'red', 'calendar-days': 'red',                    // Calendar
  'lightbulb': 'amber', 'house': 'amber',                       // Smart Home
  'bot': 'indigo', 'package': 'indigo',                         // Claude Dev
  'refresh-cw': 'green',                                        // Syncthing
};

/** Label-keyword fallback when the icon is missing/unmapped — keeps the
 *  accent stable even for a guide that ships an emoji or a custom icon. */
function accentFromLabel(label: string): ServiceAccent {
  const l = label.toLowerCase();
  if (/photo|immich/.test(l)) return 'teal';
  if (/password|vault/.test(l)) return 'blue';
  if (/file|browser/.test(l)) return 'orange';
  if (/audiobook|book|podcast/.test(l)) return 'violet';
  if (/music|jellyfin|stream/.test(l)) return 'rose';
  if (/calendar|contact/.test(l)) return 'red';
  if (/smart home|home assistant|light|automation/.test(l)) return 'amber';
  if (/claude|dev|code|terminal/.test(l)) return 'indigo';
  if (/sync/.test(l)) return 'green';
  return 'neutral';
}

/** Resolve a card's per-service accent (#2126). */
export function serviceAccent(card: PortalCard): ServiceAccent {
  if (card.lucideIcon && ICON_ACCENT[card.lucideIcon]) {
    return ICON_ACCENT[card.lucideIcon] as ServiceAccent;
  }
  return accentFromLabel(card.label);
}

/** The light grouping sections, in display order (#2126). */
export type PortalSection = 'Media' | 'Productivity' | 'Files & Sync' | 'Smart Home & Dev' | 'More';

export const SECTION_ORDER: PortalSection[] = [
  'Media', 'Productivity', 'Files & Sync', 'Smart Home & Dev', 'More',
];

/** Per-accent → section. Drives the small section headers so cards group
 *  by what they're FOR, not by template internals. `More` collects
 *  anything unmapped so no card ever vanishes. */
const ACCENT_SECTION: Record<ServiceAccent, PortalSection> = {
  teal: 'Media', violet: 'Media', rose: 'Media',              // Photos, Audiobooks, Music
  blue: 'Productivity', red: 'Productivity',                  // Passwords, Calendar
  orange: 'Files & Sync', green: 'Files & Sync',              // Files, Syncthing
  amber: 'Smart Home & Dev', indigo: 'Smart Home & Dev',      // Smart Home, Claude Dev
  neutral: 'More',
};

/** Section a card files under (#2126), derived from its accent. */
export function portalSection(card: PortalCard): PortalSection {
  return ACCENT_SECTION[serviceAccent(card)];
}

/** Group cards into the ordered sections, dropping empty ones and keeping
 *  each card's relative order within its section (stable). */
export function groupCardsBySection(
  cards: PortalCard[],
): { section: PortalSection; cards: PortalCard[] }[] {
  const buckets = new Map<PortalSection, PortalCard[]>();
  for (const card of cards) {
    const section = portalSection(card);
    const list = buckets.get(section) ?? [];
    list.push(card);
    buckets.set(section, list);
  }
  return SECTION_ORDER
    .filter(s => buckets.has(s))
    .map(section => ({ section, cards: buckets.get(section)! }));
}
