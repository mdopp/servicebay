import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CheckRunner } from '../../src/lib/monitoring/runner';
import { MonitoringStore } from '../../src/lib/monitoring/store';
import { CheckConfig } from '../../src/lib/monitoring/types';

// Mock dependencies
vi.mock('../../src/lib/monitoring/store');
vi.mock('../../src/lib/executor', () => ({
    getExecutor: vi.fn(() => ({
        exec: vi.fn(),
    })),
}));
vi.mock('../../src/lib/nodes');

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
            httpConfig: { expectedStatus: 200 }
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
        expect(MonitoringStore.saveResult).toHaveBeenCalledWith(expect.objectContaining({
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
            httpConfig: { expectedStatus: 200 }
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
            enabled: true
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
            enabled: true
         };

         const result = await CheckRunner.run(check);
         expect(result.status).toBe('fail');
         expect(result.message).toContain('Ping failed');
    });

    it('should run a script check', async () => {
        const check: CheckConfig = {
            id: 'test-script',
            name: 'Test Script',
            type: 'script',
            target: 'if (1 !== 1) throw new Error("Math is broken")',
            interval: 60,
            enabled: true
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
            enabled: true
        };

        const result = await CheckRunner.run(check);
        expect(result.status).toBe('fail');
        expect(result.message).toContain('Custom Failure');
    });
});
