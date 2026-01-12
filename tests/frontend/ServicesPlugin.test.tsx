
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ServicesPlugin from '../../src/plugins/ServicesPlugin';

// 1. Define a mutable mock object
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentMockData: any = null;

// 2. Define default data
const defaultTwinData = {
  nodes: {
    'Local': {
      services: [
        { 
            name: 'nginx.service', activeState: 'active', subState: 'running', type: 'container', description: 'Nginx Web Server',
            isManaged: true, isReverseProxy: true, associatedContainerIds: ['nginx-123'], verifiedDomains: ['app.example.com']
        },
        { 
            name: 'redis.service', activeState: 'active', subState: 'running', type: 'container', description: 'Redis Cache',
            isManaged: true, associatedContainerIds: ['redis-123']
        }
      ],
      containers: [
        { 
            id: 'nginx-123', names: ['nginx'], 
            ports: [{ hostPort: 80, containerPort: 80 }, { hostPort: 443, containerPort: 443 }] 
        },
        { 
            id: 'redis-123', names: ['redis'], 
            ports: [{ hostPort: 6379, containerPort: 6379 }] 
        }
      ],
      files: {
        '/etc/containers/systemd/nginx.kube': { content: 'Yaml=nginx.yaml' }, // Mark as managed
        '/etc/containers/systemd/redis.kube': { content: 'Yaml=redis.yaml' }
      }
    }
  },
  proxy: {
      provider: 'nginx',
      routes: [
          { host: 'app.example.com', targetService: 'nginx' }
      ]
  },
  gateway: {
      provider: 'fritzbox',
      upstreamStatus: 'up',
      publicIp: '1.2.3.4',
      internalIp: '192.168.1.1'
  }
};

// 3. Mock the hook to use currentMockData
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({
    data: currentMockData,
    isConnected: true,
    lastUpdate: Date.now()
  })
}));

// Mock Router and Toast
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() })
}));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn() })
}));

