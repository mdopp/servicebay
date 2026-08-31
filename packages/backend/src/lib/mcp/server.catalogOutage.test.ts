/**
 * A broken assist-catalog delivery must not take the MCP surface with it
 * (#2706 — fix-forward on the #2701 delivery work, d01054f5).
 *
 * #2701's contract is right and stays: a delivery that failed answers LOUDLY
 * rather than serving a stale tree. What was wrong is the blast radius. The
 * prompt half of the catalog (`registerAssistPrompts`) is built on EVERY /mcp
 * request, before the transport is connected, so a catalog read that throws
 * escaped ahead of `connect()` and came out of `server.ts` as a bare HTTP 500 —
 * on `initialize`, i.e. before any tool is even named. That killed
 * `list_containers`, `get_logs`, `deploy_service` and, most expensively,
 * `set_channel`: with the box on `:dev` and /mcp dead, the flip back to
 * `:latest` was no longer reachable. A fault in the catalog must not take the
 * road you repair it from.
 *
 * So these cases drive the REAL loader against a REAL (corrupt) delivery state
 * on disk — no catalog mock — and assert both halves at once:
 *   - `initialize` completes and the non-catalog tools stay callable, and
 *   - the catalog tools still report the outage, and never answer from the
 *     stale tree that is deliberately left lying next to the corrupt state.
 *
 * The three corruption shapes are the ones a half-written file actually takes:
 * empty, truncated mid-write, and well-formed JSON that says something else.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.hoisted(() => {
  process.env.DATA_DIR = '/tmp/sb-mcp-catalog-outage-test';
  // The suite normally points ASSIST_CATALOG_DIR at the repo checkout, which
  // bypasses delivery entirely. These cases are ABOUT delivery, so it goes.
  delete process.env.ASSIST_CATALOG_DIR;
});

const BASE = '/tmp/sb-mcp-catalog-outage-test';
const STATE_FILE = path.join(BASE, 'assist-catalog', 'delivery.json');

// Keep the mutation gate permissive so `set_channel` reaches its handler — the
// point here is whether the tool is REACHABLE during a catalog outage.
vi.mock('./safety', () => ({
  guardMutation: vi.fn(async () => null),
  guardExec: vi.fn(async () => null),
  snapshotBeforeMutation: vi.fn(async () => undefined),
}));

vi.mock('@/lib/nodes', () => ({
  listNodes: vi.fn(async () => [{ Name: 'box', URI: '', Default: true }]),
  getNodeConnection: vi.fn(),
}));

const setServicebayChannel = vi.fn(async () => undefined);
vi.mock('@/lib/servicebayChannel', () => ({
  getServicebayChannel: vi.fn(async () => 'dev'),
  setServicebayChannel: (...a: unknown[]) => setServicebayChannel(...(a as [])),
}));

/**
 * Build + connect a server exactly the way `server.ts`'s /mcp handler does:
 * `createMcpServer()`, then `await registerAssistPrompts(__baseServer)`, then
 * connect. The `initialize` handshake happens inside `client.connect()`, so a
 * throw anywhere in that sequence is precisely the 500 the box served.
 */
async function connectLikeTheMcpEndpoint() {
  const { createMcpServer } = await import('./server');
  const { registerAssistPrompts } = await import('./assistCatalog');
  const server = createMcpServer({ auth: { user: 'test', scopes: ['read', 'lifecycle', 'mutate'] } });
  await registerAssistPrompts(server.__baseServer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function firstText(res: unknown): string {
  const content = (res as { content: Array<{ text: string }> }).content;
  return content[0].text;
}

/** A tree that WOULD be served if the gate ever fell back to "whatever is there". */
async function seedStaleTree(): Promise<void> {
  const dir = path.join(BASE, 'assist-catalog', 'checkout', 'assists');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'stale-entry.md'),
    '---\ntitle: Stale\nwhenToUse: never — this tree is not vouched for\nkind: guide\n---\nbody\n',
    'utf-8',
  );
}

async function writeCorruptState(raw: string): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, raw, 'utf-8');
}

const CORRUPTIONS: Array<{ name: string; raw: string }> = [
  { name: 'an empty file', raw: '' },
  {
    name: 'a truncated, half-written JSON object',
    raw: '{\n  "lastAttemptAt": "2026-08-31T09:00:00.000Z",\n  "lastSucce',
  },
  {
    name: 'well-formed JSON with entirely the wrong fields',
    raw: JSON.stringify({ delivered: true, when: 'recently', entries: 42 }),
  },
  {
    name: 'well-formed JSON claiming a success with an unparseable timestamp',
    raw: JSON.stringify({ lastSuccessAt: 'yesterday', sha: 'deadbeef', entryCount: 1, lastError: null }),
  },
];

beforeEach(async () => {
  // Only the delivery root is reset between cases; `maxRetries` because a
  // recursive rm of a tree the test just wrote can lose a race with the OS and
  // report ENOTEMPTY.
  await fs.rm(path.join(BASE, 'assist-catalog'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  setServicebayChannel.mockClear();
  delete process.env.ASSIST_CATALOG_DIR;
  delete process.env.ASSIST_CATALOG_MAX_AGE_HOURS;
});

afterAll(async () => {
  await fs.rm(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('a corrupt delivery.json does not take down the MCP surface (#2706)', () => {
  for (const { name, raw } of CORRUPTIONS) {
    describe(`delivery.json is ${name}`, () => {
      beforeEach(async () => {
        await seedStaleTree();
        await writeCorruptState(raw);
      });

      it('completes the initialize handshake', async () => {
        const client = await connectLikeTheMcpEndpoint();
        expect(client.getServerVersion()?.name).toBe('servicebay');
        await client.close();
      });

      it('still advertises and dispatches the non-catalog tools', async () => {
        const client = await connectLikeTheMcpEndpoint();
        const names = (await client.listTools()).tools.map(t => t.name);
        expect(names).toContain('set_channel');
        expect(names).toContain('list_containers');
        expect(names).toContain('get_logs');
        await client.close();
      });

      // The expensive consequence of the regression: `set_channel` is the road
      // back from a `:dev` flip, and it runs over the same /mcp surface the
      // catalog killed. It must not depend on catalog delivery at all.
      it('lets set_channel flip the box back', async () => {
        const client = await connectLikeTheMcpEndpoint();
        const res = await client.callTool({ name: 'set_channel', arguments: { channel: 'latest' } });
        expect((res as { isError?: boolean }).isError).not.toBe(true);
        expect(setServicebayChannel).toHaveBeenCalledWith('latest');
        await client.close();
      });

      // #2701's promise stays intact: the catalog says it is broken. It must
      // not go quiet, and it must not answer from the stale tree on disk.
      it('makes the catalog tools report the outage, not answer from the old tree', async () => {
        const client = await connectLikeTheMcpEndpoint();
        const res = await client.callTool({ name: 'list_assists', arguments: {} });
        expect((res as { isError?: boolean }).isError).toBe(true);
        const text = firstText(res);
        expect(text).not.toContain('stale-entry');
        expect(text).toMatch(/deliver/i);
        await client.close();
      });
    });
  }
});
