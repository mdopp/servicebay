/**
 * #2782 — `getNodeContainers` wire contract.
 *
 * `GET /api/containers?node=` returns `agent.sendCommand('listContainers')`
 * verbatim, and the V4 agent hands back the **camelCase** `EnrichedContainer`
 * shape it builds in `agent/v4/agent.py`'s `fetch_containers`
 * (`packages/backend/src/lib/agent/types.ts`), *not* podman's raw
 * `Id`/`Names`/`Image`. The schema used to declare the capitalized shape, so
 * every call threw a `TypedFetchError` and the health-check Add-modal's
 * podman picker rendered zero options on the real box.
 *
 * The fixture below is one row in that real shape — every key the agent emits,
 * so a future field addition is the only thing that can make it drift.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { getNodeContainers, TypedFetchError } from './index';

/** One `EnrichedContainer` as the V4 agent emits it (lowercase id/names/image). */
const AGENT_ROW = {
  id: '9f1c2a3b4d5e6f70819a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
  names: ['media-jellyfin'],
  image: 'docker.io/jellyfin/jellyfin:latest',
  state: 'running',
  status: 'Up 3 days',
  created: 1756800000,
  ports: [{ hostPort: 8096, containerPort: 8096, protocol: 'tcp' }],
  mounts: [],
  labels: { 'io.servicebay.service': 'media' },
  networks: ['podman'],
  isHostNetwork: false,
  podId: 'a1b2c3d4e5f6',
  podName: 'media',
  isInfra: false,
  pid: 4242,
};

function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('getNodeContainers (GET /api/containers?node=)', () => {
  it('accepts the real lowercase agent shape instead of throwing TypedFetchError', async () => {
    stubFetch([AGENT_ROW]);
    const containers = await getNodeContainers('Local');
    expect(containers).toHaveLength(1);
    expect(containers[0].id).toBe(AGENT_ROW.id);
    expect(containers[0].names?.[0]).toBe('media-jellyfin');
    expect(containers[0].image).toBe('docker.io/jellyfin/jellyfin:latest');
  });

  it('keeps the rest of EnrichedContainer through passthrough', async () => {
    stubFetch([AGENT_ROW]);
    const [c] = await getNodeContainers('Local');
    expect((c as Record<string, unknown>).state).toBe('running');
    expect((c as Record<string, unknown>).podName).toBe('media');
  });

  it('rejects the old capitalized podman shape — it is not what the route serves', async () => {
    stubFetch([{ Id: 'abc', Names: ['media-jellyfin'], Image: 'jellyfin' }]);
    // Lenient list read: the unparseable row is dropped, the call still resolves.
    await expect(getNodeContainers('Local')).resolves.toEqual([]);
  });

  it('one odd row does not empty the whole picker (per-row lenient read)', async () => {
    stubFetch([AGENT_ROW, { names: ['no-id-row'] }, { ...AGENT_ROW, id: 'second', names: ['web'] }]);
    const containers = await getNodeContainers('Local');
    expect(containers.map(c => c.names?.[0])).toEqual(['media-jellyfin', 'web']);
  });

  it('a row with no names still parses (the picker falls back to the id)', async () => {
    stubFetch([{ id: 'nameless', names: [] }]);
    const containers = await getNodeContainers('Local');
    expect(containers).toHaveLength(1);
    expect(containers[0].names).toEqual([]);
  });

  it('still throws when the route serves a non-array body', async () => {
    stubFetch({ error: 'Agent not found' });
    await expect(getNodeContainers('Local')).rejects.toBeInstanceOf(TypedFetchError);
  });
});