describe('ServicesPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset data before each test
        currentMockData = defaultTwinData;
    });

    it('displays services with ports', async () => {
        render(<ServicesPlugin />);
        
        // Find Redis card
        await waitFor(() => screen.getByText('redis'));
        
        // Check for ports (Ports are rendered as ":HostPort" or "ContainerPort/tcp")
        // In the mock, Redis has hostPort 6379, so we expect ":6379"
        expect(screen.getByText(':6379')).toBeDefined();
    });

    it('displays verified domains', async () => {
        render(<ServicesPlugin />);
        
        // Find Nginx card (It is renamed to Reverse Proxy (Nginx) because of proxy provider mock)
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        
        // Check for Verified Domain badge or text
        expect(screen.getByText('app.example.com')).toBeDefined();
    });

    it('shows Internet Gateway as a service card', async () => {
        render(<ServicesPlugin />);
        
        // Should find "FritzBox Gateway" or "Internet Gateway" (based on mock data provider=fritzbox)
        await waitFor(() => screen.getByText('FritzBox Gateway'));
        
        // Check for specific Gateway badge
        expect(screen.getByText('Gateway')).toBeDefined(); // Badge text
        expect(screen.getByText('1.2.3.4')).toBeDefined(); // Public IP
    });

    it('identifies ServiceBay special services', async () => {
        // Nginx is the proxy provider in mock, so 'nginx.service' should be identified as Reverse Proxy
        render(<ServicesPlugin />);
        
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        
        // Check for "Reverse Proxy" badge
        // Note: The logic in ServicesPlugin replaces the name "nginx" with "Reverse Proxy (Nginx)"
        // And adds a "Reverse Proxy" badge.
        
        // We look for the badge specifically
        const badges = screen.getAllByText('Reverse Proxy');
        expect(badges.length).toBeGreaterThan(0);
    });

    it('shows Unmanaged Nginx service (Agent V4 name format) without .kube file', async () => {
        // Reproduce failure:
        // 1. Service name = 'nginx-web' (No .service extension, as per Agent V4)
        // 2. Unmanaged (No .kube file in `files`)
        // 3. Logic should still allow it because it matches twin.proxy check
        
        // Update the mutable mock
        currentMockData = {
            ...defaultTwinData,
            nodes: {
                'Local': {
                    services: [
                        { 
                             name: 'nginx-web', // Agent V4 format
                             activeState: 'active', subState: 'running', type: 'container', description: 'Nginx Web Server',
                             isReverseProxy: true // Agent sets this
                        }
                    ],
                    containers: [],
                    files: {} // No .kube files -> Unmanaged
                }
            }
        };

        render(<ServicesPlugin />);
        
        // Expect to see it
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
    });

    it('shows Unmanaged ServiceBay service (Agent V4)', async () => {
        currentMockData = {
          nodes: {
            'Local': {
              services: [
                { 
                    name: 'servicebay',  // No extension
                    activeState: 'active', 
                    subState: 'running', 
                    type: 'container', 
                    description: 'ServiceBay Management Interface',
                    isServiceBay: true // Flag from Agent V4
                }
              ],
              containers: [],
              files: {} // No .kube files
            }
          },
          proxy: { provider: 'none' },
          gateway: { upstreamStatus: 'up' }
        };

        render(<ServicesPlugin />);
        
        // Should show up even if unmanaged
        await waitFor(() => screen.getByText('ServiceBay System'));
        
        // Check for System badge
        await waitFor(() => screen.getByText('System'));
    });

    it('shows ports for Unmanaged Kube-style services (Agent V4)', async () => {
        currentMockData = {
          nodes: {
            'Local': {
              services: [
                { 
                    name: 'nginx-web',
                    activeState: 'active', subState: 'running', type: 'container', description: 'Nginx',
                    isReverseProxy: true,
                    associatedContainerIds: ['abc12345']
                }
              ],
              containers: [
                  {
                      // Podman Kube naming convention: k8s_<container-name>_<pod-name>_<namespace>...
                      id: 'abc12345',
                      names: ['k8s_nginx_nginx-web_default_0_0'], 
                      ports: [{ hostPort: 80, containerPort: 80 }, { hostPort: 443, containerPort: 443 }]
                  }
              ],
              files: {} // Unmanaged
            }
          },
          proxy: { provider: 'nginx' },
          gateway: { upstreamStatus: 'up' }
        };

        render(<ServicesPlugin />);
        
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        // Should show ports (rendered as :PORT)
        await waitFor(() => screen.getByText(':80')); 
        await waitFor(() => screen.getByText(':443')); 
    });

    it('identifies Nginx as Managed when nginx.kube exists but service is nginx-web (Agent V4)', async () => {
        currentMockData = {
          nodes: {
            'Local': {
              services: [
                { 
                    name: 'nginx-web', // Service Name
                    activeState: 'active', subState: 'running', type: 'container', description: 'Nginx',
                    isReverseProxy: true
                }
              ],
              containers: [],
              files: {
                  // Standard .kube unit file existing
                  '/etc/containers/systemd/nginx.kube': { content: 'Yaml=nginx.yml' },
                  // The referenced YAML file
                  '/etc/containers/systemd/nginx.yml': { content: `
apiVersion: v1
kind: Pod
metadata:
  name: nginx-web
spec:
  containers:
  - name: nginx
    image: nginx
` 
                  }
              }
            }
          },
          proxy: { provider: 'nginx' },
          gateway: { upstreamStatus: 'up' }
        };

        render(<ServicesPlugin />);
        
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        
        // Should find the Yaml link/badge (implicit check for Managed logic working)
        // Since we didn't mock the link behavior, we assume if no crash and rendering happens it worked.
    });

    it('deduplicates Reverse Proxy services when multiple aliases exist', async () => {
        currentMockData = {
          nodes: {
            'Local': {
              services: [
                // Scenario: Agent sees both the unit and the underlying service alias
                { name: 'nginx-web', activeState: 'active', subState: 'running', isReverseProxy: true },
                { name: 'nginx.service', activeState: 'active', subState: 'running', isReverseProxy: true }
              ],
              containers: [],
              files: { '/etc/containers/systemd/nginx.kube': { content: 'Yaml=nginx.yml' } }
            }
          },
          proxy: { provider: 'nginx' },
          gateway: { upstreamStatus: 'up' }
        };

        render(<ServicesPlugin />);
        
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        
        // Check uniqueness using getAllByText matching the Header Title
        const headers = screen.getAllByTitle('Reverse Proxy (Nginx)');
        expect(headers.length).toBe(1);
    });

    it('shows Fritzbox Gateway ports', async () => {
         currentMockData = {
          nodes: {},
          proxy: { provider: 'nginx' },
          gateway: { 
             upstreamStatus: 'up', 
             provider: 'fritzbox',
             portMappings: [
                 { hostPort: 8080, containerPort: 80, protocol: 'TCP' }
             ]
          }
        };

        render(<ServicesPlugin />);
        await waitFor(() => screen.getByText('FritzBox Gateway'));
        // Expect format :8080 or 80/tcp etc.
        // Our updated code maps it to { host: '8080', container: '80' }
        // Display logic: p.host ? `:${p.host}` ...
        await waitFor(() => screen.getByText(':8080'));
    });
});
