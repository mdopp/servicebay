/**
 * Search-field guard (#2550, child of the #2546 shell epic).
 *
 * Symptom the operator reported: search fields everywhere, differently styled,
 * differently labelled, several on one page, with no visible division of
 * labour. Root cause — the same shape as #2549's tab strips — was that
 * `components/ui/` had no `Search` at all, so all seven were hand-built.
 *
 * OWNER DECISION (2026-08-13): keep ONE search per tab; do not merge them into
 * a page-level field. Make them look identical, sit in the same place, and say
 * what they search.
 *
 * These tests encode that decision so it cannot quietly rot:
 *   - every known call site renders from the shared <Search>,
 *   - no eighth hand-rolled search grows back,
 *   - and the Status page — the surface the decision was about — really does
 *     show exactly one, scope-named search per tab.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
  ToastType: {},
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/app/actions/nodes', () => ({ getNodes: () => Promise.resolve([]) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/status',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/HealthChecks', () => ({
  __esModule: true,
  default: () => <div data-testid="health-checks" />,
}));
vi.mock('@/components/LogViewer', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/components/DiagnoseProbeList', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/dashboards/SystemInfoDashboard', () => ({ SystemInfoContent: () => <div /> }));
// The Containers TAB is the real ContainersDashboard — that is the whole point
// of the Status-page assertions below, so it is deliberately NOT mocked. Its
// own data hooks are.
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({
    data: { nodes: { Local: { services: [], containers: [], unmanagedBundles: [] } } },
    isConnected: true,
    isNodeSynced: () => true,
  }),
}));
vi.mock('@/hooks/useContainerActions', () => ({
  useContainerActions: () => ({ openActions: vi.fn(), closeActions: vi.fn(), overlay: null, isOpen: false }),
}));
vi.mock('@/hooks/useEscapeKey', () => ({ useEscapeKey: () => {} }));

import HealthDashboard from '@/dashboards/HealthDashboard';

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

/** The hand-rolled search inputs #2550 consolidated, relative to frontend/src. */
const MIGRATED = [
  'app/(dashboard)/settings/_lib/SettingsSearch.tsx',
  'app/(dashboard)/settings/_lib/sections/KnowledgeSection.tsx',
  'dashboards/HealthDashboard.tsx',
  'dashboards/ContainersDashboard.tsx',
  'dashboards/NetworkDashboard.tsx',
  'dashboards/ServicesDashboard.tsx',
];

describe('search fields (#2550) — the primitive', () => {
  it('every known call site renders from the shared <Search> primitive', () => {
    for (const rel of MIGRATED) {
      const source = readFileSync(path.join(FRONTEND_SRC, rel), 'utf8');
      expect(source, `${rel} must render the shared <Search>`).toContain('<Search');
      expect(source, `${rel} must import Search from components/ui`).toMatch(
        /import \{[^}]*\bSearch\b[^}]*\} from '@\/components\/ui(?:\/Search)?'/,
      );
      expect(source, `${rel} must not import the lucide Search icon for a field`).not.toMatch(
        /import \{[^}]*\bSearch\b[^}]*\} from 'lucide-react'/,
      );
    }
  });

  it('no hand-rolled search input survives anywhere in the frontend', () => {
    // The tell every one of the seven shared: an input whose placeholder is a
    // "Search…" phrase. The primitive derives its placeholder from `label`, so
    // a literal search placeholder on an <input>/<Input> means a new hand-roll.
    for (const { file, source } of frontendSources()) {
      // <Select>'s in-popover option filter is a listbox filter, not a page
      // search — different control, different position, out of #2550's scope.
      if (file.endsWith(`${path.sep}components${path.sep}Select.tsx`)) continue;
      // <Autocomplete> is a combobox; HealthDashboard's "Search system
      // services…" is one of its placeholders inside the add-check MODAL, not
      // a page search field. See the Status-page test below.
      const handRolled = /<[Ii]nput\b[^>]*placeholder=["'][^"']*[Ss]earch/.test(source);
      expect(
        handRolled,
        `${file} looks like a hand-rolled search input — render <Search> from @/components/ui instead (#2550)`,
      ).toBe(false);
    }
  });

  it('no call site re-declares the search icon/gutter idiom', () => {
    for (const { file, source } of frontendSources()) {
      expect(source, `${file} must not paste the search chrome — render <Search>`).not.toContain(
        'pl-9 pr-4 py-2 rounded',
      );
    }
  });
});

describe('search fields (#2550) — the Status page decision', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))));
  });

  const searchboxNames = () =>
    screen.queryAllByRole('searchbox').map(el => el.getAttribute('aria-label'));

  it('the Checks tab shows exactly ONE search, and it says it searches checks', async () => {
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());
    expect(searchboxNames()).toEqual(['Search checks']);
  });

  it('the Logs tab keeps its OWN scope — not merged into a page-level field', async () => {
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    await waitFor(() => expect(searchboxNames()).toEqual(['Search logs']));
  });

  it('the Containers tab shows ONE search — the inert page-level field is gone', async () => {
    // The bug behind the operator's "three searches": the page-level field
    // rendered on the Containers tab too, directly above the Containers tab's
    // own field, while `searchQuery` was only ever read by Checks and Logs. It
    // filtered nothing.
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: 'Containers' }));
    await waitFor(() => expect(searchboxNames()).toEqual(['Search containers']));
  });

  it('the System tab shows no search at all', async () => {
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: 'System' }));
    await waitFor(() => expect(searchboxNames()).toEqual([]));
  });

  it('every tab’s search wears the identical chrome and sits in the same slot', async () => {
    const { SEARCH_INPUT_CLASS, SEARCH_SLOT_CLASS } = await import('@/components/ui');
    const chrome: string[] = [];
    const slots: string[] = [];

    for (const tab of ['Checks', 'Logs', 'Containers']) {
      render(<HealthDashboard />);
      await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());
      if (tab !== 'Checks') {
        fireEvent.click(screen.getByRole('tab', { name: tab }));
        await waitFor(() => expect(screen.queryByTestId('health-checks')).toBeNull());
      }
      const input = screen.getByRole('searchbox');
      chrome.push(input.className);
      slots.push(input.parentElement?.parentElement?.className ?? '');
      cleanup();
    }

    expect(new Set(chrome).size, 'one look across the tabs').toBe(1);
    expect(chrome[0]).toBe(SEARCH_INPUT_CLASS);
    expect(new Set(slots).size, 'one position across the tabs').toBe(1);
    expect(slots[0]).toContain(SEARCH_SLOT_CLASS.split(' ')[0]);
    expect(slots[0]).toContain('max-w-md');
  });

  it('“Search system services…” is a modal combobox, not a page search field', async () => {
    // Stated finding for #2550: the issue listed this as the Status page's
    // third search field. It is the systemd target picker inside the add-check
    // modal — a different control, reached only after opening the editor.
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());
    expect(screen.queryByPlaceholderText(/system services/i)).toBeNull();
  });
});
