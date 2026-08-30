import { describe, it, expect } from 'vitest';
import { redactStructuredLogLine, summarizeStateForLog } from './handler';

// Every fixture here is synthetic — no value from a live box belongs in a
// committed test (CLAUDE.md, secret hygiene).

/**
 * One container record in the shape the agent's state sync actually ships:
 * the full podman-inspect view, with the OCI label block, ports and mounts
 * that make it ~2 KB per container before anything else is counted.
 */
function containerRecord(i: number): Record<string, unknown> {
  return {
    id: `${i}`.padStart(2, '0').repeat(32).slice(0, 64),
    names: [`svc${i}-app`],
    image: `ghcr.io/example/app-${i}:1.2.3`,
    imageId: `sha256:${`${i}`.repeat(64).slice(0, 64)}`,
    state: 'running',
    status: 'Up 3 days',
    createdAt: '2026-06-09T20:48:37.393537573Z',
    startedAt: '2026-08-27T05:12:11.100000000Z',
    command: ['/init', '--config', `/config/app-${i}.yaml`],
    ports: [
      { host_ip: '0.0.0.0', container_port: 8080, host_port: 18080 + i, range: 1, protocol: 'tcp' },
      { host_ip: '::', container_port: 8443, host_port: 18443 + i, range: 1, protocol: 'tcp' },
    ],
    mounts: [
      { Type: 'bind', Source: `/var/mnt/data/app-${i}/config`, Destination: '/config', RW: true, Options: ['rbind'] },
      { Type: 'bind', Source: `/var/mnt/data/app-${i}/media`, Destination: '/media', RW: false, Options: ['rbind', 'ro'] },
    ],
    labels: {
      'org.opencontainers.image.created': '2026-07-01T00:00:00Z',
      'org.opencontainers.image.description':
        `[App ${i}](http://example.invalid/app-${i}) is a long-winded upstream description that upstream ships as an OCI label, repeated verbatim in every single state sync.`,
      'org.opencontainers.image.licenses': 'GPL-3.0-only',
      'org.opencontainers.image.revision': `${i}`.repeat(40).slice(0, 40),
      'org.opencontainers.image.source': `https://github.com/example/app-${i}`,
      'org.opencontainers.image.title': `App ${i}`,
      'org.opencontainers.image.url': `https://example.invalid/app-${i}/overview.html`,
      'org.opencontainers.image.vendor': 'Example',
      'org.opencontainers.image.version': `v1.2.${i}`,
      'servicebay.role': 'app',
    },
    networks: [],
    isHostNetwork: false,
    podId: `${i}`.repeat(64).slice(0, 64),
    podName: `svc${i}`,
    isInfra: false,
    pid: 594139 + i,
  };
}

/** The line the agent emits for a `containers` state sync. */
function containersSyncLine(count: number): string {
  return JSON.stringify({
    event: 'SYNC_PARTIAL',
    payload: { containers: Array.from({ length: count }, (_, i) => containerRecord(i)) },
    runId: 'run-1',
    sessionId: 'servicebay-x',
  });
}

