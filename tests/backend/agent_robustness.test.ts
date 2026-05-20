/* eslint-disable @typescript-eslint/ban-ts-comment */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentHandler } from '@/lib/agent/handler';

// Mocks
vi.mock('@/lib/nodes', () => ({
    listNodes: vi.fn().mockResolvedValue([])
}));

vi.mock('@/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    }
}));

// Test Handler to access protected methods
class TestRobustHandler extends AgentHandler {
    public testHandleData(data: Buffer) {
        // @ts-expect-error
        super.handleData(data);
    }
    public getBuffer() {
        // @ts-expect-error
        return this.buffer;
    }
}

describe('AgentHandler Robustness', () => {
    let agent: TestRobustHandler;

    beforeEach(() => {
        agent = new TestRobustHandler('TestNode');
    });

    it('should track consecutive parse errors', () => {
        const invalid = Buffer.from("Not JSON\0");
        agent.testHandleData(invalid);
        agent.testHandleData(invalid);
        
        // @ts-expect-error
        expect(agent.consecutiveParseErrors).toBe(2);
    });

    it('should reset error count on valid message', () => {
        const invalid = Buffer.from("Not JSON\0");
        const valid = Buffer.from(JSON.stringify({ type: 'PING' }) + '\0');

        agent.testHandleData(invalid);
        agent.testHandleData(invalid);
        // @ts-expect-error
        expect(agent.consecutiveParseErrors).toBe(2);

        agent.testHandleData(valid);
        // @ts-expect-error
        expect(agent.consecutiveParseErrors).toBe(0);
    });

    it('should disconnect after MAX_PARSE_ERRORS (5)', () => {
        const invalid = Buffer.from("Garbage\0");
        const disconnectSpy = vi.spyOn(agent, 'disconnect');
        const errorSpy = vi.fn();
        agent.on('error', errorSpy);

        // Send 5 bad messages
        for (let i = 0; i < 5; i++) {
            agent.testHandleData(invalid);
        }

        expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Circuit Breaker') }));
        expect(disconnectSpy).toHaveBeenCalled();
    });

    it('should handle huge garbage buffer gracefully', () => {
         // Sending a huge buffer with no null byte shouldn't crash it immediately,
         // but consecutive garbage packets with nulls should trigger breaker.
         // If it's just one huge chunk without null, it just buffers.
         const huge = Buffer.alloc(10 * 1024, 'A');
         agent.testHandleData(huge);
         // @ts-ignore
         expect(agent.getBuffer().length).toBe(10 * 1024);
    });

    it('sendCommand retries start() until the agent reconnects', async () => {
        // Regression test for the autoupdate-during-install race: when the
        // agent is briefly disconnected (ServiceBay's own container is
        // restarting, host is rebooting, etc.) sendCommand used to call
        // start() exactly once and throw "Agent not connected" if that one
        // call failed. The wizard then aborted every service in the
        // install loop. sendCommand should retry start() with backoff and
        // proceed once the connection comes back.
        const handler = new AgentHandler('RetryNode');
        // Provide a stub channel so the post-retry write path doesn't blow
        // up. The retry path is what we're actually testing.
        // @ts-expect-error - private field
        handler.channel = { write: () => true };
        let attempts = 0;
        const startSpy = vi.spyOn(handler, 'start').mockImplementation(async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('SSH unreachable');
            // @ts-expect-error - private field, mutated to simulate reconnect
            handler.isConnected = true;
        });

        const sendPromise = handler.sendCommand('exec', { command: 'true' }, { timeoutMs: 30_000 });

        // The retry loop in sendCommand sleeps with exponential backoff
        // (250ms * 2 ^ attempt, capped at 2s) between start() attempts.
        // For 3 attempts that's roughly 250+500+1000 = 1.75 s. Poll until
        // the pending request appears, then resolve it.
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
            // @ts-expect-error - private field
            const pending = handler.pendingRequests as Map<string, { resolve: (v: unknown) => void }>;
            if (pending && pending.size > 0) {
                for (const [, { resolve }] of pending) {
                    resolve({ code: 0, stdout: '', stderr: '' });
                }
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        await sendPromise;

        expect(attempts).toBeGreaterThanOrEqual(3);
        expect(startSpy).toHaveBeenCalledTimes(attempts);
    }, 15_000);
});
