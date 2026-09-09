/**
 * CLASS GATE B (#2942) — a streamed action that FAILED must never render the
 * success card.
 *
 * The defect this pins: `ActionProgressModal` called `setStatus('completed')`
 * whenever the response body ran out. The route always answers 200 and writes a
 * failing `systemctl` into the body as text, so "the stream ended" said nothing
 * about the outcome — a unit that refused to start showed
 * "✓ Operation completed successfully" above terminal output saying it failed,
 * and the whole recovery UI (Retry Action / View Full Logs / Self-Diagnose /
 * Copy Details for AI) was unreachable.
 *
 * Why this is a CLASS gate and not three assertions: it iterates
 * `SERVICE_STREAM_ACTIONS` — the single const the route's request schema and
 * the modal's `action` prop both derive from. A fourth streamed action is
 * covered the moment it is added to that const; it cannot be added to the
 * product and forgotten here. The test additionally asserts the route derives
 * its enum from that const rather than re-listing the actions, so the
 * enumeration cannot silently drift back to a hard-coded list.
 *
 * Each action is driven END TO END: the real route handler produces the stream
 * (with the host command failing), and the real modal consumes it. So both
 * halves of the contract are under the gate — a route that swallows its failure
 * marker and a client that ignores it each go red here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import {
  SERVICE_STREAM_ACTIONS,
  ACTION_STREAM_MARKER,
  encodeActionStreamResult,
} from '@servicebay/api-client';

// --- host-side stubs: the route must be able to run without a box ----------

const execSafe = vi.fn(async (_argv: string[]) => ({ stdout: '', stderr: '', code: 0 }));

vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'test', expires: new Date(Date.now() + 60_000) })),
}));
vi.mock('@/lib/executor', () => ({
  getExecutor: () => ({
    execSafe: (argv: string[]) => execSafe(argv),
    readFile: async () => '',
    spawn: () => ({
      stdout: (async function* () { yield 'status line\r\n'; })(),
      stderr: (async function* () { /* nothing */ })(),
      promise: Promise.resolve({ code: 0 }),
    }),
  }),
}));
vi.mock('@/lib/nodes', () => ({ listNodes: async () => [] }));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { getServiceFiles: async () => ({ yamlPath: '' }) },
}));
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: async () => ({ pullImage: async () => {} }) },
}));

// --- client-side stubs ------------------------------------------------------

const toast = { addToast: vi.fn(() => 'id'), updateToast: vi.fn(), removeToast: vi.fn() };
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => toast, ToastType: {} }));

/**
 * xterm is a rendering dependency, not the logic under test — and it needs a
 * real layout engine. The fake records what the modal writes so the test can
 * also prove the marker is stripped out of the operator-visible output.
 */
const written: string[] = [];
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    buffer = { active: { length: 0, getLine: () => null } };
    loadAddon() { /* noop */ }
    open() { /* noop */ }
    write(text: string) { written.push(text); }
    writeln(text: string) { written.push(text + '\n'); }
    dispose() { /* noop */ }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { /* noop */ } } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { POST } from '../../packages/frontend/src/app/api/services/[name]/action-stream/route';
import ActionProgressModal from '@/components/ActionProgressModal';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROUTE_FILE = path.join(
  REPO_ROOT,
  'packages/frontend/src/app/api/services/[name]/action-stream/route.ts',
);

/** Run the real route handler for one action and return the whole stream body. */
async function streamBodyFor(action: string): Promise<string> {
  const request = new NextRequest('http://localhost/api/services/media/action-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const response = await POST(request, { params: Promise.resolve({ name: 'media' }) } as any);
  return await response.text();
}

/** Render the modal against a canned stream body and settle. */
async function renderModalWith(action: any, body: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })));
  render(
    <ActionProgressModal
      isOpen
      onClose={() => {}}
      serviceName="media"
      action={action}
      onComplete={() => {}}
    />,
  );
  // The footer only renders once the action has left the 'running' state.
  await waitFor(() => expect(screen.getByText('Close')).toBeDefined());
}

const RECOVERY_AFFORDANCES = ['Retry Action', 'View Full Logs', 'Self-Diagnose', 'Copy Details for AI'];

beforeEach(() => {
  written.length = 0;
  execSafe.mockReset();
  execSafe.mockImplementation(async () => ({ stdout: '', stderr: '', code: 0 }));
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CLASS GATE B — streamed action outcome truth (#2942)', () => {
  it('the route enumerates the SHARED action const, so this gate cannot go stale', () => {
    const src = fs.readFileSync(ROUTE_FILE, 'utf-8');
    expect(
      /z\.enum\(\s*SERVICE_STREAM_ACTIONS\s*\)/.test(src),
      'action-stream/route.ts must build its action enum from SERVICE_STREAM_ACTIONS. ' +
      'A hard-coded literal list would let a new streamed action ship uncovered by this gate — ' +
      'which is exactly how the per-call-site fix in 642308d2 came back.',
    ).toBe(true);
    expect(SERVICE_STREAM_ACTIONS.length).toBeGreaterThan(0);
  });

  // The enumeration. Not a list of the actions we happen to know about today.
  for (const action of SERVICE_STREAM_ACTIONS) {
    describe(`action "${action}"`, () => {
      it('a failing unit ends in the error state with every recovery affordance reachable', async () => {
        execSafe.mockImplementation(async (argv: string[]) => {
          if (argv[0] === 'systemctl') throw new Error(`Job for media.service failed (${argv.join(' ')})`);
          return { stdout: '', stderr: '', code: 0 };
        });

        const body = await streamBodyFor(action);
        await renderModalWith(action, body);

        // What the operator sees is the assertion that matters.
        expect(screen.queryByText(/Operation completed successfully/)).toBeNull();
        for (const label of RECOVERY_AFFORDANCES) {
          expect(screen.getByText(label), `${label} must be reachable after a failed ${action}`).toBeDefined();
        }
        // …and it is driven by the marker, not by the stream ending.
        expect(body).toContain(ACTION_STREAM_MARKER);
        expect(body).toContain('"type":"error"');
        // The marker is machine-readable plumbing — it must never be printed.
        expect(written.join('')).not.toContain(ACTION_STREAM_MARKER);
      });

      it('a stream that just ends, with no marker, is a failure and not a success', async () => {
        await renderModalWith(action, `Doing the ${action}...\r\nsome output\r\n`);

        expect(screen.queryByText(/Operation completed successfully/)).toBeNull();
        for (const label of RECOVERY_AFFORDANCES) {
          expect(screen.getByText(label)).toBeDefined();
        }
      });

      it('a succeeding unit still ends in the success state', async () => {
        const body = await streamBodyFor(action);
        expect(body).toContain(encodeActionStreamResult({ type: 'complete', success: true }).trim());

        await renderModalWith(action, body);

        expect(screen.getByText(/Operation completed successfully/)).toBeDefined();
        expect(screen.queryByText('Retry Action')).toBeNull();
      });
    });
  }
});
