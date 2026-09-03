import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PodmanConnection } from '@servicebay/api-client';

/**
 * #2456 — the health-check creation modal's resource picker fetches
 * containers/services for `formData.nodeName` from an effect keyed on it.
 * Switching Target Node twice leaves two batches of three requests in flight;
 * pre-fix the batch that resolved LAST won, so a slow answer for the node you
 * just moved off would repopulate the picker with the WRONG node's containers.
 *
 * The test drives the resolution order explicitly: node-b's batch (the current
 * selection) is answered first, node-a's abandoned batch second.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/health',
  useSearchParams: () => new URLSearchParams(),
}));

// Identity-stable, deliberately: the dashboard's socket effect depends on
// `addToast`, so a fresh object per render would re-subscribe (and re-fetch)
// forever and the test would never settle.
const toast = vi.hoisted(() => ({ addToast: vi.fn(), updateToast: vi.fn() }));
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => toast, ToastType: {} }));

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ socket: null }) }));

const NODES: PodmanConnection[] = [
  { Name: 'node-a', URI: 'ssh://a', Identity: '', Default: false },
  { Name: 'node-b', URI: 'ssh://b', Identity: '', Default: false },
];
vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchNodes: vi.fn(async () => NODES),
}));

// Heavy siblings rendered by other tabs — out of scope for this race.
vi.mock('@/components/LogViewer', () => ({ default: () => null }));
vi.mock('@/dashboards/SystemInfoDashboard', () => ({ SystemInfoContent: () => null, default: () => null }));
vi.mock('@/dashboards/ContainersDashboard', () => ({ default: () => null }));
vi.mock('@/components/DiagnoseProbeList', () => ({ default: () => null }));

import HealthDashboard from '@/dashboards/HealthDashboard';

/** One in-flight resource request, held open until the test answers it. */
type Waiter = { url: string; resolve: (res: unknown) => void };

const RESOURCE_PREFIXES = ['/api/containers', '/api/system/services', '/api/services'];

// The V4 agent's `listContainers` reply is the camelCase `EnrichedContainer`
// shape (lowercase id/names/image) — not podman's raw `Id`/`Names`/`Image`.
// This fixture used to carry the capitalized guess, which is why the picker's
// real-box breakage (#2782) never showed up here.
function containerFor(node: string) {
  return [{ id: `${node}-id`, names: [`${node}-web`], image: `${node}/nginx`, state: 'running' }];
}

