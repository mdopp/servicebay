/**
 * Tab-strip guard (#2549, child of the #2546 shell epic).
 *
 * Symptom the operator reported: Settings showed icon + label with a blue
 * underline, Status showed plain text in a boxed active tab — two visual
 * languages for the same control. The root cause was that `components/ui/` had
 * no `Tabs` at all, so all six strips were hand-built (Settings, Status,
 * Operate, ServiceMonitor, ServiceForm, the install wizard's Configure strip).
 *
 * The fix is structural, following the #2071/#2075 DataTable precedent: ONE
 * `<Tabs>` primitive, every strip rendered from it. These tests make it hard to
 * quietly grow a seventh — one asserts the known call sites really render from
 * the primitive, the other bans the hand-rolled indicator idiom outright.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/access',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/settings/_lib/SettingsContext', () => ({
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSettings: () => ({ saving: false, loading: false }),
}));
vi.mock('@/app/(dashboard)/settings/_lib/SettingsSearch', () => ({ default: () => <div /> }));
vi.mock('@/components/PageHeader', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const FRONTEND_SRC = path.resolve(__dirname, '../../packages/frontend/src');

function frontendSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) continue;
      // components/ui/ IS the primitive — it owns the class chain by definition.
      if (full.includes(`${path.sep}components${path.sep}ui${path.sep}`)) continue;
      out.push({ file: full, source: readFileSync(full, 'utf8') });
    }
  };
  walk(FRONTEND_SRC);
  return out;
}

/** The six strips #2549 consolidated, relative to packages/frontend/src. */
const MIGRATED = [
  'app/(dashboard)/settings/layout.tsx',
  'dashboards/HealthDashboard.tsx',
  'app/(dashboard)/services/[name]/_lib/OperatePage.tsx',
  'components/ServiceMonitor.tsx',
  'components/ServiceForm.tsx',
  'components/wizard/steps/StacksStep.tsx',
];

describe('tab strips (#2549)', () => {
  it('every known strip renders from the shared <Tabs> primitive', () => {
    for (const rel of MIGRATED) {
      const source = readFileSync(path.join(FRONTEND_SRC, rel), 'utf8');
      expect(source, `${rel} must render the shared <Tabs>`).toContain('<Tabs');
      expect(source, `${rel} must import Tabs from components/ui`).toMatch(
        /import \{[^}]*\bTabs\b[^}]*\} from '@\/components\/ui(?:\/Tabs)?'|from '\.\/ui'/,
      );
    }
  });

  it('no hand-rolled active-tab indicator survives anywhere in the frontend', () => {
    // The tell every one of the six shared: a 2px edge (`border-b-2` underline
    // or `border-t-2` folder cap) toggled against `border-transparent`. A
    // spinner's `border-b-2` alone is not a tab strip, which is why both halves
    // must be present before a file is flagged.
    for (const { file, source } of frontendSources()) {
      const indicator = /border-(?:b|t)-2/.test(source) && /border-transparent/.test(source);
      expect(
        indicator,
        `${file} looks like a hand-rolled tab strip — render <Tabs> from @/components/ui instead (#2549)`,
      ).toBe(false);
    }
  });

  // Acceptance #3, encoded rather than eyeballed: the two surfaces the operator
  // compared must render the SAME active-tab treatment. This renders the real
  // Settings layout and asserts its active tab against the primitive's chain —
  // pre-fix it was `border-status-info text-status-info` with `py-3`, while
  // Status was `border-accent text-accent` with `py-2`.
  it('Settings renders the same active-tab language as Status', async () => {
    const { default: SettingsLayout } = await import('@/app/(dashboard)/settings/layout');
    const { TAB_CLASS, TAB_ACTIVE_CLASS, Tabs } = await import('@/components/ui');

    render(<SettingsLayout><p>body</p></SettingsLayout>);
    const settingsActive = screen.getByRole('link', { name: /Access/ });
    expect(settingsActive.getAttribute('aria-current')).toBe('page');
    cleanup();

    // Status' strip, rendered from the same primitive with the same inputs.
    render(<Tabs label="Status views" value="checks" onChange={() => {}} items={[{ id: 'checks', label: 'Checks' }]} />);
    const statusActive = screen.getByRole('tab', { name: 'Checks' });

    expect(settingsActive.className).toBe(statusActive.className);
    expect(settingsActive.className).toContain(TAB_ACTIVE_CLASS);
    expect(settingsActive.className).toContain(TAB_CLASS.split(' ')[0]);
    // The old Settings-only token is gone.
    expect(settingsActive.className).not.toContain('status-info');
  });

  it('no strip re-declares the tab class chain', () => {
    for (const { file, source } of frontendSources()) {
      expect(source, `${file} must not paste the tab classes — render <Tabs>`).not.toContain(
        'border-b-2 whitespace-nowrap',
      );
    }
  });
});
