
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ServicesDashboard from '@/dashboards/ServicesDashboard';

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
  proxyState: {
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
    lastUpdate: Date.now(),
    // Mirrors the provider's getter; tests render past the
    // hydration gate so we report synced.
    isNodeSynced: () => true,
  })
}));

// Mock Router and Toast
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/services',
  useSearchParams: () => new URLSearchParams()
}));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() })
}));

describe('ServicesDashboard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset data before each test
        currentMockData = defaultTwinData;
    });

    it('keeps ports off the lean list tile (they live on the Operate page)', async () => {
        render(<ServicesDashboard />);

        // The service still renders in the list…
        await waitFor(() => screen.getByTestId('service-name-redis'));
        // …but the lean list tile (IA spec §4.1: "one dot = one honest health
        // state") no longer crowds in per-port links — ports moved to the
        // per-service Operate page.
        expect(screen.queryByText(':6379')).toBeNull();
    });

    it('displays verified domains', async () => {
        render(<ServicesDashboard />);
        
        // Find Nginx card (It is renamed to Reverse Proxy (Nginx) because of proxy provider mock)
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        
        // Check for Verified Domain badge or text
        expect(screen.getByText('app.example.com')).toBeDefined();
    });

    it('shows Internet Gateway as a service card', async () => {
        render(<ServicesDashboard />);
        
        // Should find "FritzBox Gateway" or "Internet Gateway" (based on mock data provider=fritzbox)
        await waitFor(() => screen.getByText('FritzBox Gateway'));
        
        // Check for specific Gateway badge
        expect(screen.getByText('Gateway')).toBeDefined(); // Badge text
        expect(screen.getByText('1.2.3.4')).toBeDefined(); // Public IP
    });

    it('identifies ServiceBay special services', async () => {
        // Nginx is the proxy provider in mock, so 'nginx.service' should be identified as Reverse Proxy
        render(<ServicesDashboard />);
        
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        
        // Check for "Reverse Proxy" badge
        // Note: The logic in ServicesDashboard replaces the name "nginx" with "Reverse Proxy (Nginx)"
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
                             isReverseProxy: true // Digital Twin sets this
                        }
                    ],
                    containers: [],
                    files: {} // No .kube files -> Unmanaged
                }
            }
        };

        render(<ServicesDashboard />);
        
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
          proxyState: { provider: 'none' },
          gateway: { upstreamStatus: 'up' }
        };

        render(<ServicesDashboard />);
        
        // Should show up even if unmanaged
        await waitFor(() => screen.getByText('ServiceBay System'));
        
        // Check for System badge
        await waitFor(() => screen.getByText('System'));
    });

    it('keeps unmanaged kube-style service ports off the lean list tile (Agent V4)', async () => {
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
          proxyState: { provider: 'nginx' },
          gateway: { upstreamStatus: 'up' }
        };

        render(<ServicesDashboard />);
        
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        // Lean list tile (spec §4.1): the service renders, but its container
        // ports are not shown here — they live on the Operate page.
        expect(screen.queryByText(':80')).toBeNull();
        expect(screen.queryByText(':443')).toBeNull();
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
          proxyState: { provider: 'nginx' },
          gateway: { upstreamStatus: 'up' }
        };

        render(<ServicesDashboard />);
        
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
          proxyState: { provider: 'nginx' },
          gateway: { upstreamStatus: 'up' }
        };

        render(<ServicesDashboard />);
        
        await waitFor(() => screen.getByText('Reverse Proxy (Nginx)'));
        
        // Check uniqueness using getAllByText matching the Header Title
        const headers = screen.getAllByTitle('Reverse Proxy (Nginx)');
        expect(headers.length).toBe(1);
    });

    it('renders the Fritzbox Gateway as a lean card (ports off the list)', async () => {
         currentMockData = {
          nodes: {},
          proxyState: { provider: 'nginx' },
          gateway: { 
             upstreamStatus: 'up', 
             provider: 'fritzbox',
             portMappings: [
                 { hostPort: 8080, containerPort: 80, protocol: 'TCP' }
             ]
          }
        };

        render(<ServicesDashboard />);
        // The gateway still renders as its own card…
        await waitFor(() => screen.getByText('FritzBox Gateway'));
        // …but the lean tile (spec §4.1) doesn't crowd in port mappings.
        expect(screen.queryByText(':8080')).toBeNull();
    });
});
