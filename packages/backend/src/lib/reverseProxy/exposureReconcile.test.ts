/**
 * #2933 — CLASS GATE for proxy-host exposure.
 *
 * The bug this locks down: `createOrReconcileProxyHost` passed `accessListId`
 * only in the CREATE body. Re-provisioning an EXISTING host therefore
 * converged its upstream and its `advanced_config` but left NPM's
 * `access_list_id` exactly as it was — so a `lan`/`internal` route that was
 * already open stayed open, while `lanRestricted` (computed from the REQUEST,
 * before NPM was touched) told the summary, the MCP tool response and the log
 * line that it was gated. "Erfolg gemeldet, nichts getan", applied to network
 * exposure.
 *
 * The gate is table-driven over `PROXY_EXPOSURES` — the exposure contract in
 * `lib/config.ts` — and not over a hand-picked subset: adding a tier there
 * without wiring the reconcile fails `EXPECTED covers every tier` immediately,
 * before anyone can ship an unclassified (i.e. open) route.
 *
 * NPM is a real in-memory table here, not a call spy: the assertion is what
 * the proxy HOLDS after the call, which is the only thing the issue is about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROXY_EXPOSURES, type ProxyExposure } from '@/lib/config';
import type { NpmProxyHost } from '@/lib/npm/proxyHosts';

const DOMAIN = 'dns.example.test';
const LAN_LIST_ID = 7;
const NODE_IP = '192.168.178.100';

/** The fake NPM: one proxy-host table plus what was written to it. */
const npm = vi.hoisted(() => ({
    hosts: new Map<number, Record<string, unknown>>(),
    nextId: 1,
    /** `null` = NPM could not give us the LAN-only access list. */
    lanAccessListId: 7 as number | null,
    /** Set to make the read-back fail (an unreadable row). */
    readable: true,
    /** Domains a Let's Encrypt cert was requested for. */
    certRequests: [] as string[],
    puts: [] as { id: number; patch: Record<string, unknown> }[],
    creates: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/agent/manager', () => ({
    agentManager: { getAgent: () => ({ sendCommand: async () => ({ result: 'ok' }) }) },
}));
vi.mock('@/lib/nodes', () => ({ listNodes: async () => [{ Name: 'Local' }] }));
vi.mock('@/lib/health/domainChecks', () => ({ syncDomainChecks: async () => undefined }));
vi.mock('@/lib/health/dnsRoutingChecks', () => ({ syncDnsRoutingChecks: async () => undefined }));
vi.mock('@/lib/config', async importActual => {
    // The exposure CONTRACT must come from the real module — that is the
    // whole point of the gate. Only the persisted config is stubbed.
    const actual = await importActual<typeof import('@/lib/config')>();
    return {
        ...actual,
        getConfig: async () => ({ reverseProxy: { hosts: [], npm: { email: 'ops@example.test' } } }),
        updateConfig: async () => undefined,
    };
});
vi.mock('@/lib/npm/client', () => ({
    findNpmAdmin: async () => ({ apiUrl: 'http://npm.test', nodeIp: NODE_IP, nodeName: 'Local' }),
    getNpmToken: async () => 'npm-test-token',
}));
vi.mock('@/lib/npm/accessLists', () => ({
    ensureLanAccessList: async () => npm.lanAccessListId,
    LAN_ACCESS_LIST_NAME: 'ServiceBay LAN only',
}));
vi.mock('@/lib/npm/certs', () => ({
    listCertificates: async () => ({ ok: false, status: 404, body: '' }),
    requestLetsEncryptCert: async (_url: string, _t: string, domain: string) => {
        npm.certRequests.push(domain);
        return { ok: true, status: 201, data: { id: 99 }, body: '' };
    },
    bindCertToProxyHost: async () => ({ ok: true, status: 200 }),
}));
vi.mock('@/lib/npm/proxyHosts', () => ({
    findProxyHostByDomain: async (_url: string, _t: string, domain: string) => {
        for (const [id, h] of npm.hosts) {
            if ((h.domain_names as string[] | undefined)?.includes(domain)) return { id, ...h };
        }
        return null;
    },
    createProxyHost: async (_url: string, _t: string, body: Record<string, unknown>) => {
        const id = npm.nextId++;
        npm.creates.push(body);
        npm.hosts.set(id, { ...body, meta: { nginx_online: true } });
        return { ok: true, status: 201, data: { id }, body: '' };
    },
    // NPM merges a PUT into the existing row — modelled exactly, so a patch
    // that omits `access_list_id` leaves the old gate in place (which is the
    // injected-old-behaviour case the mutation proof exercises).
    updateProxyHost: async (_url: string, _t: string, id: number, patch: Record<string, unknown>) => {
        npm.puts.push({ id, patch });
        const row = npm.hosts.get(id);
        if (!row) return { ok: false, status: 404 };
        npm.hosts.set(id, { ...row, ...patch });
        return { ok: true, status: 200 };
    },
    readAccessListId: async (_url: string, _t: string, id: number) => {
        if (!npm.readable) return { ok: false as const, reason: 'NPM GET returned 500' };
        const row = npm.hosts.get(id);
        if (!row) return { ok: false as const, reason: 'no such host' };
        return { ok: true as const, accessListId: (row.access_list_id as number | undefined) ?? 0 };
    },
    checkNginxOnline: async () => ({ online: true }),
    listProxyHosts: async () => ({ ok: true, status: 200, data: [], body: '' }),
    deleteProxyHost: async () => ({ ok: true, status: 200 }),
}));

