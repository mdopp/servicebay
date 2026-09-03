/**
 * HealthChecks — design-system migration coverage (lint-ratchet sweep).
 *
 * The panel's chrome moved off raw <button> onto the shared <Button>
 * primitive from @/components/ui. The component had no dedicated test file
 * (only `healthChecksRows.test.ts`, which covers the pure row helpers), and
 * the one place it renders — HealthDashboard — mocks it away, so every line
 * of the render tree was unmeasured. These tests exercise the rendered
 * output directly:
 *   - the four status counters render as real <button> primitives on
 *     status-token classes, and toggle the filter on/off,
 *   - both empty states (no checks / no matches) and their recovery actions,
 *   - the row body: status tint, type/node badges, "last checked" label,
 *     the latency sparkline, and the per-row action buttons,
 *   - the diagnose-row branch (self-repair instead of edit/delete).
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { Check } from '@servicebay/api-client';

import HealthChecks, { type StatusFilter } from './HealthChecks';

const baseCheck = {
  interval: 60,
  enabled: true,
  created_at: '2026-01-01T00:00:00.000Z',
  lastResult: null,
  history: [],
} satisfies Partial<Check>;

/** `diagnose` is loosened to just the status the row renderer reads — the real
 *  payload carries a probe's whole self-repair manifest, which is irrelevant
 *  here and would bloat every fixture. */
type CheckOverrides = Omit<Partial<Check>, 'diagnose'> & {
  id: string;
  name: string;
  diagnose?: { status?: string };
};

function makeCheck(over: CheckOverrides): Check {
  return {
    type: 'http',
    target: 'https://example.com',
    status: 'ok',
    lastRun: null,
    ...baseCheck,
    ...over,
  } as unknown as Check;
}

// The V4 agent's `listContainers` shape: lowercase keys and BARE names (no
// leading `/` — that is a docker-ism the old fixture invented, #2782).
const containers = [
  { id: 'abc', names: ['media-jellyfin'], image: 'jellyfin:latest' },
];

type Handlers = {
  setSearchQuery: Mock<(query: string) => void>;
  setStatusFilter: Mock<(filter: StatusFilter) => void>;
  handleRun: Mock<(id: string) => void>;
  handleOpenModal: Mock<(check?: Check) => void>;
  handleOpenDeleteModal: Mock<(id: string) => void>;
  handleViewHistory: Mock<(check: Check) => void>;
  handleOpenRepair: Mock<(check: Check) => void>;
};

function renderPanel(
  opts: { checks?: Check[]; searchQuery?: string; statusFilter?: StatusFilter } = {},
): Handlers {
  const handlers: Handlers = {
    setSearchQuery: vi.fn<(query: string) => void>(),
    setStatusFilter: vi.fn<(filter: StatusFilter) => void>(),
    handleRun: vi.fn<(id: string) => void>(),
    handleOpenModal: vi.fn<(check?: Check) => void>(),
    handleOpenDeleteModal: vi.fn<(id: string) => void>(),
    handleViewHistory: vi.fn<(check: Check) => void>(),
    handleOpenRepair: vi.fn<(check: Check) => void>(),
  };
  render(
    <HealthChecks
      checks={opts.checks ?? []}
      containers={containers}
      searchQuery={opts.searchQuery ?? ''}
      statusFilter={opts.statusFilter ?? 'all'}
      {...handlers}
    />,
  );
  return handlers;
}

/** The counter tile whose label is `label` (the <Button> wrapping it). */
function counterTile(label: string): HTMLElement {
  const el = screen.getByText(label).closest('button');
  if (!el) throw new Error(`no counter button for "${label}"`);
  return el;
}

