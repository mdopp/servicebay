
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ContainerList from '../../src/components/ContainerList';

// Mock Hook
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: vi.fn()
}));

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

        // Check if both containers are rendered
        expect(screen.getByText('123456789012')).toBeDefined();
        expect(screen.getByText('nginx:latest')).toBeDefined();
        expect(screen.getByText('Local')).toBeDefined();

        expect(screen.getByText('abcdef123456')).toBeDefined();
        expect(screen.getByText('redis:alpine')).toBeDefined();
        expect(screen.getByText('Remote')).toBeDefined();
    });
});
