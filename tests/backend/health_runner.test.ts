import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CheckRunner } from '../../src/lib/health/runner';
import { HealthStore } from '../../src/lib/health/store';
import { CheckConfig } from '../../src/lib/health/types';

// Mock dependencies
vi.mock('../../src/lib/health/store');
vi.mock('../../src/lib/executor', () => {
    const dispatch = (cmd: string) => {
        if (cmd.includes('failhost')) {
            throw new Error('ping: failhost: Name or service not known');
        }
        if (cmd.startsWith('ping')) {
            return { stdout: '1 packets transmitted, 1 received', stderr: '' };
        }
        if (cmd.includes('inspect') && cmd.includes('format')) {
            return { stdout: 'running|healthy', stderr: '' };
        }
        if (cmd.includes('success_cmd')) {
            return { stdout: 'ok', stderr: '' };
        }
        throw new Error(`Command failed: ${cmd}`);
    };
    return {
        getExecutor: vi.fn(() => ({
            exec: vi.fn((cmd: string) => dispatch(cmd)),
            execArgv: vi.fn((argv: string[]) => dispatch(argv.join(' '))),
        })),
    };
});
vi.mock('../../src/lib/nodes');

// letsdebug client is exercised by its own unit tests; mock here so
// CheckRunner.run('letsdebug', ...) returns a known shape without any
// network calls.
vi.mock('../../src/lib/letsdebug/client', () => ({
    runLetsdebugForDomain: vi.fn(async (domain: string) => {
        if (domain === 'fatal.example.com') {
            return {
                problems: [{ name: 'X', explanation: 'broken', severity: 'fatal' }],
                submissionUrl: 'https://letsdebug.net/?id=1',
            };
        }
        if (domain === 'warn.example.com') {
            return {
                problems: [{ name: 'Y', explanation: 'meh', severity: 'warning' }],
                submissionUrl: 'https://letsdebug.net/?id=2',
            };
        }
        if (domain === 'throw.example.com') {
            throw new Error('HTTP 429');
        }
        return { problems: [], submissionUrl: 'https://letsdebug.net/?id=3' };
    }),
}));

// Mock child_process for Ping check
vi.mock('child_process', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter } = require('events');
    const spawn = vi.fn((cmd, args) => {
        const cp = new EventEmitter();
        process.nextTick(() => {
            if (Array.isArray(args) && args.includes('failhost')) {
                cp.emit('close', 1);
            } else {
                cp.emit('close', 0);
            }
        });
        return cp;
    });

    return {
        spawn,
        default: { spawn },
        __esModule: true,
    };
});

describe('CheckRunner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    it('should run a successful HTTP check', async () => {
        const check: CheckConfig = {
            id: 'test-http',
            name: 'Test HTTP',
            type: 'http',
            target: 'https://example.com',
            interval: 60,
            enabled: true,
            httpConfig: { expectedStatus: 200 },
            created_at: '2024-01-01T00:00:00Z'
        };

        // Mock fetch
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: () => Promise.resolve('ok')
        });

        const result = await CheckRunner.run(check);

        expect(result.status).toBe('ok');
        expect(result.check_id).toBe('test-http');
        expect(HealthStore.saveResult).toHaveBeenCalledWith(expect.objectContaining({
            check_id: 'test-http',
            status: 'ok'
        }));
    });

    it('should fail HTTP check with wrong status', async () => {
        const check: CheckConfig = {
            id: 'test-http-fail',
            name: 'Test HTTP Fail',
            type: 'http',
            target: 'https://example.com',
            interval: 60,
            enabled: true,
            httpConfig: { expectedStatus: 200 },
            created_at: '2024-01-01T00:00:00Z'
        };

        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: () => Promise.resolve('error')
        });

        const result = await CheckRunner.run(check);

        expect(result.status).toBe('fail');
        expect(result.message).toContain('HTTP Status 500');
    });

    it('should run a ping check', async () => {
        const check: CheckConfig = {
            id: 'test-ping',
            name: 'Test Ping',
            type: 'ping',
            target: 'localhost',
            interval: 60,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z'
         };

         const result = await CheckRunner.run(check);
         expect(result.status).toBe('ok');
    });

    it('should fail a ping check', async () => {
        const check: CheckConfig = {
            id: 'test-ping-fail',
            name: 'Test Ping Fail',
            type: 'ping',
            target: 'failhost',
            interval: 60,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z'
         };

         const result = await CheckRunner.run(check);
         expect(result.status).toBe('fail');
         expect(result.message).toContain('Ping');
    });

    it('should run a script check', async () => {
        const check: CheckConfig = {
            id: 'test-script',
            name: 'Test Script',
            type: 'script',
            target: 'if (1 !== 1) throw new Error("Math is broken")',
            interval: 60,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z'
        };

        const result = await CheckRunner.run(check);
        expect(result.status).toBe('ok');
    });

    it('should fail a broken script check', async () => {
        const check: CheckConfig = {
            id: 'test-script-fail',
            name: 'Test Script Fail',
            type: 'script',
            target: 'throw new Error("Custom Failure")',
            interval: 60,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z'
        };

        const result = await CheckRunner.run(check);
        expect(result.status).toBe('fail');
        expect(result.message).toContain('Custom Failure');
    });

    it('should pass a letsdebug check with no problems', async () => {
        const check: CheckConfig = {
            id: 'letsdebug:ok.example.com',
            name: 'External reachability — ok.example.com',
            type: 'letsdebug',
            target: 'ok.example.com',
            interval: 14400,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z',
        };
        const result = await CheckRunner.run(check);
        expect(result.status).toBe('ok');
        expect(result.message).toBe('');
    });

    it('should encode warnings in the message and stay status:ok', async () => {
        const check: CheckConfig = {
            id: 'letsdebug:warn.example.com',
            name: 'External reachability — warn.example.com',
            type: 'letsdebug',
            target: 'warn.example.com',
            interval: 14400,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z',
        };
        const result = await CheckRunner.run(check);
        expect(result.status).toBe('ok');
        expect(result.message).toMatch(/^letsdebug:/);
        const payload = JSON.parse(result.message!.slice('letsdebug:'.length));
        expect(payload.problems).toHaveLength(1);
        expect(payload.submissionUrl).toMatch(/letsdebug\.net/);
    });

    it('should escalate to status:fail when any problem is fatal', async () => {
        const check: CheckConfig = {
            id: 'letsdebug:fatal.example.com',
            name: 'External reachability — fatal.example.com',
            type: 'letsdebug',
            target: 'fatal.example.com',
            interval: 14400,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z',
        };
        const result = await CheckRunner.run(check);
        expect(result.status).toBe('fail');
        expect(result.message).toMatch(/^letsdebug:/);
    });

    it('should report transport errors as status:fail with plaintext message', async () => {
        const check: CheckConfig = {
            id: 'letsdebug:throw.example.com',
            name: 'External reachability — throw.example.com',
            type: 'letsdebug',
            target: 'throw.example.com',
            interval: 14400,
            enabled: true,
            created_at: '2024-01-01T00:00:00Z',
        };
        const result = await CheckRunner.run(check);
        expect(result.status).toBe('fail');
        expect(result.message).toMatch(/letsdebug error: HTTP 429/);
        expect(result.message).not.toMatch(/^letsdebug:/);
    });
});