describe('HealthChecks — status counters', () => {
  const checks = [
    makeCheck({ id: 'a', name: 'ok-one', status: 'ok' }),
    makeCheck({ id: 'b', name: 'fail-one', status: 'fail' }),
    makeCheck({ id: 'c', name: 'unknown-one', status: 'unknown' }),
    makeCheck({
      id: 'd',
      name: 'diagnose-warn',
      status: 'ok',
      diagnose: { status: 'warn' },
    }),
  ];

  it('renders the four counters as Button primitives with their tallies', () => {
    renderPanel({ checks });

    for (const [label, count] of [
      ['Healthy', '1'],
      ['Warning', '1'],
      ['Failing', '1'],
      ['Unknown', '1'],
    ] as const) {
      const tile = counterTile(label);
      // The <Button> primitive renders a real <button type="button">, so the
      // counters stay keyboard-reachable after the raw-primitive sweep.
      expect(tile.tagName).toBe('BUTTON');
      expect(tile.getAttribute('type')).toBe('button');
      expect(tile.getAttribute('data-variant')).toBe('ghost');
      expect(within(tile).getByText(count)).toBeTruthy();
    }
  });

  it('tints the active counter with its status token and the rest with surface tokens', () => {
    renderPanel({ checks, statusFilter: 'fail' });

    expect(counterTile('Failing').className).toContain('ring-status-fail');
    expect(counterTile('Failing').className).toContain('bg-status-fail/5');
    expect(counterTile('Healthy').className).toContain('bg-surface');
    expect(counterTile('Healthy').className).not.toContain('ring-status-ok');
    // The neutral "Unknown" tile rides the text-subtle token, not a status ramp.
    expect(counterTile('Unknown').className).toContain('bg-surface');
  });

  it('marks the unknown counter active with the subtle-token ring', () => {
    renderPanel({ checks, statusFilter: 'unknown' });
    expect(counterTile('Unknown').className).toContain('ring-text-subtle');
  });

  it('selects a filter on click when it is not the active one', () => {
    const { setStatusFilter } = renderPanel({ checks, statusFilter: 'all' });
    fireEvent.click(counterTile('Warning'));
    expect(setStatusFilter).toHaveBeenCalledWith('warn');
    fireEvent.click(counterTile('Failing'));
    expect(setStatusFilter).toHaveBeenCalledWith('fail');
    fireEvent.click(counterTile('Unknown'));
    expect(setStatusFilter).toHaveBeenCalledWith('unknown');
  });

  it('toggles the active counter back to "all"', () => {
    const { setStatusFilter } = renderPanel({ checks, statusFilter: 'ok' });
    fireEvent.click(counterTile('Healthy'));
    expect(setStatusFilter).toHaveBeenCalledWith('all');
  });
});

describe('HealthChecks — empty states', () => {
  it('offers "Create your first check" when no checks exist', () => {
    const { handleOpenModal } = renderPanel({ checks: [] });
    expect(screen.getByText('No health checks configured.')).toBeTruthy();

    const create = screen.getByRole('button', { name: 'Create your first check' });
    expect(create.getAttribute('data-variant')).toBe('ghost');
    expect(create.className).toContain('text-accent');
    fireEvent.click(create);
    expect(handleOpenModal).toHaveBeenCalledTimes(1);
  });

  it('offers "Clear filters" when checks exist but none match, and resets both filters', () => {
    const handlers = renderPanel({
      checks: [makeCheck({ id: 'a', name: 'api' })],
      searchQuery: 'nothing-matches',
    });
    expect(screen.getByText('No checks match your filters.')).toBeTruthy();

    const clear = screen.getByRole('button', { name: 'Clear filters' });
    expect(clear.getAttribute('data-variant')).toBe('ghost');
    fireEvent.click(clear);
    expect(handlers.setSearchQuery).toHaveBeenCalledWith('');
    expect(handlers.setStatusFilter).toHaveBeenCalledWith('all');
  });
});

