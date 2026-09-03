import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BulkTemplateUpgrade from '@/components/BulkTemplateUpgrade';

/**
 * #2602 — the collective upgrade path, from the operator's side.
 *
 * The criteria this file pins: the lagging services are visible, the run is
 * gated behind a preview that shows dependency order, and the run itself is
 * reported by the SAME per-service outcome surface a single upgrade got in
 * #2600/#2601 — not by a second, quieter one.
 */

/** Mirrors the real hook: `startConfigure` RESOLVES the items (yaml, deps) and
 *  returns them — it does not hand them back through `controller.items` until
 *  React commits the state update. A caller that reads them off the controller
 *  in the same tick starts an empty job. */
const startConfigure = vi.fn(async (items: Array<{ name: string; checked: boolean; alreadyInstalled?: boolean }>) => ({
  items: items.map(i => ({ ...i, yaml: 'apiVersion: v1\n' })),
  variables: [{ name: 'PUBLIC_DOMAIN', value: 'example.com' }],
}));
const runInstall = vi.fn(async (_overrides?: {
  node?: string;
  items?: Array<{ name: string; checked: boolean; yaml?: string }>;
  variables?: unknown[];
}) => {});
let controllerState: Record<string, unknown> = {};

vi.mock('@/hooks/useStackInstall', () => ({
  useStackInstall: () => ({
    phase: 'idle',
    items: [],
    variables: [],
    logs: [],
    installingNow: null,
    deployedNames: [],
    credentialsManifest: [],
    npmCredPrompt: false,
    npmCredFallback: { email: '', password: '' },
    npmCredError: null,
    error: null,
    setItemChecked: () => {},
    setItems: () => {},
    setVariableValue: () => {},
    setVariableExposure: () => {},
    startConfigure,
    runInstall,
    retryNpmCredentials: vi.fn(),
    skipNpmCredentials: vi.fn(),
    appendLog: () => {},
    reset: () => {},
    abortInstall: () => {},
    attachToJob: vi.fn(),
    jobId: null,
    ...controllerState,
  }),
}));

vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchNodes: vi.fn(async () => [{ Name: 'Local' }]),
}));

const PENDING = {
  pending: [
    { name: 'media', installedVersion: 7, currentVersion: 8, hasBreakingChange: false, sectionHeaders: ['v8'] },
    { name: 'auth', installedVersion: 5, currentVersion: 6, hasBreakingChange: true, sectionHeaders: ['v6 (breaking)'] },
    { name: 'immich', installedVersion: 1, currentVersion: 2, hasBreakingChange: false, sectionHeaders: [] },
  ],
  hasBreakingChange: true,
};

const PLAN = {
  order: [
    {
      name: 'auth', installedVersion: 5, currentVersion: 6, hasBreakingChange: true,
      sectionHeaders: ['v6 (breaking)'], dependencies: [], tier: 'infrastructure',
      migrations: [{ filename: 'v5-to-v6.py', fromVersion: 5, toVersion: 6 }],
    },
    {
      name: 'immich', installedVersion: 1, currentVersion: 2, hasBreakingChange: false,
      sectionHeaders: [], dependencies: ['auth'], tier: 'feature', migrations: [],
    },
  ],
  excluded: [
    {
      name: 'media', installedVersion: 7, currentVersion: 8, hasBreakingChange: false,
      sectionHeaders: [], dependencies: [], tier: 'feature', migrations: [],
      excludedReason: 'Migration chain for media is incomplete: no script for v7→v8 (have v1, v3). The deploy would abort.',
    },
  ],
  satisfiers: ['nginx', 'adguard'],
  hasBreakingChange: true,
};