/**
 * The expectation table — written by hand, NOT derived from the production
 * mapping, so it is a real second opinion rather than a mirror. `accessListId`
 * is what NPM must hold when the batch's LAN list is id 7.
 */
const EXPECTED: Record<ProxyExposure, { accessListId: number; lanRestricted: boolean }> = {
    public: { accessListId: 0, lanRestricted: false },
    internal: { accessListId: LAN_LIST_ID, lanRestricted: true },
    lan: { accessListId: LAN_LIST_ID, lanRestricted: true },
};

/** Seed NPM with a PRE-EXISTING host carrying the WRONG gate for `exposure`,
 *  so only the reconcile path (never the create path) can fix it. */
function seedExistingHost(wrongAccessListId: number): number {
    const id = npm.nextId++;
    npm.hosts.set(id, {
        domain_names: [DOMAIN],
        forward_host: NODE_IP,
        forward_port: 8080,
        access_list_id: wrongAccessListId,
        advanced_config: '',
        certificate_id: 0,
        meta: { nginx_online: true },
    });
    return id;
}

async function provision(exposure: ProxyExposure | undefined) {
    const { provisionProxyHosts } = await import('./proxyHostProvisioning');
    return provisionProxyHosts({
        hosts: [{ domain: DOMAIN, forwardPort: 8080, service: 'dns', ...(exposure ? { exposure } : {}) }],
        node: 'Local',
    });
}

const liveRow = (id: number) => npm.hosts.get(id) as NpmProxyHost & Record<string, unknown>;

beforeEach(() => {
    npm.hosts.clear();
    npm.nextId = 1;
    npm.lanAccessListId = LAN_LIST_ID;
    npm.readable = true;
    npm.certRequests = [];
    npm.puts = [];
    npm.creates = [];
});

