 

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentExecutor } from '../../src/lib/agent/executor';

// Mock Agent Manager
const mockAgent = {
    sendCommand: vi.fn(),
    nodeName: 'TestNode',
    start: vi.fn().mockResolvedValue(undefined)
};

vi.mock('../../src/lib/agent/manager', () => ({
    AgentManager: {
        getInstance: () => ({
            getAgent: vi.fn(() => mockAgent)
        })
    }
}));

// Mock Logger
vi.mock('@/lib/logger', () => ({
    logger: { info: vi.fn(), error: vi.fn() }
}));

describe('Terminal Backend Logic (via AgentExecutor)', () => {
    let executor: AgentExecutor;

    beforeEach(() => {
        executor = new AgentExecutor('TestNode');
        vi.clearAllMocks();
    });

    it('should support READ file operations (cat)', async () => {
        mockAgent.sendCommand.mockResolvedValueOnce({ content: 'file content' });
        
        const content = await executor.readFile('/tmp/test.txt');
        
        expect(mockAgent.sendCommand).toHaveBeenCalledWith('read_file', { path: '/tmp/test.txt' });
        expect(content).toBe('file content');
    });

    it('should support WRITE file operations', async () => {
        mockAgent.sendCommand.mockResolvedValueOnce({ success: true });
        
        await executor.writeFile('/tmp/test.txt', 'new data');
        
        expect(mockAgent.sendCommand).toHaveBeenCalledWith('write_file', { 
            path: '/tmp/test.txt', 
            content: 'new data' 
        });
    });

    it('should support basic command execution (exec)', async () => {
        mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: 'hi', stderr: '' });
        
        const { stdout } = await executor.exec('echo hi');
        
        expect(stdout).toBe('hi');
        expect(mockAgent.sendCommand).toHaveBeenCalledWith('exec', { command: 'echo hi' }, { timeoutMs: undefined });
    });

    it('should handle execution errors', async () => {
        mockAgent.sendCommand.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Permission denied' });
        
        await expect(executor.exec('root_cmd')).rejects.toThrow('Command failed');
    });

    // Terminal PTY logic is usually server-side 'node-pty' which hooks into 'socke.io'.
    // That part interacts with OS directly or via SSH. Since we use AgentExecutor for FS but
    // PTY for interactive shell, testing PTY in unit tests is hard without native modules.
    // However, we verified the underlying "Agent Command" mechanism used for file operations in the terminal UI.
});
