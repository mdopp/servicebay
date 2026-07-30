import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Disk-import tile — the design-system primitive migration (lint-sweep
 * `sb/no-raw-ui-primitive`).
 *
 * The raw `<button>` / `<select>` / `<input>` / `<table>` elements in
 * `disk-import/page.tsx` were swapped for the shared `Button` / `Select` /
 * `Input` / `DataTable` wrappers. That was a RENDER-ONLY refactor, so these
 * tests pin the two things a swap can silently break:
 *
 *  1. the primitive is really the wrapper (`Button` stamps `data-variant`,
 *     `DataTable` renders a `<thead>`-bearing table with a scoped header row), and
 *  2. the BEHAVIOUR is unchanged — each control still fires the same request with
 *     the same payload, and the same disabled/appear-when rules still hold.
 *
 * The `PlanReady` / `ApplyDone` / `NoDisks` states are unreachable from the
 * poll-guard suite (which only ever sees `scanning` + the 404 picker), which is
 * why they live here rather than being folded into that file.
 *
 * Cadence is driven by hand (fake timers + explicit flushes) because the page
 * polls `/status` on a 2 s interval and RTL's `waitFor` does not cooperate with
 * faked intervals — same approach as DiskImportPage_PollGuard.test.tsx.
 */

import DiskImportPage from '@/app/(dashboard)/disk-import/page';

const DEVICES = { devices: [{ path: '/dev/sdb1', display: 'Kingston 64 GB (/dev/sdb1)' }] };

/** Two category rollups so the DataTable has real rows AND a computed Total row. */
const CATEGORIES = [
  { category: 'photos', files: 10, bytes: 500 * 1024 * 1024, copy: 8, skipDupe: 1, conflict: 1, renamed: 2 },
  { category: 'music', files: 5, bytes: 1024 * 1024, copy: 5, skipDupe: 0, conflict: 0 },
  // Zero-file categories are filtered out before the table — it must NOT render.
  { category: 'documents', files: 0, bytes: 0, copy: 0, skipDupe: 0, conflict: 0 },
];

/** A finished dry-run scan with a plan to review → the `plan-ready` tile. */
const PLAN_READY = {
  runId: 'run-plan-1',
  running: true,
  status: {
    phase: 'done',
    step: 'Plan ready',
    mode: 'dry-run',
    scanned: 15,
    planned: 15,
    applied: 0,
    conflicts: 1,
    categories: CATEGORIES,
    error: null,
  },
};

/** A finished host apply → the terminal `apply-done` tile. */
const APPLY_DONE = {
  runId: 'run-apply-1',
  running: false,
  status: {
    phase: 'done',
    step: 'Imported',
    mode: 'apply',
    scanned: 15,
    planned: 15,
    applied: 42,
    conflicts: 0,
    error: null,
  },
};

/** Minimal but valid review tree so `RoutingTree` renders alongside the presets. */
const TREE = {
  ok: true,
  mountBase: '/mnt/usb',
  owners: [
    { id: 'shared', label: 'Shared' },
    { id: 'alice', label: 'Alice' },
  ],
  dispositions: ['auto', 'photos_immich', 'skip'],
  tree: [
    {
      dir: '',
      files: 15,
      bytes: 501 * 1024 * 1024,
      categories: ['photos', 'music'],
      explicit: {},
      resolved: { disposition: 'auto', mode: 'merge', owner: 'shared', anchor: '' },
      preview: 'data/shared/',
    },
    {
      dir: 'Photos',
      files: 10,
      bytes: 500 * 1024 * 1024,
      categories: ['photos'],
      explicit: {},
      resolved: { disposition: 'auto', mode: 'merge', owner: 'shared', anchor: '' },
      preview: 'data/shared/photos/',
    },
  ],
};

const PROFILES = {
  profiles: [
    { name: 'Family disk', rules: { Photos: { owner: 'alice' } }, savedAt: 1 },
    { name: 'Work disk', rules: { Photos: { owner: 'shared' } }, savedAt: 2 },
  ],
};

/** Fresh answer object per call (never reuse a Response — memory note). */
function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

let statusBody: unknown;
let statusCode: number;
let devicesBody: unknown;
let calls: Array<{ url: string; init?: RequestInit }>;

/** Every recorded call to `path` with the given method (default POST). */
function callsTo(path: string, method = 'POST') {
  return calls.filter(
    c => c.url.includes(path) && String(c.init?.method ?? 'GET').toUpperCase() === method,
  );
}

/** JSON body of the last recorded call to `path`. */
function lastBody(path: string, method = 'POST'): Record<string, unknown> {
  const list = callsTo(path, method);
  return JSON.parse(String(list[list.length - 1].init!.body)) as Record<string, unknown>;
}

