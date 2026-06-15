import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decideAdvancedConfigReconcile, patchProxyHostAdvancedConfig } from './route';

vi.mock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The forward-auth snippet (abbreviated) is what marks a host as
// ServiceBay-OWNED — the install runner expands the
// `__authelia_forward_auth__` sentinel into this before it reaches NPM.
const FORWARD_AUTH = 'auth_request /authelia;\nerror_page 401 =302 $redirect;';
const SSE_EXTRAS = 'proxy_buffering off;\nproxy_read_timeout 600s;';

describe('decideAdvancedConfigReconcile', () => {
    it('skips when the rendered config is empty', () => {
        expect(decideAdvancedConfigReconcile('anything', '')).toEqual({ skip: true });
    });

    it('skips when live and rendered are identical', () => {
        expect(decideAdvancedConfigReconcile(FORWARD_AUTH, FORWARD_AUTH)).toEqual({ skip: true });
    });

    // #1862 — the regression: an existing host that ALREADY has forward-auth
    // but whose template now appends SSE/timeout extras. The old guard only
    // fired when forward-auth was *missing*, so these extras were dropped.
    it('lands the rendered config when appended extras differ on an existing forward-auth host (#1862)', () => {
        const live = FORWARD_AUTH;
        const rendered = `${FORWARD_AUTH}\n${SSE_EXTRAS}`;
        const res = decideAdvancedConfigReconcile(live, rendered);
        expect('write' in res).toBe(true);
        const written = (res as { write: string }).write;
        // The new directives land verbatim...
        expect(written).toContain('proxy_buffering off;');
        expect(written).toContain('proxy_read_timeout 600s;');
        // ...and forward-auth stays intact (no regression).
        expect(written).toContain('auth_request /authelia;');
        expect(written).toBe(rendered);
    });

    it('lands the full rendered config when forward-auth is newly added (legacy #991)', () => {
        const res = decideAdvancedConfigReconcile('client_max_body_size 0;', `${FORWARD_AUTH}\n${SSE_EXTRAS}`);
        expect('write' in res).toBe(true);
        expect((res as { write: string }).write).toBe(`${FORWARD_AUTH}\n${SSE_EXTRAS}`);
    });

    // The manual-edit preservation guarantee: a host WITHOUT forward-auth in
    // its rendered config is NOT SB-owned — we never clobber operator edits.
    it('preserves manual edits on a non-SB-owned host (no forward-auth, no explainer)', () => {
        const live = 'proxy_set_header X-Custom 1;\nclient_max_body_size 0;';
        const rendered = 'client_max_body_size 100m;';
        expect(decideAdvancedConfigReconcile(live, rendered)).toEqual({ skip: true });
    });

    // #1415 — the LAN-only explainer is the one thing we append (not clobber)
    // onto a non-SB-owned host whose config predates it.
    it('appends the LAN explainer to an existing non-forward-auth host, preserving its edits (#1415)', () => {
        const live = 'client_max_body_size 0;';
        const rendered = 'servicebay-lan-only-explainer\nclient_max_body_size 0;';
        const res = decideAdvancedConfigReconcile(live, rendered);
        expect('write' in res).toBe(true);
        const written = (res as { write: string }).write;
        // withLanDeniedPage appends the explainer onto the EXISTING config,
        // so the operator's directive survives.
        expect(written).toContain('client_max_body_size 0;');
        expect(written).toContain('servicebay-lan-only-explainer');
    });
});

describe('patchProxyHostAdvancedConfig (NPM PUT wrapper)', () => {
    const FORWARD_AUTH = 'auth_request /authelia;\nerror_page 401 =302 $redirect;';
    const RENDERED = `${FORWARD_AUTH}\nproxy_buffering off;\nproxy_read_timeout 600s;`;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('skips the PUT entirely when the decision is skip (no diff)', async () => {
        const res = await patchProxyHostAdvancedConfig('http://npm', 'tok', 7, FORWARD_AUTH, FORWARD_AUTH, 'chat.dopp.cloud');
        expect(res).toEqual({ updated: false });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('PUTs the reconciled config and reports updated on success (#1862)', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
        const res = await patchProxyHostAdvancedConfig('http://npm', 'tok', 7, FORWARD_AUTH, RENDERED, 'chat.dopp.cloud');
        expect(res).toEqual({ updated: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe('http://npm/api/nginx/proxy-hosts/7');
        expect((opts as RequestInit).method).toBe('PUT');
        // The appended SSE/timeout extras reach NPM verbatim.
        const body = JSON.parse((opts as RequestInit).body as string);
        expect(body.advanced_config).toBe(RENDERED);
    });

    it('reports not-updated when NPM returns a non-ok status', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
        const res = await patchProxyHostAdvancedConfig('http://npm', 'tok', 7, FORWARD_AUTH, RENDERED, 'chat.dopp.cloud');
        expect(res).toEqual({ updated: false });
    });

    it('swallows a fetch error and reports not-updated (non-fatal)', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));
        const res = await patchProxyHostAdvancedConfig('http://npm', 'tok', 7, FORWARD_AUTH, RENDERED, 'chat.dopp.cloud');
        expect(res).toEqual({ updated: false });
    });
});
