/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listServices } from './manager';
import { getExecutor } from './executor';
import { PodmanConnection } from './nodes';
import { Executor } from './interfaces';

// Mock executor
vi.mock('./executor', () => ({
  getExecutor: vi.fn()
}));

describe('Manager Status Parsing Logic', () => {
    const mockExec = vi.fn();
    const mockExists = vi.fn();
    const mockMkdir = vi.fn();

    const mockConnection: PodmanConnection = {
        Name: 'TestHost',
        URI: 'ssh://test',
        Default: false,
        Identity: ''
    };

    beforeEach(() => {
        vi.clearAllMocks();
        (getExecutor as any).mockReturnValue({
            exec: mockExec,
            exists: mockExists,
            mkdir: mockMkdir,
        } as unknown as Executor);
        mockExists.mockResolvedValue(true);
    });

    // Helper to generate service block with specific status content
    // We mock the RESULT of the bash script here.
    async function runTest(statusPayload: string) {
        const scriptOutput = `
---SERVICE_START---
NAME: test-service
TYPE: kube
FILE: test-service.kube
STATUS: ${statusPayload}
DESCRIPTION: desc
CONTENT_START
[Kube]
Yaml=foo.yml
CONTENT_END
---SERVICE_END---`;

        mockExec.mockResolvedValue({ stdout: scriptOutput, stderr: '' });

        const services = await listServices(mockConnection);
        return services[0];
    }

    it('should handle "active" state', async () => {
        const svc = await runTest('active');
        expect(svc.status).toBe('active');
        expect(svc.active).toBe(true);
    });

    it('should handle "inactive" state', async () => {
        const svc = await runTest('inactive');
        expect(svc.status).toBe('inactive');
        expect(svc.active).toBe(false);
    });

    it('should handle "failed" state', async () => {
         const svc = await runTest('failed');
         expect(svc.status).toBe('failed');
         expect(svc.active).toBe(false);
    });

    it('should handle "activating" state', async () => {
         const svc = await runTest('activating');
         expect(svc.status).toBe('activating');
         expect(svc.active).toBe(false); 
    });

    it('should handle fallback to "inactive" if script produced that', async () => {
         // The script logic sets 'inactive' if systemctl output is empty
         const svc = await runTest('inactive');
         expect(svc.status).toBe('inactive');
         expect(svc.active).toBe(false);
    });

    it('should throw error if systemd is inaccessible', async () => {
        const mockError: any = new Error('Command failed');
        mockError.stdout = 'ERROR_SYSTEMD_ACCESS_FAILED'; 
        mockExec.mockRejectedValue(mockError);

        await expect(listServices(mockConnection)).rejects.toThrow(/Systemd User Session inaccessible/);
    });
});
