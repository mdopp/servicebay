/* eslint-disable @typescript-eslint/no-explicit-any */

import { render, screen } from '@testing-library/react';
import ServicesDashboard from '@/dashboards/ServicesDashboard';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { DigitalTwinSnapshot } from '@/providers/DigitalTwinProvider';

// Mocks
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => '/services',
    useSearchParams: () => new URLSearchParams()
}));

vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
}));

// Mock Digital Twin Hook. `isNodeSynced` is provided by default —
// individual tests can override `mockUseDigitalTwin` to return a
// different shape if they need to exercise the hydration gate.
const mockUseDigitalTwin = vi.fn<() => {
    data: DigitalTwinSnapshot | null;
    isConnected: boolean;
    lastUpdate: number;
    isNodeSynced: (n?: string) => boolean;
}>(() => ({
    data: null,
    isConnected: true,
    lastUpdate: 0,
    isNodeSynced: () => true,
}));
vi.mock('@/hooks/useDigitalTwin', () => ({
    useDigitalTwin: () => mockUseDigitalTwin()
}));

// Components Mocks to focus on Data Logic
vi.mock('@/components/SectionLoading', () => ({ default: () => <div>Loading...</div> }));
vi.mock('@/components/PageHeader', () => ({ default: ({ title }: any) => <div>{title}</div> }));
vi.mock('@/components/ExternalLinkModal', () => ({ default: () => <div>LinkModal</div> }));
vi.mock('@/components/ActionProgressModal', () => ({ default: () => <div>ActionModal</div> }));
vi.mock('@/components/ConfirmModal', () => ({ default: () => <div>ConfirmModal</div> }));

describe('ServicesDashboard E2E Data Rendering', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps systemd-linked container ports off the lean list tile (Fix Verification)', async () => {
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
                        ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp' }],
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
                        ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp' }] // PROPAGATED!
                    }],
                    volumes: [],
                    files: {},
                    proxyRoutes: [],
                    nodeIPs: [],
                    unmanagedBundles: [],
                    dismissedBundles: [],
                    history: []
                }
            },
            gateway: { provider: 'mock', status: 'down', uptime: 0 } as any,
            proxyState: { provider: 'nginx', routes: [] }
        };

        mockUseDigitalTwin.mockReturnValue({
            data: mockSnapshot,
            isConnected: true,
            lastUpdate: Date.now(),
            isNodeSynced: () => true,
        });

        render(<ServicesDashboard />);

        // 2. Assert Service Card Rendering — the systemd→container link still
        // flows into the view model, so the service renders in the list.
        // (#2067: it renders twice in jsdom — desktop ServiceRow + mobile
        // ServiceCard, CSS hides one per breakpoint in a real browser.)
        expect((await screen.findAllByText('Reverse Proxy (Nginx)')).length).toBeGreaterThan(0);

        // 3. The lean list tile (spec §4.1) no longer renders ports — they live
        // on the per-service Operate page — so :8080 must NOT appear in the list.
        // (The port data-flow fix is exercised by the Operate-page container view.)
        expect(screen.queryByText(/8080/)).toBeNull();
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
                    proxyRoutes: [],
                    nodeIPs: [],
                    unmanagedBundles: [],
                    dismissedBundles: [],
                    history: []
                }
            },
            gateway: { provider: 'mock' } as any,
            proxyState: { provider: 'nginx', routes: [] }
        };

        mockUseDigitalTwin.mockReturnValue({
            data: mockSnapshot,
            isConnected: true,
            lastUpdate: Date.now(),
            isNodeSynced: () => true,
        });

        render(<ServicesDashboard />);

        expect((await screen.findAllByText('broken-service')).length).toBeGreaterThan(0);
        // Should not crash, maybe show "-" or empty space
        // We just ensure it renders.
    });
});