function mockFetch(plan: unknown = PLAN, pending: unknown = PENDING) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('upgrades-pending')) {
      return { ok: true, json: async () => pending } as Response;
    }
    if (String(url).includes('bulk-upgrade-plan')) {
      lastPlanBody = init?.body ? JSON.parse(String(init.body)) : null;
      return { ok: true, json: async () => plan } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

let lastPlanBody: { names?: string[] } | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  controllerState = {};
  lastPlanBody = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BulkTemplateUpgrade — the list of services that are behind', () => {
  it('names every service behind its shipped template version, with the version hop', async () => {
    render(<BulkTemplateUpgrade />);
    expect(await screen.findByText('media')).toBeDefined();
    expect(screen.getByText('auth')).toBeDefined();
    expect(screen.getByText('immich')).toBeDefined();
    expect(screen.getByText('v7 → v8')).toBeDefined();
    expect(screen.getByText('v5 → v6')).toBeDefined();
  });

  it('says nothing needs upgrading rather than rendering an empty list', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch(PLAN, { pending: [], hasBreakingChange: false });
    render(<BulkTemplateUpgrade />);
    expect(await screen.findByText(/Every installed service is on its shipped template version/)).toBeDefined();
  });

  it('leaves breaking upgrades unchecked by default so a bulk action never opts into one silently', async () => {
    render(<BulkTemplateUpgrade />);
    const authBox = await screen.findByLabelText('Upgrade auth') as HTMLInputElement;
    const mediaBox = screen.getByLabelText('Upgrade media') as HTMLInputElement;
    expect(authBox.checked).toBe(false);
    expect(mediaBox.checked).toBe(true);
  });

  it('sends the operator selection to the plan endpoint, not a blanket all', async () => {
    render(<BulkTemplateUpgrade />);
    fireEvent.click(await screen.findByLabelText('Upgrade media'));   // uncheck media
    fireEvent.click(screen.getByRole('button', { name: /Preview 1 upgrade/ }));
    await waitFor(() => expect(lastPlanBody).not.toBeNull());
    expect(lastPlanBody?.names).toEqual(['immich']);
  });
});

