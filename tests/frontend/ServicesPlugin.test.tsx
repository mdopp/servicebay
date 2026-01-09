
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
        { name: 'nginx.service', activeState: 'active', subState: 'running', type: 'container', description: 'Nginx Web Server' },
        { name: 'redis.service', activeState: 'active', subState: 'running', type: 'container', description: 'Redis Cache' }
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
});
