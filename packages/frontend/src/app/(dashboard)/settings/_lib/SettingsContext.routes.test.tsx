/**
 * Settings → System Connections drives the migrated node/ssh ROUTES (#2745).
 *
 * The node CRUD and SSH probes used to be Server Actions in
 * `app/actions/{nodes,ssh}.ts`, which a test could only observe by mocking the
 * action module — the wire was invisible. Now they are `@servicebay/api-client`
 * methods over `/api/system/*`, so this renders the real `SettingsProvider`
 * against a stubbed `fetch` and asserts the exact request each operator action
 * puts on the wire: add a node, probe SSH, remove, promote to default.
 *
 * This is the DOM half of the issue's browser acceptance ("add a node, check
 * SSH"); the routes' own behaviour is covered by
 * `app/api/system/nodes/**\/route.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn() }),
  ToastType: {},
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// The provider mounts the SSH modal; it has its own tests.
vi.mock('@/components/SSHSetupModal', () => ({ __esModule: true, default: () => null }));

import { SettingsProvider, useSettings } from './SettingsContext';

const NODE = { Name: 'box', URI: 'ssh://core@host:22', Identity: '/app/data/ssh/id_rsa', Default: true };

/** Every request the provider made, in order. */
let calls: { url: string; method: string; body: unknown }[];

/** Fresh Response per call — never hand the same one to two awaits. */
function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function Probe() {
  const s = useSettings();
  return (
    <div>
      <span data-testid="node-count">{s.nodes.length}</span>
      <button
        onClick={() =>
          void s.submitNode('create', {
            name: 'attic',
            destination: 'ssh://core@attic:22',
            identity: '/app/data/ssh/id_rsa',
          })
        }
      >
        add
      </button>
      <button onClick={() => void s.removeNode('box')}>remove</button>
      <button onClick={() => void s.setDefault('box')}>promote</button>
    </div>
  );
}

const mounted = () =>
  waitFor(() => expect(screen.getByTestId('node-count').textContent).toBe('1'));

const urls = () => calls.map(c => `${c.method} ${c.url}`);

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

      if (url.startsWith('/api/settings')) return json({ autoUpdate: { enabled: false } });
      if (url === '/api/system/nodes' && method === 'GET') return json({ ok: true, data: [NODE] });
      if (url === '/api/system/ssh/check') return json({ ok: true, data: { success: true, isOpen: true } });
      if (url === '/api/system/ssh/verify') return json({ ok: true, data: { success: true } });
      return json({ ok: true, data: { success: true } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('SettingsProvider → /api/system/* routes (#2745)', () => {
  it('loads the node list from GET /api/system/nodes and probes SSH per node', async () => {
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );

    await mounted();
    expect(urls()).toContain('GET /api/system/nodes');

    // The auto-probe effect runs checkHealth for every loaded node.
    await waitFor(() => expect(urls()).toContain('POST /api/system/ssh/verify'));
    const verify = calls.find(c => c.url === '/api/system/ssh/verify');
    expect(verify?.body).toMatchObject({ host: 'host', port: 22, user: 'core' });
  });

  it('adds a node via TCP check then POST /api/system/nodes, and re-reads the list', async () => {
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );
    await mounted();

    calls.length = 0;
    fireEvent.click(screen.getByText('add'));

    await waitFor(() => expect(urls()).toContain('POST /api/system/nodes'));
    // Reachability is checked BEFORE the node is stored.
    expect(urls().indexOf('POST /api/system/ssh/check')).toBeLessThan(
      urls().indexOf('POST /api/system/nodes'),
    );
    expect(calls.find(c => c.url === '/api/system/nodes' && c.method === 'POST')?.body).toEqual({
      name: 'attic',
      destination: 'ssh://core@attic:22',
      identity: '/app/data/ssh/id_rsa',
    });
    // …and the list is re-read so the UI shows what the server now holds.
    await waitFor(() => expect(urls()).toContain('GET /api/system/nodes'));
  });

  it('removes and promotes through the per-node routes', async () => {
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );
    await mounted();

    calls.length = 0;
    fireEvent.click(screen.getByText('remove'));
    await waitFor(() => expect(urls()).toContain('DELETE /api/system/nodes/box'));

    calls.length = 0;
    fireEvent.click(screen.getByText('promote'));
    await waitFor(() => expect(urls()).toContain('POST /api/system/nodes/box/default'));
  });
});