describe('HealthDashboard resource picker — stale-node guard (#2456)', () => {
  let waiters: Waiter[];

  beforeEach(() => {
    waiters = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (RESOURCE_PREFIXES.some(p => url.startsWith(p))) {
        return new Promise(resolve => { waiters.push({ url, resolve }); });
      }
      // Everything else (the check list) answers immediately and emptily.
      return Promise.resolve({ ok: true, json: async () => [] });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Answer every still-open request that was issued for `node`. */
  const settleNode = async (node: string, containers?: unknown[]) => {
    const mine = waiters.filter(w => w.url.includes(`node=${node}`));
    expect(mine.length).toBe(3);
    waiters = waiters.filter(w => !w.url.includes(`node=${node}`));
    await act(async () => {
      for (const w of mine) {
        const body = w.url.startsWith('/api/containers')
          ? (containers ?? containerFor(node))
          : w.url.startsWith('/api/system/services')
            ? [{ unit: `${node}.service` }]
            : [{ name: `${node}-stack` }];
        w.resolve({ ok: true, json: async () => body });
      }
      await Promise.resolve();
    });
  };

  const selectWithOption = (name: RegExp | string): HTMLSelectElement => {
    const option = screen.getByRole('option', { name });
    const select = option.closest('select');
    expect(select).not.toBeNull();
    return select as HTMLSelectElement;
  };

  const containerOptionTexts = () =>
    Array.from(selectWithOption(/Select a container|Loading containers/).options)
      .map(o => (o.textContent || '').trim());

  /** Open the modal, pick the container check type, then switch node a → b. */
  const openModalAndSwitchNodes = async () => {
    render(<HealthDashboard />);
    // Wait for getNodes() so the Target Node dropdown has both nodes.
    await waitFor(() => expect(screen.getByLabelText('Add Check')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Add Check'));

    fireEvent.change(selectWithOption('Podman Container'), { target: { value: 'podman' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Select a container/ })).toBeTruthy());

    const nodeSelect = selectWithOption('Local (ServiceBay Host)');
    await waitFor(() => expect(nodeSelect.querySelector('option[value="node-b"]')).not.toBeNull());

    fireEvent.change(nodeSelect, { target: { value: 'node-a' } });
    await waitFor(() => expect(waiters.filter(w => w.url.includes('node=node-a'))).toHaveLength(3));

    fireEvent.change(nodeSelect, { target: { value: 'node-b' } });
    await waitFor(() => expect(waiters.filter(w => w.url.includes('node=node-b'))).toHaveLength(3));
  };

  it('reproduces the race: the abandoned node-a batch resolving LAST must not repopulate the picker', async () => {
    await openModalAndSwitchNodes();

    // Current selection answers first, the superseded node then lands.
    await settleNode('node-b');
    await settleNode('node-a');

    await waitFor(() => expect(containerOptionTexts()).toContain('node-b-web (node-b/nginx)'));
    expect(containerOptionTexts()).not.toContain('node-a-web (node-a/nginx)');
    // The managed/system lists are committed from the same batch, so they must
    // agree with the node on screen too — no half-node-a, half-node-b picker.
    expect(screen.queryByText(/node-a-stack/)).toBeNull();
  });

  it('a superseded batch does not clear the loading state of the batch still running', async () => {
    await openModalAndSwitchNodes();

    await settleNode('node-a'); // only the abandoned batch has landed

    // Still fetching node-b: the picker must stay in its loading state rather
    // than presenting itself as a settled (and wrong) list.
    expect(containerOptionTexts()).toContain('Loading containers...');

    await settleNode('node-b');
    await waitFor(() => expect(containerOptionTexts()).toContain('node-b-web (node-b/nginx)'));
    expect(containerOptionTexts()).not.toContain('Loading containers...');
  });

  it('#2782 — renders the picker from the agent’s full EnrichedContainer row', async () => {
    // A verbatim `listContainers` row as the V4 agent emits it. Pre-fix the
    // schema demanded `Id`/`Names`/`Image`, so `getNodeContainers` threw a
    // TypedFetchError, the `.catch(() => null)` swallowed it, and the picker
    // stayed empty on the real box.
    const agentRow = {
      id: '9f1c2a3b4d5e',
      names: ['media-jellyfin'],
      image: 'docker.io/jellyfin/jellyfin:latest',
      state: 'running',
      status: 'Up 3 days',
      created: 1756800000,
      ports: [{ hostPort: 8096, containerPort: 8096, protocol: 'tcp' }],
      mounts: [],
      labels: {},
      networks: ['podman'],
      isHostNetwork: false,
      podId: 'a1b2c3',
      podName: 'media',
      isInfra: false,
      pid: 4242,
    };

    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByLabelText('Add Check')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Add Check'));
    fireEvent.change(selectWithOption('Podman Container'), { target: { value: 'podman' } });
    const nodeSelect = selectWithOption('Local (ServiceBay Host)');
    await waitFor(() => expect(nodeSelect.querySelector('option[value="node-a"]')).not.toBeNull());

    fireEvent.change(nodeSelect, { target: { value: 'node-a' } });
    await waitFor(() => expect(waiters.filter(w => w.url.includes('node=node-a'))).toHaveLength(3));
    await settleNode('node-a', [agentRow]);

    await waitFor(() => expect(containerOptionTexts())
      .toContain('media-jellyfin (docker.io/jellyfin/jellyfin:latest)'));
    // The option's value is what a podman check targets — the container name.
    const option = screen.getByRole('option', { name: /media-jellyfin/ }) as HTMLOptionElement;
    expect(option.value).toBe('media-jellyfin');
  });

  it('happy path: a single node selection populates that node’s containers', async () => {
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByLabelText('Add Check')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Add Check'));
    fireEvent.change(selectWithOption('Podman Container'), { target: { value: 'podman' } });
    const nodeSelect = selectWithOption('Local (ServiceBay Host)');
    await waitFor(() => expect(nodeSelect.querySelector('option[value="node-a"]')).not.toBeNull());

    fireEvent.change(nodeSelect, { target: { value: 'node-a' } });
    await waitFor(() => expect(waiters.filter(w => w.url.includes('node=node-a'))).toHaveLength(3));
    await settleNode('node-a');

    await waitFor(() => expect(containerOptionTexts()).toContain('node-a-web (node-a/nginx)'));
  });
});