describe('#2933 exposure reconcile — the class gate', () => {
    it('EXPECTED covers every tier of the exposure contract in config.ts', () => {
        // The gate that makes a NEW exposure value red on arrival: whoever
        // adds one must state here what NPM has to hold for it, which forces
        // them through the reconcile wiring in proxyHostPolicy.ts.
        expect(Object.keys(EXPECTED).sort()).toEqual([...PROXY_EXPOSURES].sort());
    });

    for (const exposure of PROXY_EXPOSURES) {
        const want = EXPECTED[exposure];

        it(`exposure "${exposure}": a PRE-EXISTING host converges to access_list_id=${want.accessListId}`, async () => {
            // Seed the opposite of what this tier wants, so a create-only
            // `access_list_id` (the #2933 bug) cannot pass this test.
            const id = seedExistingHost(want.accessListId === 0 ? LAN_LIST_ID : 0);
            const result = await provision(exposure);

            expect(result.kind).toBe('ok');
            // NPM HOLDS the right gate — read out of the table, not off a spy.
            expect(liveRow(id).access_list_id).toBe(want.accessListId);
            // Nothing was created: this is the reconcile path.
            expect(npm.creates).toEqual([]);
        });

        it(`exposure "${exposure}": the reported lanRestricted is ${want.lanRestricted}`, async () => {
            seedExistingHost(want.accessListId === 0 ? LAN_LIST_ID : 0);
            const result = await provision(exposure);
            if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);

            expect(result.success).toBe(true);
            expect(result.failed).toEqual([]);
            expect(result.lanRestricted.includes(DOMAIN)).toBe(want.lanRestricted);
        });

        it(`exposure "${exposure}": an already-correct host is left alone (idempotent)`, async () => {
            const id = seedExistingHost(want.accessListId);
            await provision(exposure);
            expect(liveRow(id).access_list_id).toBe(want.accessListId);
            // No access-list PUT when live already matches.
            expect(npm.puts.filter(p => 'access_list_id' in p.patch)).toEqual([]);
        });
    }

    it('a missing exposure resolves to the LAN gate, never to open', async () => {
        // The diagnose "Retry create" shape: no exposure in the request. It
        // used to mean `access_list_id: 0` — the console published to the
        // internet with `lanRestricted: true` in the summary.
        const id = seedExistingHost(0);
        const result = await provision(undefined);
        if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
        expect(liveRow(id).access_list_id).toBe(LAN_LIST_ID);
        expect(result.lanRestricted).toContain(DOMAIN);
    });

    it('fails loudly and touches nothing when the LAN access list is unavailable', async () => {
        npm.lanAccessListId = null;
        const id = seedExistingHost(0);
        const result = await provision('internal');
        if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);

        expect(result.success).toBe(false);
        expect(result.failed[0]?.domain).toBe(DOMAIN);
        expect(result.failed[0]?.error).toMatch(/refusing to publish the host without its IP gate/i);
        // Not reported as restricted, and NOT published either — including no
        // Let's Encrypt cert, which is what used to make an `internal` host
        // serve real HTTPS to the whole internet with no gate.
        expect(result.lanRestricted).not.toContain(DOMAIN);
        expect(liveRow(id).access_list_id).toBe(0);
        expect(npm.puts).toEqual([]);
        expect(npm.certRequests).toEqual([]);
    });

    it('an exposure outside the contract throws instead of resolving to open', async () => {
        // Defence in depth for the same rule the table encodes: a value we
        // cannot classify must abort, because the fall-through would be "no
        // access list" — the widest possible answer to an unknown question.
        const { requiresLanAccessList, decideAccessListId } = await import('./proxyHostPolicy');
        const bogus = 'vpn-only' as ProxyExposure;
        expect(() => requiresLanAccessList(bogus)).toThrow(/unknown proxy exposure/i);
        expect(() => decideAccessListId(bogus, LAN_LIST_ID)).toThrow(/unknown proxy exposure/i);
    });

    it('an unreadable NPM row is never reported as restricted', async () => {
        seedExistingHost(0);
        npm.readable = false;
        const result = await provision('lan');
        if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);

        expect(result.success).toBe(false);
        expect(result.failed[0]?.error).toMatch(/unconfirmed/i);
        expect(result.lanRestricted).not.toContain(DOMAIN);
    });
});