describe('summarizeStateForLog — the state sync stops dumping the whole state (#2676)', () => {
  it('cuts a realistic container sync by well over 90%', () => {
    // The measured shape on the box: ~46 KB per `containers` message, 3.4 MB
    // over 30 minutes, against 228 KB for every other ServiceBay line put
    // together. This is that reduction, asserted in-process.
    const before = containersSyncLine(24);
    const after = redactStructuredLogLine(before) as string;
    expect(after).not.toBeNull();
    expect(before.length).toBeGreaterThan(20_000);
    expect(after.length).toBeLessThan(before.length * 0.05);
    expect(after.length).toBeLessThan(1_000);
  });

  it('keeps the line worth reading — the event, the count and who was covered', () => {
    const out = JSON.parse(redactStructuredLogLine(containersSyncLine(3)) as string);
    expect(out.event).toBe('SYNC_PARTIAL');
    expect(out.payload.containers).toEqual({ count: 3, items: ['svc0-app', 'svc1-app', 'svc2-app'] });
    expect(out.runId).toBe('run-1');
  });

  it('drops the OCI label block that carried most of the bytes', () => {
    const after = redactStructuredLogLine(containersSyncLine(4)) as string;
    expect(after).not.toContain('org.opencontainers.image');
    expect(after).not.toContain('Mountpoint');
    expect(after).not.toContain('/var/mnt/data');
  });

  it('reports a remainder instead of listing every record of a long list', () => {
    const out = JSON.parse(redactStructuredLogLine(containersSyncLine(40)) as string);
    expect(out.payload.containers.count).toBe(40);
    expect(out.payload.containers.items).toHaveLength(25);
    expect(out.payload.containers.omitted).toBe(15);
  });

  it('names each record by whichever key that payload uses', () => {
    const out = summarizeStateForLog({
      services: [{ name: 'adguard', id: 'adguard', activeState: 'active' }],
      volumes: [{ Name: 'v0', Driver: 'local', Mountpoint: '/var/mnt/x' }],
      proxyRoutes: [{ host: 'admin.example.invalid', targetPort: 5888, ssl: true }],
      anonymous: [{ activeState: 'active' }],
    }) as Record<string, { items: unknown[] }>;
    expect(out.services.items).toEqual(['adguard']);
    expect(out.volumes.items).toEqual(['v0']);
    expect(out.proxyRoutes.items).toEqual(['admin.example.invalid']);
    expect(out.anonymous.items).toEqual(['<unnamed>']);
  });

  it('passes scalars through, so initialSyncComplete still reads as itself', () => {
    expect(summarizeStateForLog({ initialSyncComplete: true })).toEqual({ initialSyncComplete: true });
  });

  it('is idempotent — both sinks summarise, and the second pass must not nest', () => {
    const once = summarizeStateForLog({ containers: [{ names: ['a'] }, { names: ['b'] }] });
    expect(summarizeStateForLog(once)).toEqual(once);
    expect(once).toEqual({ containers: { count: 2, items: ['a', 'b'] } });
  });

  it('terminates on a pathologically deep payload', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deep: any = {};
    let node = deep;
    for (let i = 0; i < 40; i++) { node.next = {}; node = node.next; }
    node.leaf = 'bottom';
    expect(JSON.stringify(summarizeStateForLog(deep))).toContain('max depth');
  });
});

describe('the summary keeps the #2603 leak probe working', () => {
  const FAKE_SECRET = 'PLACEHOLDER-NOT-A-REAL-SECRET';
  const QUADLET = `[Container]\nImage=ghcr.io/example/app:1\nEnvironment=SSO_CLIENT_SECRET=${FAKE_SECRET}\n`;
  const QUADLET_PATH = '/var/home/core/.config/containers/systemd/servicebay.container';

  /** The exact line the agent emits for a `files` state sync. */
  function filesSyncLine(): string {
    return JSON.stringify({
      event: 'SYNC_PARTIAL',
      payload: { files: { [QUADLET_PATH]: { path: QUADLET_PATH, content: QUADLET, modified: 1 } } },
    });
  }

  it('leaves files structurally intact, so the probe still has a content field to judge', () => {
    // Summarising `files` away — or capping the rendered line, which would
    // leave half a JSON object — would give the probe nothing to assert on
    // and turn it green for the wrong reason.
    const out = JSON.parse(redactStructuredLogLine(filesSyncLine()) as string);
    expect(Object.keys(out.payload.files)).toEqual([QUADLET_PATH]);
    expect(out.payload.files[QUADLET_PATH].content).toBe(`<${QUADLET.length} chars redacted>`);
  });

  it('still renders parseable JSON for a mixed payload', () => {
    const line = JSON.stringify({
      event: 'SYNC_PARTIAL',
      payload: {
        files: { [QUADLET_PATH]: { content: QUADLET } },
        containers: Array.from({ length: 24 }, (_, i) => containerRecord(i)),
      },
    });
    const out = redactStructuredLogLine(line) as string;
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toContain(FAKE_SECRET);
    expect(JSON.parse(out).payload.containers.count).toBe(24);
  });
});