beforeEach(() => {
  calls = [];
  statusBody = PLAN_READY;
  statusCode = 200;
  devicesBody = DEVICES;
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/disk-import/status')) return json(statusBody, statusCode);
      if (url.includes('/disk-import/list-devices')) return json(devicesBody);
      if (url.includes('/disk-import/profiles')) return json(PROFILES);
      if (url.includes('/disk-import/tree')) return json(TREE);
      return json({ ok: true });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Render + flush the mount-time status / devices / profiles / tree loads. */
async function renderAndSettle() {
  render(<DiskImportPage />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Flush the microtasks a click's async handler queues. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** The RoutingPresets <Select> — identified by its own placeholder option. */
function presetSelect(): HTMLSelectElement {
  return screen.getByText('Load a preset...').closest('select') as HTMLSelectElement;
}

describe('disk-import plan-ready — DataTable replaces the hand-rolled category table', () => {
  it('renders the category rollup through DataTable (scoped header row + a Total row)', async () => {
    await renderAndSettle();

    expect(screen.getByText(/Review — 15 files planned/)).toBeTruthy();

    const table = screen.getByRole('table');
    // DataTable's own chrome: a real <thead> whose cells are scope="col" <th>s.
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map(h => h.textContent)).toEqual([
      'Category',
      'Files',
      'Size',
      'Import',
      'Renamed',
      'Dupes',
      'Conflicts',
    ]);
    for (const h of headers) expect(h.getAttribute('scope')).toBe('col');

    // Body rows: the two non-empty categories, then the computed Total. The
    // zero-file `documents` category is filtered out and must not appear.
    const bodyRows = within(table.querySelector('tbody')!).getAllByRole(
      'row',
    ) as HTMLTableRowElement[];
    expect(bodyRows).toHaveLength(3);
    expect(bodyRows.map(r => r.cells[0].textContent)).toEqual(['photos', 'music', 'Total']);
    expect(within(table).queryByText('documents')).toBeNull();

    // photos row keeps the same numbers/formatting the raw <td>s produced.
    expect(Array.from(bodyRows[0].cells).map(c => c.textContent)).toEqual([
      'photos',
      '10',
      '500 MB',
      '8',
      '2',
      '1',
      '1',
    ]);
    // music has no `renamed` key at all → still renders "0", not "undefined"/blank.
    expect(Array.from(bodyRows[1].cells).map(c => c.textContent)).toEqual([
      'music',
      '5',
      '1.0 MB',
      '5',
      '0',
      '0',
      '0',
    ]);
    // Total row is the per-column sum (bytes re-formatted from the summed total).
    expect(Array.from(bodyRows[2].cells).map(c => c.textContent)).toEqual([
      'Total',
      '15',
      '501 MB',
      '13',
      '2',
      '1',
      '1',
    ]);
    // The Total row is emphasised, and (unlike a category row) not accent-coloured.
    expect(bodyRows[2].cells[0].querySelector('div')!.className).toContain('font-semibold');
    expect(bodyRows[0].cells[3].querySelector('div')!.className).toContain('text-status-info');
    expect(bodyRows[2].cells[3].querySelector('div')!.className).not.toContain('text-status-info');
    // A non-zero conflict count still gets the warn treatment; a zero one doesn't.
    expect(bodyRows[0].cells[6].querySelector('div')!.className).toContain('text-status-warn');
    expect(bodyRows[1].cells[6].querySelector('div')!.className).not.toContain('text-status-warn');
  });

  it('falls back to the no-breakdown note (and no table) when every category is empty', async () => {
    statusBody = { ...PLAN_READY, status: { ...PLAN_READY.status, categories: [] } };
    await renderAndSettle();

    expect(screen.getByText(/No category breakdown available/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('disk-import plan-ready — Button/Select/Input wrappers keep the same behaviour', () => {
  it('Import now is a primary Button that applies the reviewed run', async () => {
    await renderAndSettle();

    const importBtn = screen.getByText('Import now').closest('button')!;
    expect(importBtn.getAttribute('data-variant')).toBe('primary');
    expect(importBtn.getAttribute('type')).toBe('button');
    expect(importBtn.disabled).toBe(false);

    fireEvent.click(importBtn);
    await flush();

    // Same payload the raw <button> posted: the reviewed runId + explicit confirm,
    // and NO rules (nothing was edited).
    expect(callsTo('/disk-import/apply')).toHaveLength(1);
    expect(lastBody('/disk-import/apply')).toEqual({ runId: 'run-plan-1', confirmed: true });
  });

  it('Start over is a ghost Button that aborts the run', async () => {
    await renderAndSettle();

    const startOver = screen.getByText('Start over').closest('button')!;
    expect(startOver.getAttribute('data-variant')).toBe('ghost');

    fireEvent.click(startOver);
    await flush();

    expect(callsTo('/disk-import/abort')).toHaveLength(1);
  });

  it('the preset Select is a real select listing the saved profiles, and loading one re-resolves the tree', async () => {
    await renderAndSettle();

    const select = presetSelect();
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map(o => o.textContent)).toEqual([
      'Load a preset...',
      'Family disk',
      'Work disk',
    ]);
    // Nothing picked yet → no Delete button, and the tree was fetched read-only.
    expect(screen.queryByText('Delete')).toBeNull();
    expect(callsTo('/disk-import/tree', 'GET')).toHaveLength(1);
    expect(callsTo('/disk-import/tree')).toHaveLength(0);

    fireEvent.change(select, { target: { value: 'Family disk' } });
    await flush();

    // Picking a preset loads its rules and re-resolves the tree against them.
    expect(select.value).toBe('Family disk');
    expect(lastBody('/disk-import/tree')).toEqual({ rules: { Photos: { owner: 'alice' } } });
    // …and the primary action re-labels, because there are now edits to re-plan.
    expect(screen.queryByText('Import now')).toBeNull();
    expect(screen.getByText('Re-plan & import')).toBeTruthy();
  });

  it('Delete only appears once a preset is picked, and is a danger Button that deletes it by name', async () => {
    await renderAndSettle();

    fireEvent.change(presetSelect(), { target: { value: 'Work disk' } });
    await flush();

    const del = screen.getByText('Delete').closest('button')!;
    expect(del.getAttribute('data-variant')).toBe('danger');

    fireEvent.click(del);
    await flush();

    expect(callsTo('/disk-import/profiles', 'DELETE')).toHaveLength(1);
    expect(callsTo('/disk-import/profiles', 'DELETE')[0].url).toContain('name=Work%20disk');
    // The picker resets, so Delete disappears again.
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('Save selection is a secondary Button gated on BOTH an edit and a typed name', async () => {
    await renderAndSettle();

    const nameInput = screen.getByPlaceholderText('Name this selection') as HTMLInputElement;
    expect(nameInput.tagName).toBe('INPUT');
    expect(nameInput.type).toBe('text');

    const save = screen.getByText('Save selection').closest('button')!;
    expect(save.getAttribute('data-variant')).toBe('secondary');
    // No edits and no name → disabled, with the "pick first" hint.
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title')).toBe('Pick owners/targets first');

    // A name alone is not enough — nothing has been edited yet.
    fireEvent.change(nameInput, { target: { value: 'My disk' } });
    expect(save.disabled).toBe(true);

    // Load a preset to create edits → now enabled, and the hint flips.
    fireEvent.change(presetSelect(), { target: { value: 'Family disk' } });
    await flush();
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('title')).toBe('Save current owner/target picks as preset');

    fireEvent.click(save);
    await flush();

    expect(lastBody('/disk-import/profiles')).toEqual({
      name: 'My disk',
      rules: { Photos: { owner: 'alice' } },
    });
    // The name field clears after a save (it is a controlled Input).
    expect(nameInput.value).toBe('');
  });

  it('Re-plan & import forwards the loaded rules with the apply', async () => {
    await renderAndSettle();

    fireEvent.change(presetSelect(), { target: { value: 'Family disk' } });
    await flush();

    fireEvent.click(screen.getByText('Re-plan & import').closest('button')!);
    await flush();

    expect(lastBody('/disk-import/apply')).toEqual({
      runId: 'run-plan-1',
      confirmed: true,
      rules: { Photos: { owner: 'alice' } },
    });
  });
});

describe('disk-import apply-done — the terminal tile Button', () => {
  it('Start over is a primary Button that aborts the finished run', async () => {
    statusBody = APPLY_DONE;
    await renderAndSettle();

    expect(screen.getByText(/42 file\(s\) imported/)).toBeTruthy();
    const startOver = screen.getByText('Start over').closest('button')!;
    expect(startOver.getAttribute('data-variant')).toBe('primary');

    fireEvent.click(startOver);
    await flush();

    expect(callsTo('/disk-import/abort')).toHaveLength(1);
  });
});

describe('disk-import no-disks — the Refresh Button', () => {
  it('Refresh is a ghost Button that re-lists the devices', async () => {
    statusBody = { ok: false, error: 'no active run' };
    statusCode = 404;
    devicesBody = { devices: [] };
    await renderAndSettle();

    expect(screen.getByText(/No USB disk detected/)).toBeTruthy();
    const refresh = screen.getByText('Refresh').closest('button')!;
    expect(refresh.getAttribute('data-variant')).toBe('ghost');

    const before = callsTo('/disk-import/list-devices', 'GET').length;
    fireEvent.click(refresh);
    await flush();

    expect(callsTo('/disk-import/list-devices', 'GET').length).toBe(before + 1);
  });
});