describe('BulkTemplateUpgrade — the preview gate', () => {
  async function openPreview() {
    render(<BulkTemplateUpgrade />);
    fireEvent.click(await screen.findByRole('button', { name: /Select all/ }));
    fireEvent.click(screen.getByRole('button', { name: /Preview 3 upgrades/ }));
    await screen.findByText(/would be redeployed, in this order/);
  }

  it('does not deploy anything on the way to the preview', async () => {
    await openPreview();
    expect(startConfigure).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('shows the run in dependency order, with what each service depends on', async () => {
    await openPreview();
    const rows = screen.getAllByRole('listitem').map(li => li.textContent ?? '');
    const authRow = rows.findIndex(t => t.includes('auth'));
    const immichRow = rows.findIndex(t => t.includes('immich'));
    expect(authRow).toBeGreaterThanOrEqual(0);
    expect(authRow).toBeLessThan(immichRow);
    expect(screen.getByText('after auth')).toBeDefined();
  });

  it('states the migration scripts that will run, and where none will', async () => {
    await openPreview();
    expect(screen.getByText(/Runs 1 migration: v5-to-v6\.py/)).toBeDefined();
    expect(screen.getByText(/No migration script — redeploy only\./)).toBeDefined();
  });

  it('names the services that cannot roll out and why, instead of silently dropping them', async () => {
    await openPreview();
    expect(screen.getByText(/cannot be upgraded and .* left out of this run/)).toBeDefined();
    expect(screen.getByText(/no script for v7→v8/)).toBeDefined();
  });

  it('says data is kept — this is not the destructive wipe-config reinstall', async () => {
    await openPreview();
    expect(screen.getByText(/not a wipe-config reinstall/)).toBeDefined();
  });

  it('blocks the run until a breaking selection is acknowledged', async () => {
    await openPreview();
    const start = screen.getByRole('button', { name: /Upgrade 2 services/ }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /breaking-change notes/ }));
    expect((screen.getByRole('button', { name: /Upgrade 2 services/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('drives every planned service through ONE install run, in the planned order', async () => {
    await openPreview();
    fireEvent.click(screen.getByRole('checkbox', { name: /breaking-change notes/ }));
    fireEvent.click(screen.getByRole('button', { name: /Upgrade 2 services/ }));
    await waitFor(() => expect(startConfigure).toHaveBeenCalledTimes(1));
    const items = startConfigure.mock.calls[0][0] as Array<{ name: string; checked: boolean; alreadyInstalled?: boolean }>;
    expect(items.filter(i => i.checked).map(i => i.name)).toEqual(['auth', 'immich']);
    // Every other installed service rides along as a dependency satisfier so
    // the runner's topo-sort doesn't reject a deployed-but-not-upgraded dep.
    expect(items.filter(i => i.alreadyInstalled).map(i => i.name)).toEqual(['nginx', 'adguard']);
    expect(items.some(i => i.name === 'media')).toBe(false);

    // The job must be started with the RESOLVED manifest. Reading the items
    // back off the controller in the same tick yields the pre-configure
    // (empty) state, so the runner would start a job with nothing checked and
    // report a finished install that deployed nothing — the exact failure
    // shape #2601 was about. Caught in the browser check, pinned here.
    await waitFor(() => expect(runInstall).toHaveBeenCalledTimes(1));
    const override = runInstall.mock.calls[0][0];
    expect(override?.items?.filter(i => i.checked).map(i => i.name)).toEqual(['auth', 'immich']);
    expect(override?.items?.every(i => !!i.yaml)).toBe(true);
    expect(override?.variables).toHaveLength(1);
  });

  it('refuses to start when the whole selection is excluded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch({ ...PLAN, order: [], hasBreakingChange: false });
    render(<BulkTemplateUpgrade />);
    fireEvent.click(await screen.findByRole('button', { name: /Select all/ }));
    fireEvent.click(screen.getByRole('button', { name: /Preview 3 upgrades/ }));
    await screen.findByText(/Nothing in this selection can roll out/);
    expect((screen.getByRole('button', { name: /Upgrade 0 services/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('BulkTemplateUpgrade — the run reports per service', () => {
  it('reuses the install progress surface, so a bulk run that deployed nothing says so', async () => {
    // The #2601 shape at bulk scale: the job ended, nothing reached the box.
    controllerState = {
      phase: 'error',
      items: [
        { name: 'auth', checked: true },
        { name: 'immich', checked: true },
      ],
      deployedNames: [],
      error: 'Migration chain for auth is incomplete: no script for v5→v6. Aborting deploy.',
      logs: ['Installing auth...', '❌ Install stopped at auth'],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch({ ...PLAN, hasBreakingChange: false });
    render(<BulkTemplateUpgrade />);
    fireEvent.click(await screen.findByRole('button', { name: /Select all/ }));
    fireEvent.click(screen.getByRole('button', { name: /Preview 3 upgrades/ }));
    await screen.findByText(/would be redeployed, in this order/);
    fireEvent.click(screen.getByRole('button', { name: /Upgrade 2 services/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nothing was deployed');
    expect(alert.textContent).toContain('0 of 2 requested services rolled out');
    expect(alert.textContent).toContain('Still on the previous version: auth, immich');
  });

  it('counts a partial bulk roll-out honestly instead of reporting a blanket success', async () => {
    controllerState = {
      phase: 'error',
      items: [
        { name: 'auth', checked: true },
        { name: 'immich', checked: true },
        { name: 'nginx', checked: false, alreadyInstalled: true },
      ],
      deployedNames: ['auth', 'nginx'],
      error: '1/2 requested service(s) deployed (auth). NOT deployed: immich.',
      logs: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch({ ...PLAN, hasBreakingChange: false });
    render(<BulkTemplateUpgrade />);
    fireEvent.click(await screen.findByRole('button', { name: /Select all/ }));
    fireEvent.click(screen.getByRole('button', { name: /Preview 3 upgrades/ }));
    await screen.findByText(/would be redeployed, in this order/);
    fireEvent.click(screen.getByRole('button', { name: /Upgrade 2 services/ }));

    const alert = await screen.findByRole('alert');
    // The skipped satisfier `nginx` must NOT inflate the count.
    expect(alert.textContent).toContain('1 of 2 requested services rolled out');
    expect(alert.textContent).toContain('Still on the previous version: immich');
  });
});
