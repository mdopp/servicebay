import { describe, it, expect } from 'vitest';
import { decideUpstreamReconcile } from './route';

// #2364 (completes #2357) — a radicale redeploy must re-point the EXISTING
// caldav.<domain> proxy host from the (now-closed) LAN address to
// 127.0.0.1:5232, because the DAV port publish moved to loopback-only
// (`loopbackOnly: true`). `buildProxyHosts` emits `forwardHost: '127.0.0.1'`
// for such a host, and `createProxyHost`'s existing-host branch feeds it here.
// This exercises the reconcile DECISION (the re-point-or-not gate) without
// standing up NPM's HTTP API.
describe('decideUpstreamReconcile', () => {
    it('re-points an existing caldav host from the LAN IP to loopback on redeploy (#2364)', () => {
        const d = decideUpstreamReconcile('127.0.0.1', 5232, '192.168.178.100', 5232);
        expect(d.changed).toBe(true);
        if (d.changed) {
            expect(d.from).toBe('192.168.178.100:5232');
            expect(d.to).toBe('127.0.0.1:5232');
        }
    });

    it('is idempotent: an already-loopback host on the same port is a no-op', () => {
        expect(decideUpstreamReconcile('127.0.0.1', 5232, '127.0.0.1', 5232)).toEqual({ changed: false });
    });

    it('re-points when only the port changed (#1178 — new template takes over a domain)', () => {
        const d = decideUpstreamReconcile('127.0.0.1', 8080, '127.0.0.1', 3000);
        expect(d.changed).toBe(true);
        if (d.changed) expect(d.to).toBe('127.0.0.1:8080');
    });

    it('re-points when both host and port differ', () => {
        const d = decideUpstreamReconcile('127.0.0.1', 5232, '192.168.178.100', 5000);
        expect(d.changed).toBe(true);
        if (d.changed) {
            expect(d.from).toBe('192.168.178.100:5000');
            expect(d.to).toBe('127.0.0.1:5232');
        }
    });

    it('renders "?" placeholders when the live target is unknown (host never seen before)', () => {
        const d = decideUpstreamReconcile('127.0.0.1', 5232, undefined, undefined);
        expect(d.changed).toBe(true);
        if (d.changed) expect(d.from).toBe('?:?');
    });
});
