/**
 * `/settings` crash guard (#2555).
 *
 * Symptom: opening `/settings` in the browser killed the page with React's
 * "Rendered more hooks than during the previous render." Reproduced against the
 * mock dev server on `8452c94a` AND on `7ab4ad49` (the commit before batch
 * `2026-08-13b`) — pre-existing, not a regression of that batch. It hit every
 * route under `settings/` whose page was a redirect-only server component
 * (`/settings`, `/settings/services`, `/settings/services/[name]`), and no other
 * redirect route in the app.
 *
 * Cause — two halves, one per test below:
 *
 *  1. `SettingsShell` (settings/layout.tsx) hid the whole page behind
 *     `if (loading) return <…>`, so `{children}` — the routed page segment —
 *     was absent from the tree on the first render and added once the config
 *     fetch resolved. A page that only calls `redirect()` therefore delivered
 *     its redirect LATE, after the client router had settled, and Next resolved
 *     it as a hard (MPA) navigation. Next's own <Router> bails out of render in
 *     that state (`throw unresolvedThenable`) BEFORE several of its later hooks,
 *     so the following render ran more hooks and React tore the page down.
 *
 *  2. Those three routes were redirect-only `page.tsx` server components in the
 *     first place. They are `next.config.ts` redirects now — a real 307 answered
 *     before any render, so the crash path cannot be re-entered at all.
 *
 * The existing suite ran green through all of this (29 files / 214 tests): a
 * hook-count mismatch only exists in a real reconciliation, and nothing pinned
 * either half. These tests do.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

const settings = { saving: false, loading: true };

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/network-domain',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/settings/_lib/SettingsContext', () => ({
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSettings: () => settings,
}));
vi.mock('@/app/(dashboard)/settings/_lib/SettingsSearch', () => ({ default: () => <div /> }));
vi.mock('@/components/PageHeader', () => ({
  default: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <div>{title}{children}</div>
  ),
}));

import SettingsLayout from '@/app/(dashboard)/settings/layout';

const SETTINGS_DIR = path.resolve(
  __dirname,
  '../../packages/frontend/src/app/(dashboard)/settings',
);

function settingsPageSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'page.tsx') out.push({ file: full, source: readFileSync(full, 'utf8') });
    }
  };
  walk(SETTINGS_DIR);
  return out;
}

describe('settings shell keeps the routed page mounted (#2555)', () => {
  it('renders the page while the config is still loading, and never remounts it', () => {
    settings.loading = true;

    const { rerender } = render(
      <SettingsLayout>
        <p>page content</p>
      </SettingsLayout>,
    );

    // The loading line replaces the CHROME…
    expect(screen.getByText('Loading settings...')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Settings groups' })).toBeNull();

    // …but the page itself is already in the tree, only hidden. This is the
    // whole fix: an absent page segment delivers a `redirect()` too late for
    // the client router, which is what crashed `/settings`.
    const page = screen.getByText('page content');
    const slot = page.parentElement!;
    expect(slot.getAttribute('data-testid')).toBe('settings-page-slot');
    expect(slot.className).toContain('hidden');

    settings.loading = false;
    rerender(
      <SettingsLayout>
        <p>page content</p>
      </SettingsLayout>,
    );

    // Same DOM node — React reused it instead of unmounting and remounting.
    expect(screen.getByText('page content')).toBe(page);
    expect(screen.queryByText('Loading settings...')).toBeNull();
    expect(page.parentElement!.className).not.toContain('hidden');
    // Chrome is back once the config is in.
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('no page under settings/ is a bare redirect() — those are next.config redirects', () => {
    for (const { file, source } of settingsPageSources()) {
      expect(
        /\bredirect\s*\(/.test(source),
        `${file} redirects from a page render. Put it in packages/frontend/next.config.ts ` +
          `redirects() instead — a page-level redirect() under settings/layout.tsx is resolved ` +
          `inside React and crashed /settings with "Rendered more hooks than during the ` +
          `previous render" (#2555).`,
      ).toBe(false);
    }
  });
});

describe('settings bookmark redirects live in next.config (#2555)', () => {
  it('forwards /settings to the default group and the retired services routes', async () => {
    const [{ default: nextConfig }, { DEFAULT_GROUP }] = await Promise.all([
      import('../../packages/frontend/next.config'),
      import('@/app/(dashboard)/settings/_lib/ia'),
    ]);

    const rules = await nextConfig.redirects!();
    const find = (source: string) => rules.find(r => r.source === source);

    // The destination is spelled out literally in next.config.ts (Next evaluates
    // redirects() in its own scope and ia.ts pulls in lucide-react), so pin it
    // against the IA here instead.
    expect(find('/settings')?.destination).toBe(`/settings/${DEFAULT_GROUP.id}`);
    expect(find('/settings/services')?.destination).toBe('/services');
    expect(find('/settings/services/:name')?.destination).toBe('/services/:name');
  });
});
