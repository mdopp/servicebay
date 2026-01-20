import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addNode, listNodes, verifyNodeConnection } from './nodes';
import fs from 'fs/promises';
import { getExecutor } from './executor';

vi.mock('fs/promises', () => ({
    default: {
        writeFile: vi.fn(),
        readFile: vi.fn(),
        mkdir: vi.fn(),
        access: vi.fn(),
    }
}));
vi.mock('./executor', () => ({
  SSHExecutor: vi.fn(),
  getExecutor: vi.fn()
}));

describe('NodesManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('addNode should add a node and save to file', async () => {
        // Mock empty existing nodes file
        vi.mocked(fs.readFile).mockResolvedValue('[]');
        vi.mocked(fs.access).mockResolvedValue(undefined); // Directory exists

        await addNode('NewHost', 'ssh://user@host', '/path/to/key');

        // writeFile is called twice:
        // 1. By loadNodes (auto-seeding creates default Local node)
        // 2. By saveNodes (adding NewHost to the list)
        expect(fs.writeFile).toHaveBeenCalledTimes(2);
        
        // Check the second call (saveNodes) which contains both nodes
        const saveCall = vi.mocked(fs.writeFile).mock.calls[1];
        const content = JSON.parse(saveCall[1] as string);
        
        // Now we have 2 nodes: the auto-generated Local node and NewHost
        expect(content).toHaveLength(2);
        expect(content[1].Name).toBe('NewHost');
        expect(content[1].URI).toBe('ssh://user@host');
        expect(content[1].Identity).toBe('/path/to/key');
        expect(content[1].Default).toBe(false); // Second node is not default
        
        // The first node should be the auto-generated Local node
        expect(content[0].Name).toBe('Local');
        expect(content[0].Default).toBe(true);
    });

    it('verifyNodeConnection should run podman info using getExecutor', async () => {
        // Mock existing nodes
        const nodes = [{ Name: 'Node1', URI: 'ssh://user@host', Identity: '', Default: true }];
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(nodes));
        
        const mockExec = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '' });
        
        vi.mocked(getExecutor).mockReturnValue({
            exec: mockExec,
            spawn: vi.fn(), // Add missing spawn mock
            readFile: vi.fn(),
            writeFile: vi.fn(),
            exists: vi.fn(),
            mkdir: vi.fn(),
            readdir: vi.fn(),
            rm: vi.fn(),
            rename: vi.fn()
        });

        const result = await verifyNodeConnection('Node1');
        
        expect(getExecutor).toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(mockExec).toHaveBeenCalledWith('podman info');
    });

    it('verifyNodeConnection should fail if node not found', async () => {
         vi.mocked(fs.readFile).mockResolvedValue('[]');
         const result = await verifyNodeConnection('NonExistent');
         expect(result.success).toBe(false);
         expect(result.error).toContain('not found');
    });

    it('loadNodes should NOT auto-migrate legacy Host SSH configuration', async () => {
        const legacyNodes = [{
            Name: 'Host',
            URI: 'ssh://root@127.0.0.1:22',
            Identity: '/app/data/ssh/id_rsa',
            Default: true
        }];
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(legacyNodes));
        vi.mocked(fs.access).mockResolvedValue(undefined);

        const nodes = await listNodes();

        // Should NOT update in memory
        expect(nodes[0].Name).toBe('Host');
        expect(nodes[0].URI).toBe('ssh://root@127.0.0.1:22');

        // Should NOT save to disk
        expect(fs.writeFile).not.toHaveBeenCalled();
    });
});
