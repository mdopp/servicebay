/**
 * #2941 behaviour: an action that SUCCEEDED must be reported as a success, and
 * the list must refresh.
 *
 * The class gate next door (`api_envelope_contract_gate.test.ts`) pins the
 * shape mismatch that caused this. This file pins what the operator actually
 * saw: podman/systemd did the work and the UI said "Delete failed — response
 * failed schema validation", the list never refreshed, and `updateServiceImage`
 * returned `false` so a bulk "Update now" counted a successful pull as a
 * failure.
 *
 * Each case drives the REAL route handler to produce the response body, then
 * feeds that exact body to the real hook — so the two halves cannot drift apart
 * again behind a test that hand-writes the body it wishes the route sent.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { mutateRawApi } from '@servicebay/api-client';

// --- host-side stubs --------------------------------------------------------

const deleteService = vi.fn(async () => {});
const updateAndRestartService = vi.fn(async () => ({ service: 'media', images: [] }));
const sendCommand = vi.fn(async () => ({ code: 0, stdout: 'ok' }));

vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'test', expires: new Date(Date.now() + 60_000) })),
}));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    deleteService: (...a: any[]) => deleteService(...(a as [])),
    updateAndRestartService: (...a: any[]) => updateAndRestartService(...(a as [])),
    forceUpdateService: vi.fn(async () => ({})),
    getServiceStatus: vi.fn(async () => 'active'),
    getServiceFiles: vi.fn(async () => ({})),
  },
}));
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => {}),
}));
vi.mock('@/lib/health/store', () => ({ HealthStore: { getChecks: () => [], deleteCheck: vi.fn() } }));
vi.mock('@/lib/agent/manager', () => ({ agentManager: { getAgent: () => ({ sendCommand }) } }));

// --- client-side stubs ------------------------------------------------------

const updateToast = vi.fn();
const toast = { addToast: vi.fn(() => 'toast-id'), updateToast, removeToast: vi.fn() };
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => toast, ToastType: {} }));
vi.mock('@/components/ActionProgressModal', () => ({ default: () => null }));
vi.mock('@/components/ServiceMonitor', () => ({ default: () => null }));
vi.mock('@/components/ServiceForm', () => ({ default: () => null }));

import { DELETE as DELETE_SERVICE } from '../../packages/frontend/src/app/api/services/[name]/route';
import { POST as SERVICE_ACTION } from '../../packages/frontend/src/app/api/services/[name]/action/route';
import { POST as CONTAINER_ACTION } from '../../packages/frontend/src/app/api/containers/[id]/action/route';
import { useServiceActions } from '@/hooks/useServiceActions';
import { useContainerActions } from '@/hooks/useContainerActions';

const SERVICE = {
  id: 'media.service',
  name: 'media.service',
  displayName: 'media',
  nodeName: 'Local',
  type: 'kube',
} as any;

/** Run a real route handler and hand its body back as a fresh Response factory. */
function replay(bodyText: string, status: number) {
  return () => new Response(bodyText, { status, headers: { 'Content-Type': 'application/json' } });
}

async function routeResponse(fn: () => Promise<Response>) {
  const res = await fn();
  return { body: await res.text(), status: res.status };
}

/**
 * The container route's own allow-list, read out of the route source. Reading it
 * rather than restating it means a sixth accepted action is covered here the
 * moment the route accepts it.
 */
const CONTAINER_ROUTE_ACTIONS: string[] = (() => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../packages/frontend/src/app/api/containers/[id]/action/route.ts'),
    'utf-8',
  );
  const m = /\[([^\]]*)\]\.includes\(action\)/.exec(src);
  if (!m) throw new Error('could not read the container route action allow-list');
  return m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();

function ContainerHarness({ onActionComplete }: { onActionComplete: () => void }) {
  const actions = useContainerActions({ onActionComplete });
  return (
    <>
      <button onClick={() => actions.openActions({ id: 'abc123', name: 'media-jellyfin', nodeName: 'Local' })}>
        open-container-actions
      </button>
      {actions.overlay}
    </>
  );
}

