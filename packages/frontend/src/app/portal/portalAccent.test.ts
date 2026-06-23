/**
 * Unit tests for the per-service accent + section grouping map (#2126).
 * Pure functions — no DOM — so the accent/section rules are pinned in
 * isolation from the component layout.
 */
import { describe, it, expect } from 'vitest';
import type { PortalCard } from '@/lib/portal/services';
import type { PortalIconName } from '@/lib/portal/userGuide';
import {
  serviceAccent,
  portalSection,
  groupCardsBySection,
  ACCENT_CHIP_CLASS,
} from './portalAccent';

const card = (over: Partial<PortalCard>): PortalCard => ({
  id: 'x:1',
  name: 'x',
  subdomainVar: 'X_SUBDOMAIN',
  label: 'X',
  category: 'System',
  lucideIcon: null,
  icon: '',
  tagline: '',
  url: '',
  status: 'ok',
  primaryAction: null,
  secondaryActions: [],
  body: '',
  recommendedApps: [],
  setupAssets: [],
  manualPairing: [],
  sizeTier: 'compact',
  ...over,
});

describe('serviceAccent (#2126)', () => {
  const iconCases: [PortalIconName, string][] = [
    ['camera', 'teal'],
    ['shield', 'blue'],
    ['folder-open', 'orange'],
    ['book-open', 'violet'],
    ['music', 'rose'],
    ['calendar-days', 'red'],
    ['lightbulb', 'amber'],
    ['bot', 'indigo'],
    ['refresh-cw', 'green'],
  ];

  for (const [icon, accent] of iconCases) {
    it(`maps lucide ${icon} → ${accent}`, () => {
      expect(serviceAccent(card({ lucideIcon: icon }))).toBe(accent);
    });
  }

  it('falls back to a label keyword when the icon is missing', () => {
    expect(serviceAccent(card({ lucideIcon: null, label: 'Passwords' }))).toBe('blue');
    expect(serviceAccent(card({ lucideIcon: null, label: 'Music' }))).toBe('rose');
  });

  it('returns neutral for an unrecognized service', () => {
    expect(serviceAccent(card({ lucideIcon: null, label: 'Mystery Box' }))).toBe('neutral');
  });

  it('every accent has a chip utility class', () => {
    for (const accent of Object.values(ACCENT_CHIP_CLASS)) {
      expect(accent.length).toBeGreaterThan(0);
    }
  });
});

describe('portalSection (#2126)', () => {
  it('files services into the right section', () => {
    expect(portalSection(card({ lucideIcon: 'camera' }))).toBe('Media');
    expect(portalSection(card({ lucideIcon: 'music' }))).toBe('Media');
    expect(portalSection(card({ lucideIcon: 'book-open' }))).toBe('Media');
    expect(portalSection(card({ lucideIcon: 'shield' }))).toBe('Productivity');
    expect(portalSection(card({ lucideIcon: 'calendar-days' }))).toBe('Productivity');
    expect(portalSection(card({ lucideIcon: 'folder-open' }))).toBe('Files & Sync');
    expect(portalSection(card({ lucideIcon: 'refresh-cw' }))).toBe('Files & Sync');
    expect(portalSection(card({ lucideIcon: 'lightbulb' }))).toBe('Smart Home & Dev');
    expect(portalSection(card({ lucideIcon: 'bot' }))).toBe('Smart Home & Dev');
  });

  it('routes an unmapped card to More', () => {
    expect(portalSection(card({ lucideIcon: null, label: 'Mystery' }))).toBe('More');
  });
});

describe('groupCardsBySection (#2126)', () => {
  it('orders sections Media → Productivity → Files & Sync → Smart Home & Dev and drops empties', () => {
    const cards = [
      card({ id: 'dev:1', lucideIcon: 'bot' }),
      card({ id: 'pw:1', lucideIcon: 'shield' }),
      card({ id: 'photo:1', lucideIcon: 'camera' }),
      card({ id: 'files:1', lucideIcon: 'folder-open' }),
    ];
    const groups = groupCardsBySection(cards);
    expect(groups.map(g => g.section)).toEqual([
      'Media', 'Productivity', 'Files & Sync', 'Smart Home & Dev',
    ]);
  });

  it('keeps each card relative order within its section (stable)', () => {
    const cards = [
      card({ id: 'music:1', lucideIcon: 'music', label: 'Music' }),
      card({ id: 'photo:1', lucideIcon: 'camera', label: 'Photos' }),
      card({ id: 'book:1', lucideIcon: 'book-open', label: 'Audiobooks' }),
    ];
    const media = groupCardsBySection(cards).find(g => g.section === 'Media')!;
    expect(media.cards.map(c => c.label)).toEqual(['Music', 'Photos', 'Audiobooks']);
  });

  it('every input card lands in exactly one section', () => {
    const cards = [
      card({ id: 'a:1', lucideIcon: 'camera' }),
      card({ id: 'b:1', lucideIcon: null, label: 'Mystery' }),
    ];
    const total = groupCardsBySection(cards).reduce((n, g) => n + g.cards.length, 0);
    expect(total).toBe(cards.length);
  });
});
