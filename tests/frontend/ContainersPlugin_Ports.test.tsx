/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen } from '@testing-library/react';
import ContainersPlugin from '../../src/plugins/ContainersPlugin';
import { vi, describe, it, expect } from 'vitest';
import { DigitalTwinSnapshot } from '../../src/providers/DigitalTwinProvider';

// Mocks
const mockUseRouter = vi.fn(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => mockUseRouter(),
}));

vi.mock('../../src/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
}));

// Mock Digital Twin Hook
const mockUseDigitalTwin = vi.fn();
vi.mock('../../src/hooks/useDigitalTwin', () => ({
    useDigitalTwin: () => mockUseDigitalTwin()
}));

// Mock Components
vi.mock('../../src/components/PluginLoading', () => ({ default: () => <div>Loading...</div> }));
vi.mock('../../src/components/PageHeader', () => ({ 
    default: ({ title, children }: any) => <div><h1>{title}</h1>{children}</div> 
}));
vi.mock('../../src/components/ConfirmModal', () => ({ default: () => null }));

describe('ContainersPlugin Port Rendering', () => {

    it('should render merged ports for Host Network containers correctly', async () => {
        // 1. Data Structure matching what Agent V4 sends (and what DigitalTwinStore should hold)
        // We know from agent_debug_http.json that:
        // "ports": [{"host_port": 8080, "container_port": 8080, "protocol": "tcp"}]
        const mockSnapshot: DigitalTwinSnapshot = {
            nodes: {
                'Local': {
                    connected: true,
                    lastSync: 123456,
                    initialSyncComplete: true,
                    resources: null,
                    containers: [{
                        id: 'cid1',
                        names: ['debug-http'],
                        image: 'python:alpine',
                        state: 'running',
                        status: 'Up',
                        created: 0,
                        mounts: [],
                        labels: {},
                        networks: ['host'],
                        isHostNetwork: true,
                        // This is the KEY format from Agent V4
                        ports: [
                            { hostPort: 8080, containerPort: 8080, protocol: 'tcp' }
                        ],
                        pid: 123
                    }],
                    services: [],
                    volumes: [],
                    files: {},
                    proxy: []
                }
            },
            gateway: { provider: 'mock' } as any,
            proxy: { provider: 'nginx', routes: [] }
        };

        mockUseDigitalTwin.mockReturnValue({
            data: mockSnapshot,
            isConnected: true,
            isNodeSynced: () => true
        });

        // 2. Render
        render(<ContainersPlugin />);

        // 3. Find Container
        expect(await screen.findByText('debug-http')).toBeDefined();

        // 4. Find Link/Badge for Port 8080
        // The display logic is `${hostPort}/${protocol}` if ports are same
        // So we expect "8080/tcp"
        expect(await screen.findByText('8080/tcp')).toBeDefined();
    });

    it('should handle missing PublicPort gracefully (Legacy format vs New format)', async () => {
         // Some older agents or Podman versions might send different keys.
         // ContainersPlugin maps keys:
         // host_port: p.hostPort (undefined)
         // And render logic checks PublicPort || host_port
         
         const mockSnapshot: DigitalTwinSnapshot = {
            nodes: {
                'Local': {
                    connected: true,
                    lastSync: 123456,
                    initialSyncComplete: true,
                    resources: null,
                    containers: [{
                        id: 'cid2',
                        names: ['legacy-container'], 
                        image: 'nginx',
                        state: 'running',
                        status: 'Up',
                        created: 0,
                        mounts: [],
                        labels: {},
                        networks: [],
                        // Simulate what might go wrong?
                        // If Agent V4 sends `host_port` but Plugin maps `hostPort`?
                        // Let's check Plugin code again:
                        // list.push({ Ports: (ec.ports || []).map(p => ({ host_port: p.hostPort ... })) })
                        // WAIT! ec.ports has `host_port` (snake_case) from Agent.
                        // But the map implementation does `host_port: p.hostPort`.
                        // If `p` has `host_port`, `p.hostPort` is undefined!
                        // This might be the bug!
                        ports: [
                            { hostPort: 80, containerPort: 80, protocol: 'tcp' }
                        ],
                        pid: 123 
                    }],
                    services: [],
                    volumes: [],
                    files: {},
                    proxy: []
                }
            },
            gateway: { provider: 'mock' } as any,
            proxy: { provider: 'nginx', routes: [] }
        };
        
        mockUseDigitalTwin.mockReturnValue({
            data: mockSnapshot,
            isConnected: true,
            isNodeSynced: () => true
        });

        render(<ContainersPlugin />);

        expect(await screen.findByText('legacy-container')).toBeDefined();
        
        // If the bug exists, this will fail
        expect(await screen.findByText('80/tcp')).toBeDefined();
    });
});
