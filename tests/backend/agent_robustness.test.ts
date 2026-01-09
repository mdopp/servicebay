/* eslint-disable @typescript-eslint/ban-ts-comment */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentHandler } from '../../src/lib/agent/handler';

// Mocks
vi.mock('../../src/lib/nodes', () => ({
    listNodes: vi.fn().mockResolvedValue([])
}));

vi.mock('../../src/lib/logger', () => ({
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
         // @ts-expect-error
         expect(agent.getBuffer().length).toBe(10 * 1024);
    });
});