function Harness({ onRefresh }: { onRefresh: () => void }) {
  const actions = useServiceActions({ onRefresh });
  return (
    <>
      <button onClick={() => actions.requestDelete(SERVICE)}>ask-delete</button>
      <button onClick={() => { void actions.updateServiceImage(SERVICE); }}>update-image</button>
      {actions.overlays}
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sendCommand.mockResolvedValue({ code: 0, stdout: 'ok' } as any);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('action outcome truth — success is reported as success (#2941)', () => {
  it('a delete that the route performed reports "Service deleted" and refreshes the list', async () => {
    const { body, status } = await routeResponse(() => DELETE_SERVICE(
      new NextRequest('http://localhost/api/services/media.service', { method: 'DELETE' }),
      { params: Promise.resolve({ name: 'media.service' }) } as any,
    ) as Promise<Response>);
    // The route shapes its own body — no `{ ok, data }` envelope anywhere.
    expect(JSON.parse(body)).toEqual({ success: true });

    vi.stubGlobal('fetch', vi.fn(async () => replay(body, status)()));
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);

    fireEvent.click(screen.getByText('ask-delete'));
    fireEvent.change(document.querySelector('input[type="text"]') as HTMLInputElement, {
      target: { value: 'media.service' },
    });
    fireEvent.click(screen.getByLabelText('Permanently Delete'));

    await waitFor(() => expect(deleteService).toHaveBeenCalled());
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(updateToast).toHaveBeenCalledWith('toast-id', 'success', 'Service deleted', expect.any(String));
    expect(updateToast).not.toHaveBeenCalledWith('toast-id', 'error', 'Delete failed', expect.anything());
  });

  it('an image update that the route performed returns true and reports success', async () => {
    const { body, status } = await routeResponse(() => SERVICE_ACTION(
      new NextRequest('http://localhost/api/services/media.service/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update' }),
      }),
      { params: Promise.resolve({ name: 'media.service' }) } as any,
    ) as Promise<Response>);
    expect(JSON.parse(body)).not.toHaveProperty('ok');

    vi.stubGlobal('fetch', vi.fn(async () => replay(body, status)()));
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useServiceActions({ onRefresh }));

    await expect(result.current.updateServiceImage(SERVICE)).resolves.toBe(true);
    expect(onRefresh).toHaveBeenCalled();
    expect(updateToast).toHaveBeenCalledWith('toast-id', 'success', 'Service updated', expect.any(String));
  });

  // Every action the container route ACCEPTS, enumerated from the route's own
  // allow-list rather than from the two the menu happens to wire up today. Each
  // one is read back through `mutateRawApi` — the exact helper the hook uses —
  // so a route body that stops matching the client is caught for all of them.
  for (const action of CONTAINER_ROUTE_ACTIONS) {
    it(`a container ${action} that podman performed is read as a success by the client helper`, async () => {
      const { body, status } = await routeResponse(() => CONTAINER_ACTION(
        new NextRequest('http://localhost/api/containers/abc123/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        { params: Promise.resolve({ id: 'abc123' }) } as any,
      ) as Promise<Response>);
      expect(JSON.parse(body)).toMatchObject({ success: true });

      vi.stubGlobal('fetch', vi.fn(async () => replay(body, status)()));
      await expect(
        mutateRawApi('/api/containers/abc123/action', z.object({}).passthrough(), { action }),
      ).resolves.toMatchObject({ success: true });
    });
  }

  it('the container overlay reports a successful stop as a success and refreshes', async () => {
    const { body, status } = await routeResponse(() => CONTAINER_ACTION(
      new NextRequest('http://localhost/api/containers/abc123/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }),
      { params: Promise.resolve({ id: 'abc123' }) } as any,
    ) as Promise<Response>);

    vi.stubGlobal('fetch', vi.fn(async () => replay(body, status)()));
    const onActionComplete = vi.fn();
    render(<ContainerHarness onActionComplete={onActionComplete} />);
    fireEvent.click(screen.getByText('open-container-actions'));
    fireEvent.click(screen.getByText('Stop'));

    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(updateToast).toHaveBeenCalledWith('toast-id', 'success', 'Action initiated', expect.any(String));
    expect(updateToast).not.toHaveBeenCalledWith('toast-id', 'error', 'Action failed', expect.anything());
  });

  it('the container overlay reports a successful delete as a success and refreshes', async () => {
    const { body, status } = await routeResponse(() => CONTAINER_ACTION(
      new NextRequest('http://localhost/api/containers/abc123/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete' }),
      }),
      { params: Promise.resolve({ id: 'abc123' }) } as any,
    ) as Promise<Response>);

    vi.stubGlobal('fetch', vi.fn(async () => replay(body, status)()));
    const onActionComplete = vi.fn();
    render(<ContainerHarness onActionComplete={onActionComplete} />);
    fireEvent.click(screen.getByText('open-container-actions'));
    fireEvent.click(screen.getByText('Delete Container'));
    fireEvent.change(document.querySelector('input[type="text"]') as HTMLInputElement, {
      target: { value: 'media-jellyfin' },
    });
    fireEvent.click(screen.getByLabelText('Delete'));

    await waitFor(() => expect(onActionComplete).toHaveBeenCalled());
    expect(updateToast).toHaveBeenCalledWith('toast-id', 'success', 'Action initiated', expect.any(String));
  });

  it('a container action podman refused is still reported as a failure', async () => {
    sendCommand.mockResolvedValue({ code: 1, stdout: '', stderr: 'no such container' } as any);
    const { body, status } = await routeResponse(() => CONTAINER_ACTION(
      new NextRequest('http://localhost/api/containers/abc123/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }),
      { params: Promise.resolve({ id: 'abc123' }) } as any,
    ) as Promise<Response>);
    expect(status).toBe(500);

    vi.stubGlobal('fetch', vi.fn(async () => replay(body, status)()));
    const onActionComplete = vi.fn();
    render(<ContainerHarness onActionComplete={onActionComplete} />);
    fireEvent.click(screen.getByText('open-container-actions'));
    fireEvent.click(screen.getByText('Stop'));

    await waitFor(() => expect(updateToast).toHaveBeenCalledWith(
      'toast-id', 'error', 'Action failed', 'Action failed',
    ));
    expect(onActionComplete).not.toHaveBeenCalled();
  });
});
