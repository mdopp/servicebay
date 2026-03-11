import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentHandler, PullProgressEvent } from '../../src/lib/agent/handler';

vi.mock('../../src/lib/logger', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}));

vi.mock('../../src/lib/config', () => ({
    getConfig: vi.fn().mockResolvedValue({})
}));

class TestAgentHandler extends AgentHandler {
    public testHandleData(data: Buffer) {
        // @ts-expect-error access private
        super.handleData(data);
    }

    public simulateConnected() {
        // @ts-expect-error access private
        this.isConnected = true;
    }
}

/** Build a null-terminated JSON message buffer (agent protocol) */
function agentMessage(obj: object): Buffer {
    return Buffer.concat([Buffer.from(JSON.stringify(obj)), Buffer.from([0])]);
}

describe('AgentHandler.pullImage', () => {
    let agent: TestAgentHandler;

    beforeEach(() => {
        agent = new TestAgentHandler('TestNode');
        agent.simulateConnected();
    });

    it('should register and cleanup PULL_PROGRESS listener', async () => {
        const progressEvents: PullProgressEvent[] = [];

        // Intercept sendCommand to simulate agent response
        const sendSpy = vi.spyOn(agent, 'sendCommand').mockImplementation(async (action, params) => {
            // Simulate progress events arriving
            const pullId = params.pull_id;
            agent.emit('PULL_PROGRESS', {
                pull_id: pullId,
                image: 'redis:7',
                id: 'abc123',
                status: 'Downloading',
                current: 50000,
                total: 100000,
            });
            agent.emit('PULL_PROGRESS', {
                pull_id: pullId,
                image: 'redis:7',
                id: 'abc123',
                status: 'Pull complete',
            });
            return { success: true, image: 'redis:7' };
        });

        await agent.pullImage('redis:7', (evt) => {
            progressEvents.push(evt);
        });

        expect(sendSpy).toHaveBeenCalledWith(
            'pull_image',
            expect.objectContaining({ image: 'redis:7', pull_id: expect.any(String) }),
            { timeoutMs: 300_000 }
        );
        expect(progressEvents).toHaveLength(2);
        expect(progressEvents[0].status).toBe('Downloading');
        expect(progressEvents[0].current).toBe(50000);
        expect(progressEvents[1].status).toBe('Pull complete');

        // Verify listener was cleaned up
        expect(agent.listenerCount('PULL_PROGRESS')).toBe(0);
    });

    it('should filter progress events by pull_id', async () => {
        const progressEvents: PullProgressEvent[] = [];

        vi.spyOn(agent, 'sendCommand').mockImplementation(async (_action, params) => {
            const pullId = params.pull_id;
            // Event from a different pull
            agent.emit('PULL_PROGRESS', {
                pull_id: 'other-pull-id',
                image: 'nginx:latest',
                id: 'xyz789',
                status: 'Downloading',
            });
            // Event from our pull
            agent.emit('PULL_PROGRESS', {
                pull_id: pullId,
                image: 'redis:7',
                id: 'abc123',
                status: 'Extracting',
            });
            return { success: true };
        });

        await agent.pullImage('redis:7', (evt) => {
            progressEvents.push(evt);
        });

        expect(progressEvents).toHaveLength(1);
        expect(progressEvents[0].image).toBe('redis:7');
        expect(progressEvents[0].status).toBe('Extracting');
    });

    it('should cleanup listener on error', async () => {
        vi.spyOn(agent, 'sendCommand').mockRejectedValue(new Error('socket unavailable'));

        await expect(agent.pullImage('redis:7', vi.fn())).rejects.toThrow('socket unavailable');

        expect(agent.listenerCount('PULL_PROGRESS')).toBe(0);
    });

    it('should work without onProgress callback', async () => {
        vi.spyOn(agent, 'sendCommand').mockResolvedValue({ success: true });

        const result = await agent.pullImage('redis:7');
        expect(result).toEqual({ success: true });
        expect(agent.listenerCount('PULL_PROGRESS')).toBe(0);
    });
});

describe('AgentHandler PULL_PROGRESS event routing', () => {
    let agent: TestAgentHandler;

    beforeEach(() => {
        agent = new TestAgentHandler('TestNode');
    });

    it('should emit PULL_PROGRESS as typed event from agent data stream', () => {
        const spy = vi.fn();
        agent.on('PULL_PROGRESS', spy);

        const msg = {
            type: 'PULL_PROGRESS',
            payload: {
                pull_id: 'test-123',
                image: 'redis:7',
                id: 'abc123',
                status: 'Downloading',
                current: 1024,
                total: 4096,
            }
        };

        agent.testHandleData(agentMessage(msg));

        expect(spy).toHaveBeenCalledWith(msg.payload);
    });
});
