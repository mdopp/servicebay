import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listServices, getEnrichedContainers } from './manager';
import { getExecutor } from './executor';
import { PodmanConnection } from './nodes';

// Mock executor module
vi.mock('./executor', () => ({
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

  describe('listServices', () => {
    it('should return empty array if no connection provided', async () => {
      const services = await listServices(undefined);
      expect(services).toEqual([]);
    });

    it('should parse container service output correctly', async () => {
      const sampleOutput = `
---SERVICE_START---
NAME: nginx-web
TYPE: container
FILE: nginx-web.container
STATUS: active
DESCRIPTION: Nginx Web Server
CONTENT_START
[Container]
Image=docker.io/library/nginx:latest
PublishPort=8080:80
Label=servicebay.role=reverse-proxy
CONTENT_END
---SERVICE_END---
      `;
      
      mockExec.mockResolvedValue({ stdout: sampleOutput, stderr: '' });

      const services = await listServices(mockConnection);

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('for f in *.kube; do'));
      expect(services).toHaveLength(1);
      const svc = services[0];
      expect(svc.name).toBe('nginx-web');
      expect(svc.active).toBe(true);
      expect(svc.description).toBe('Nginx Web Server');
      // Verify path mapping (assuming getSystemdDir returns .config/containers/systemd)
      expect(svc.kubeFile).toBe('nginx-web.container');
      
      // Verify Port Parsing and Identity
      expect(svc.ports).toEqual([{ host: '8080', container: '80' }]);
    });

    it('should parse kube service with yaml correctly', async () => {
      const sampleOutput = `
---SERVICE_START---
NAME: my-pod
TYPE: kube
FILE: my-pod.kube
STATUS: inactive
DESCRIPTION: My Pod Service
CONTENT_START
[Install]
WantedBy=default.target
[Kube]
Yaml=my-pod.yml
CONTENT_END
YAML_CONTENT_START
apiVersion: v1
kind: Pod
metadata:
  name: my-pod-instance
  labels:
    app: my-app
spec:
  containers:
    - name: main
      image: alpine
      ports:
        - containerPort: 80
          hostPort: 8080
YAML_CONTENT_END
---SERVICE_END---
      `;

      mockExec.mockResolvedValue({ stdout: sampleOutput, stderr: '' });

      const services = await listServices(mockConnection);

      expect(services).toHaveLength(1);
      const svc = services[0];
      expect(svc.name).toBe('my-pod');
      expect(svc.active).toBe(false);
      expect(svc.labels).toEqual({ app: 'my-app' });
      expect(svc.ports).toEqual([{ host: '8080', container: '80' }]);
    });
  });

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
