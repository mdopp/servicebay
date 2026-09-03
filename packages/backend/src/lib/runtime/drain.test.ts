/**
 * Shutdown drain (#2763).
 *
 * The bug this pins: a real box never logged `Shutdown complete`, because the
 * drain's `server.close()` waits for open keep-alive sockets to end by
 * themselves and the browser tab / MCP stream / socket.io transports never do.
 * Every restart burned the full 10 s budget and force-exited.
 *
 * These run against a REAL http server, a REAL socket.io server and REAL
 * clients — a mocked server cannot reproduce "close() never calls back", which
 * is the entire defect. Every assertion is a wall-clock bound far below the
 * 10 s cap, and the suite itself sleeps for nothing.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

vi.mock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { drainSockets, DRAIN_GRACE_MS } from './drain';

/** Everything a case opened, torn down even when it fails. */
const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
});

interface Harness {
    server: http.Server;
    io: IOServer;
    port: number;
}

async function startHarness(handler?: http.RequestListener): Promise<Harness> {
    const server = http.createServer(handler ?? ((_req, res) => { res.end('ok'); }));
    const io = new IOServer(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    cleanups.push(() => {
        server.closeAllConnections();
        server.close();
    });
    return { server, io, port };
}

/** One completed GET on a keep-alive agent — the socket stays open, idle. */
async function openIdleKeepAlive(port: number): Promise<http.Agent> {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => agent.destroy());
    await new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', agent }, res => {
            res.resume();
            res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.end();
    });
    return agent;
}

async function connectSocketIo(port: number): Promise<ClientSocket> {
    const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    cleanups.push(() => client.close());
    await new Promise<void>((resolve, reject) => {
        client.on('connect', () => resolve());
        client.on('connect_error', reject);
    });
    return client;
}

describe('drainSockets', () => {
    it('resolves in well under the 10 s budget with an idle keep-alive client and a socket.io client attached', async () => {
        const { server, io, port } = await startHarness();
        await openIdleKeepAlive(port);
        const client = await connectSocketIo(port);
        expect(client.connected).toBe(true);

        const started = Date.now();
        await drainSockets({ server, io });
        const elapsed = Date.now() - started;

        // The regression was a 10_000 ms force-exit. Anything near the grace
        // window means the idle socket was destroyed, not waited on.
        expect(elapsed).toBeLessThan(2_000);
        expect(server.listening).toBe(false);
    });

    it('proves the naive close is what hung: server.close() alone never calls back while a stream is open', async () => {
        // On Node >= 19 `server.close()` does drop *idle* keep-alive sockets by
        // itself. What it still waits on forever is an ACTIVE connection — the
        // MCP SSE stream, a long-poll, a socket.io upgrade. That is the box's
        // 10 s force-exit, reproduced here.
        let hanging: http.ServerResponse | undefined;
        const { server, port } = await startHarness((_req, res) => { hanging = res; });
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        cleanups.push(() => agent.destroy());
        const req = http.request({ host: '127.0.0.1', port, path: '/stream', agent }, res => { res.resume(); });
        req.on('error', () => { /* the drain destroys this socket; expected */ });
        req.end();
        await vi.waitFor(() => { expect(hanging).toBeDefined(); });

        const closed = new Promise<'closed'>(resolve => server.close(() => resolve('closed')));
        const raced = await Promise.race([
            closed,
            new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 300); }),
        ]);
        expect(raced).toBe('pending');

        // Now finish it the way the drain does, and it completes.
        server.closeAllConnections();
        await expect(closed).resolves.toBe('closed');
    });

    it('destroys a connection still mid-request after the grace window instead of waiting forever', async () => {
        // A handler that never responds — the SSE/long-poll shape that
        // `closeIdleConnections()` alone cannot reach.
        let hanging: http.ServerResponse | undefined;
        const { server, port } = await startHarness((_req, res) => { hanging = res; });
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        cleanups.push(() => agent.destroy());
        const inFlight = new Promise<void>(resolve => {
            const req = http.request({ host: '127.0.0.1', port, path: '/stream', agent }, res => { res.resume(); });
            req.on('error', () => resolve());
            req.on('close', () => resolve());
            req.end();
        });
        await vi.waitFor(() => { expect(hanging).toBeDefined(); });

        const started = Date.now();
        await drainSockets({ server, io: null, graceMs: 50 });
        const elapsed = Date.now() - started;

        expect(elapsed).toBeGreaterThanOrEqual(40);
        expect(elapsed).toBeLessThan(2_000);
        expect(server.listening).toBe(false);
        await inFlight;
    });

    it('drains a server with no connections and no socket.io at all', async () => {
        const { server } = await startHarness();
        const started = Date.now();
        await drainSockets({ server });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(server.listening).toBe(false);
    });

    it('survives a socket.io close that throws and an already-closed http server', async () => {
        const { server, io } = await startHarness();
        io.close();
        await drainSockets({
            server,
            io: { close: () => { throw new Error('boom'); } },
            graceMs: 50,
        });
        expect(server.listening).toBe(false);
    });

    it('keeps a grace window short enough that two of them fit inside the shutdown budget', () => {
        expect(DRAIN_GRACE_MS * 2).toBeLessThan(10_000);
    });
});