describe('HealthChecks — rows', () => {
  it('renders a real check row with its badges, label and action buttons', () => {
    const handlers = renderPanel({
      checks: [
        makeCheck({
          id: 'c1',
          name: 'Jellyfin container',
          type: 'podman',
          target: 'media-jellyfin',
          nodeName: 'box-1',
          status: 'fail',
          message: 'exit code 1',
          lastRun: '2026-07-01T10:00:00.000Z',
          history: [
            { status: 'fail', latency: 900, timestamp: '2026-07-01T10:00:00.000Z' },
            { status: 'ok', latency: 30, timestamp: '2026-07-01T09:00:00.000Z' },
          ],
        }),
      ],
    });

    expect(screen.getByText('Jellyfin container')).toBeTruthy();
    expect(screen.getByText('PODMAN')).toBeTruthy();
    expect(screen.getByText('box-1')).toBeTruthy();
    // podman rows resolve the container name from the container list.
    expect(screen.getByText('media-jellyfin')).toBeTruthy();
    expect(screen.getByText('exit code 1')).toBeTruthy();
    // Sparkline: one bar per history point, failing bars on the fail token.
    expect(screen.getByText('900ms')).toBeTruthy();
    expect(screen.getByTitle(/^900ms - /).className).toContain('bg-status-fail');
    expect(screen.getByTitle(/^30ms - /).className).toContain('bg-status-ok/50');

    fireEvent.click(screen.getByTitle('Run check now'));
    expect(handlers.handleRun).toHaveBeenCalledWith('c1');
    fireEvent.click(screen.getByTitle('View history'));
    expect(handlers.handleViewHistory).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle('Edit check'));
    expect(handlers.handleOpenModal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle('Delete check'));
    expect(handlers.handleOpenDeleteModal).toHaveBeenCalledWith('c1');

    // Every row action is a Button primitive, not a bare <button>.
    for (const title of ['Run check now', 'View history', 'Edit check', 'Delete check']) {
      expect(screen.getByTitle(title).getAttribute('data-variant')).toBe('ghost');
    }
  });

  it('shows "Never" until the first run and the daily cadence on a diagnose row', () => {
    renderPanel({
      checks: [
        makeCheck({ id: 'n', name: 'never-run' }),
        makeCheck({
          id: 'd',
          name: 'diagnose-row',
          lastRun: '2026-07-01T10:00:00.000Z',
          diagnose: { status: 'warn' },
        }),
      ],
    });
    expect(screen.getByText('Last checked: Never')).toBeTruthy();
    expect(screen.getByText(/\(daily self-diagnose\)$/)).toBeTruthy();
  });

  it('swaps edit/delete for the self-repair action on a diagnose row', () => {
    const handlers = renderPanel({
      checks: [
        makeCheck({
          id: 'diagnose:cert',
          name: 'Certificate expiry',
          diagnose: { status: 'fail' },
        }),
      ],
    });

    expect(screen.getByTitle('Re-run self-diagnose now')).toBeTruthy();
    expect(screen.queryByTitle('Edit check')).toBeNull();
    expect(screen.queryByTitle('Delete check')).toBeNull();

    const repair = screen.getByTitle('Self-repair options');
    expect(repair.getAttribute('data-variant')).toBe('ghost');
    fireEvent.click(repair);
    expect(handlers.handleOpenRepair).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('View history'));
    expect(handlers.handleViewHistory).toHaveBeenCalledTimes(1);
  });

  it('filters rows by search query and by status', () => {
    const checks = [
      makeCheck({ id: 'a', name: 'alpha', status: 'ok' }),
      makeCheck({ id: 'b', name: 'beta', status: 'fail' }),
    ];
    const { unmount } = render(
      <HealthChecks
        checks={checks}
        containers={containers}
        searchQuery="alph"
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        handleRun={vi.fn()}
        handleOpenModal={vi.fn()}
        handleOpenDeleteModal={vi.fn()}
        handleViewHistory={vi.fn()}
        handleOpenRepair={vi.fn()}
      />,
    );
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.queryByText('beta')).toBeNull();
    unmount();

    renderPanel({ checks, statusFilter: 'fail' });
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.queryByText('alpha')).toBeNull();
  });
});
