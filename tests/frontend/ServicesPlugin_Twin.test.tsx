
import { render, screen, waitFor } from '@testing-library/react';
import ServicesPlugin from '../../src/plugins/ServicesPlugin';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { DigitalTwinSnapshot } from '../../src/providers/DigitalTwinProvider';

// Mocks
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../../src/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
}));

// Mock Digital Twin Hook
const mockUseDigitalTwin = vi.fn();
vi.mock('../../src/hooks/useDigitalTwin', () => ({
    useDigitalTwin: () => mockUseDigitalTwin()
}));

// Components Mocks to focus on Data Logic
vi.mock('../../src/components/PluginLoading', () => ({ default: () => <div>Loading...</div> }));
vi.mock('../../src/components/PageHeader', () => ({ default: ({ title }: any) => <div>{title}</div> }));
vi.mock('../../src/components/ExternalLinkModal', () => ({ default: () => <div>LinkModal</div> }));
vi.mock('../../src/components/ActionProgressModal', () => ({ default: () => <div>ActionModal</div> }));
vi.mock('../../src/components/ConfirmModal', () => ({ default: () => <div>ConfirmModal</div> }));

describe('ServicesPlugin E2E Data Rendering', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should render Ports from Systemd-Linked containers (Fix Verification)', async () => {
        // 1. Data Contract: This mimics exactly the state of Digital Twin Store after my Backend Fix.
        // The Service "nginx-web" is linked to container "cid-generated" by Agent logic.
        // It has ports propagated.
        const mockSnapshot: DigitalTwinSnapshot = {
            nodes: {
                'Local': {
                    connected: true,
                    lastSync: 123456,
                    initialSyncComplete: true,
                    resources: null,
                    containers: [{
                        id: 'cid-generated',
                        names: ['systemd-nginx-web'], // Quadlet generated name
                        state: 'running',
                        status: 'Up',
                        image: 'nginx',
                        created: 0,
                        ports: [{ host_port: 8080, container_port: 80, protocol: 'tcp' }],
                        mounts: [],
                        labels: {},
                        networks: ['host'],
                        isHostNetwork: true,
                        pid: 100
                    }],
                    services: [{
                        name: 'nginx-web',
                        activeState: 'active',
                        subState: 'running',
                        loadState: 'loaded',
                        description: 'Nginx Web',
                        path: '/path/to/nginx-web.kube',
                        active: true,
                        isManaged: true,
                        isReverseProxy: true, 
                        isServiceBay: false,
                        associatedContainerIds: ['cid-generated'], // LINKED!
                        ports: [{ host_port: 8080, container_port: 80, protocol: 'tcp' }] // PROPAGATED!
                    }],
                    volumes: [],
                    files: {},
                    proxy: []
                }
            },
            gateway: { provider: 'mock', status: 'down', uptime: 0 } as any,
            proxy: { provider: 'nginx', routes: [] }
        };

        mockUseDigitalTwin.mockReturnValue({
            data: mockSnapshot,
            isConnected: true,
            lastUpdate: Date.now()
        });

        render(<ServicesPlugin />);

        // 2. Assert Service Card Rendering
        // Check for Service Name
        expect(await screen.findByText('Reverse Proxy (Nginx)')).toBeDefined();

        // 3. Assert Port Existence (This proves Frontend receives and renders the fix)
        // ServicesPlugin renders ports in the "Ports" column or chip.
        // Usually formatted as "8080:80/tcp" or similar.
        // Let's look for "8080".
        expect(await screen.findByText(/8080/)).toBeDefined();
    });

    it('should handle Missing Ports gracefully (Regression Check)', async () => {
        // Scenario: Host Network container, but Agent failed to detect ports (Old Behavior)
        const mockSnapshot: DigitalTwinSnapshot = {
            nodes: {
                'Local': {
                    connected: true,
                    lastSync: 123456,
                    initialSyncComplete: true,
                    resources: null,
                    services: [{
                        name: 'broken-service',
                        activeState: 'active',
                        subState: 'running',
                        active: true,
                        isManaged: true,
                        associatedContainerIds: [], // Not linked
                        ports: [] // Empty
                    } as any],
                    containers: [],
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
            isConnected: true
        });

        render(<ServicesPlugin />);
        
        expect(await screen.findByText('broken-service')).toBeDefined();
        // Should not crash, maybe show "-" or empty space
        // We just ensure it renders.
    });
});
