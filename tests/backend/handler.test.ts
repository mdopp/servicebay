 

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

// We need to subclass to access protected/private methods for testing
// or use 'any' casting. Subclass is cleaner but privates are hard.
// We'll use 'any' casting for the private method 'handleData'.
class TestAgentHandler extends AgentHandler {
    public testHandleData(data: Buffer) {
        // @ts-expect-error access private
        super.handleData(data);
    }
}

describe('AgentHandler Stream Parsing', () => {
    let agent: TestAgentHandler;

    beforeEach(() => {
        agent = new TestAgentHandler('TestNode');
    });

    it('should parse a complete JSON message delimited by null byte', () => {
        const payload = { type: 'SYTEM_STATE', payload: { foo: 'bar' } };
        const msg = JSON.stringify(payload);
        const buffer = Buffer.concat([Buffer.from(msg), Buffer.from([0])]); // Append null byte

        const spy = vi.fn();
        agent.on('event', spy);

        agent.testHandleData(buffer);

        expect(spy).toHaveBeenCalledWith(payload);
    });

    it('should handle split messages (buffering)', () => {
        const payload = { type: 'PARTIAL', payload: { val: 1 } };
        const msg = JSON.stringify(payload);
        const fullBuffer = Buffer.concat([Buffer.from(msg), Buffer.from([0])]);
        
        // Split into two chunks
        const part1 = fullBuffer.subarray(0, 10);
        const part2 = fullBuffer.subarray(10);

        const spy = vi.fn();
        agent.on('event', spy);

        agent.testHandleData(part1);
        expect(spy).not.toHaveBeenCalled(); // Should assume incomplete

        agent.testHandleData(part2);
        expect(spy).toHaveBeenCalledWith(payload);
    });

    it('should handle multiple messages in one chunk', () => {
        const msg1 = JSON.stringify({ type: 'A', payload: 1 });
        const msg2 = JSON.stringify({ type: 'B', payload: 2 });
        const buffer = Buffer.concat([
            Buffer.from(msg1), Buffer.from([0]),
            Buffer.from(msg2), Buffer.from([0])
        ]);

        const spy = vi.fn();
        agent.on('event', spy);

        agent.testHandleData(buffer);

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenNthCalledWith(1, { type: 'A', payload: 1 });
        expect(spy).toHaveBeenNthCalledWith(2, { type: 'B', payload: 2 });
    });

    it('should recover from invalid JSON', () => {
        const invalid = Buffer.from("Not JSON");
        const valid = JSON.stringify({ type: 'OK', payload: 1 });
        
        // Stream: Invalid \0 Valid \0
        const buffer = Buffer.concat([
            invalid, Buffer.from([0]),
            Buffer.from(valid), Buffer.from([0])
        ]);

        const spy = vi.fn();
        agent.on('event', spy);

        // Should not throw
        expect(() => agent.testHandleData(buffer)).not.toThrow();
        
        // Should process the valid one
        expect(spy).toHaveBeenCalledWith({ type: 'OK', payload: 1 });
    });
});
