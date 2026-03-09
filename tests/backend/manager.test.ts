import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEnrichedContainers } from '../../src/lib/manager';
import { getExecutor } from '../../src/lib/executor';
import { PodmanConnection } from '../../src/lib/nodes';

// Mock executor module
vi.mock('../../src/lib/executor', () => ({
  getExecutor: vi.fn()
}));

describe('ServiceManager', () => {
  const mockExec = vi.fn();
  const mockExists = vi.fn();
  const mockMkdir = vi.fn();

  const mockConnection: PodmanConnection = {
    Name: 'TestHost',
    URI: 'ssh://testuser@192.168.1.100:22',
    Default: false,
    Identity: ''
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getExecutor as any).mockReturnValue({
      exec: mockExec,
      exists: mockExists,
      mkdir: mockMkdir,
    });
    mockExists.mockResolvedValue(true); // Assume systemd dir exists
  });

  // TODO: listServices tests were removed because listServices was moved from manager.ts
  // to ServiceManager (../../src/lib/services/ServiceManager). The new implementation uses
  // DigitalTwinStore instead of direct executor calls. These tests need to be rewritten
  // to mock DigitalTwinStore and test ServiceManager.listServices(nodeName).
  //
  // Removed tests:
  //   - should return empty array if no connection provided
  //   - should parse container service output correctly
  //   - should parse kube service with yaml correctly

  describe('getEnrichedContainers', () => {
    it('should merge ps and inspect data', async () => {
      const psOutput = JSON.stringify([
        { Id: 'c1', Names: ['container1'], State: 'running' }
      ]);
      const inspectOutput = JSON.stringify([
        { 
          Id: 'c1', 
          HostConfig: { NetworkMode: 'bridge' },
          NetworkSettings: { Networks: { podman: {} } }
        }
      ]);

      mockExec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('podman ps')) return { stdout: psOutput };
        if (cmd.includes('podman inspect')) return { stdout: inspectOutput };
        return { stdout: '' };
      });

      const [containers] = await getEnrichedContainers(mockConnection);

      expect(containers).toHaveLength(1);
      expect(containers[0].Id).toBe('c1');
      expect(containers[0].NetworkMode).toBe('bridge'); // From HostConfig
    });

    it('should detect host network correctly', async () => {
       const psOutput = JSON.stringify([
        { Id: 'c2', Names: ['host-container'], State: 'running' }
      ]);
      const inspectOutput = JSON.stringify([
        { 
          Id: 'c2', 
          HostConfig: { NetworkMode: 'host' },
          State: { Pid: 1234 }
        }
      ]);

      mockExec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('podman ps')) return { stdout: psOutput };
        if (cmd.includes('podman inspect')) return { stdout: inspectOutput };
        if (cmd.startsWith('sudo -n ss')) return { stdout: '' }; // Mock ss
        return { stdout: '' };
      });


      const [containers] = await getEnrichedContainers(mockConnection);

      expect(containers).toHaveLength(1);
      expect(containers[0].IsHostNetwork).toBe(true);
      // If getHostPortsForPids works via executorexec, it might add Ports. 
      // However, verifying the boolean flag is a good start.
    });
  });
});
