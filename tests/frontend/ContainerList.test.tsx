/* eslint-disable @typescript-eslint/no-explicit-any */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ContainerList from '@/components/ContainerList';

vi.mock('@/components/ContainerLogsPanel', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="logs-panel">
      <button onClick={onClose}>close-logs</button>
    </div>
  ),
}));

// Mock Hook
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: vi.fn()
}));
vi.mock('@/hooks/useContainerActions', () => ({
  useContainerActions: () => ({
    openActions: vi.fn(),
    closeActions: vi.fn(),
    overlay: null,
    isOpen: false,
  }),
}));
vi.mock('@/hooks/useEscapeKey', () => ({ useEscapeKey: () => {} }));

import { useDigitalTwin } from '@/hooks/useDigitalTwin';

describe('ContainerList', () => {
    it('renders "Connecting" state when twin is null', () => {
        (useDigitalTwin as any).mockReturnValue({ data: null, loading: true });
        render(<ContainerList />);
        expect(screen.getByText('Connecting to Digital Twin...')).toBeDefined();
    });

    it('renders "No running containers" when list is empty', () => {
        (useDigitalTwin as any).mockReturnValue({ 
            data: { nodes: {} }, 
            loading: false 
        });
        render(<ContainerList />);
        expect(screen.getByText('No running containers found.')).toBeDefined();
    });

    it('renders a list of containers from multiple nodes', () => {
        (useDigitalTwin as any).mockReturnValue({ 
            data: { 
                nodes: {
                    'Local': {
                        containers: [
                            { id: '123456789012', image: 'nginx:latest', state: 'running', status: 'Up 2 hours', names: ['web'] }
                        ]
                    },
                    'Remote': {
                        containers: [
                            { id: 'abcdef123456', image: 'redis:alpine', state: 'exited', status: 'Exited (0)', names: ['cache'] }
                        ]
                    }
                }
            }, 
            loading: false 
        });

        render(<ContainerList />);

        // Check if both containers are rendered as cards (name + image + node).
        expect(screen.getByText('web')).toBeDefined();
        expect(screen.getByText('nginx:latest')).toBeDefined();
        expect(screen.getByText('Local')).toBeDefined();

        expect(screen.getByText('cache')).toBeDefined();
        expect(screen.getByText('redis:alpine')).toBeDefined();
        expect(screen.getByText('Remote')).toBeDefined();
    });
});

// #2391: the service Operate page's "Logs" quick action drives this prop. It has
// to survive being asked twice — a user who opens the log drawer, closes it, and
// clicks Logs again must get the drawer back, not a swallowed one-shot request.
describe('ContainerList initial drawer (#2391)', () => {
    const containers = [
        { id: '123456789012', names: ['web'], image: 'nginx:latest', state: 'running', status: 'Up 2 hours' },
    ] as any;

    const drawer = (nonce: number) => ({ containerId: '123456789012', mode: 'logs' as const, nonce });

    it('opens the requested log drawer, and re-opens it when the request is re-fired with a new nonce', () => {
        (useDigitalTwin as any).mockReturnValue({ data: null, loading: false });

        const { rerender } = render(<ContainerList containers={containers} initialDrawer={drawer(1)} />);
        expect(screen.getByTestId('logs-panel')).toBeDefined();

        fireEvent.click(screen.getByText('close-logs'));
        expect(screen.queryByTestId('logs-panel')).toBeNull();

        // Same request, same nonce — the already-handled guard keeps it closed.
        rerender(<ContainerList containers={containers} initialDrawer={drawer(1)} />);
        expect(screen.queryByTestId('logs-panel')).toBeNull();

        // A fresh click bumps the nonce — the drawer comes back.
        rerender(<ContainerList containers={containers} initialDrawer={drawer(2)} />);
        expect(screen.getByTestId('logs-panel')).toBeDefined();
    });
});
