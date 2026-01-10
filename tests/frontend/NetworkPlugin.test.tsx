
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

// 1. Mock Hooks
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: vi.fn()
}));

vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ showToast: vi.fn() })
}));

// 2. Mock 'react-highlight-words' used by something imported (RegistryPlugin?) or just in case
vi.mock('react-highlight-words', () => ({
    default: ({ searchWords, textToHighlight }: any) => <>{textToHighlight}</>
}));

// 3. IMPORTANT: Mock @xyflow/react (React Flow)
// React Flow uses ResizeObserver which is missing in JSDOM, and complex Canvas logic
vi.mock('@xyflow/react', () => {
    return {
        ReactFlow: ({ nodes, edges, onNodeClick }: any) => (
            <div data-testid="react-flow-mock">
                <div data-testid="flow-nodes-count">{nodes?.length || 0}</div>
                <div data-testid="flow-edges-count">{edges?.length || 0}</div>
                {nodes?.map((n: any) => (
                    <div 
                        key={n.id} 
                        data-testid={`node-${n.id}`}
                        onClick={() => onNodeClick && onNodeClick({}, n)}
                    >
                        {n.data.label}
                    </div>
                ))}
            </div>
        ),
        Background: () => <div data-testid="flow-background" />,
        Controls: () => <div data-testid="flow-controls" />,
        MiniMap: () => <div data-testid="flow-minimap" />,
        Panel: ({ children }: any) => <div>{children}</div>,
        useNodesState: (initial: any) => React.useState(initial),
        useEdgesState: (initial: any) => React.useState(initial),
        addEdge: vi.fn(),
        getSmoothStepPath: vi.fn().mockReturnValue(['M0 0', 0, 0]),
        BaseEdge: () => null,
        EdgeLabelRenderer: ({ children }: any) => <div>{children}</div>,
        MarkerType: { ArrowClosed: 'arrowclosed' },
        Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
        Handle: () => null
    };
});

// 4. Mock layout engine
vi.mock('@/lib/network/layout', () => ({
    getLayoutedElements: (nodes: any, edges: any) => Promise.resolve({ nodes, edges })
}));

// 5. Mock Next.js Navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => ({ get: vi.fn() })
}));

// 6. Mock EventSource (missing in JSDOM)
Object.defineProperty(global, 'EventSource', {
    value: class MockEventSource {
        url: string;
        onmessage: any;
        constructor(url: string) { this.url = url; }
        close() {}
    }
});

import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import NetworkPlugin from '../../src/plugins/NetworkPlugin';

describe('NetworkPlugin (Graph)', () => {
    
    beforeEach(() => {
        vi.clearAllMocks();
        // Default Mock Return
        (useDigitalTwin as any).mockReturnValue({ 
            data: { 
                nodes: {
                    'Local': {
                        containers: [],
                        services: [],
                        connected: true
                    }
                },
                gateway: { provider: 'mock', status: 'up' }
            }, 
            loading: false 
        });
    });

    it('renders the graph container', async () => {
        render(<NetworkPlugin />);
        expect(screen.getByTestId('react-flow-mock')).toBeDefined();
    });

    it('renders global infrastructure nodes (Internet, Gateway)', async () => {
        // The Plugin constructs these using `useNetworkGraph` hook logic internally?
        // Wait, `NetworkPlugin` imports `getGraph` from API probably? 
        // Checking source... 
        // Actually, `NetworkPlugin` fetches data via `fetch('/api/network/graph')` or `useNetworkGraph` hook.
        // Let's check imports in the file provided...
        // `import { useDigitalTwin } from '@/hooks/useDigitalTwin';`
        // It seems it MIGHT use `useDigitalTwin` OR fetch API.
        
        // Let's simulate the `fetch` call if it does that.
        // Or if it uses `useDigitalTwin` to build the graph client-side.
        // Wait, previous file content shows:
        // `const { data: twin } = useDigitalTwin();` but deeper down likely logic to build nodes.
        
        // Actually the provided file `NetworkPlugin.tsx` uses `fetch('/api/network/graph?node=' + targetNode)` inside a useEffect.
        // We need to mock `global.fetch`.
        
        const mockGraph = {
            nodes: [
                { id: 'internet', type: 'internet', data: { label: 'Internet' } },
                { id: 'gateway', type: 'router', data: { label: 'Gateway' } }
            ],
            edges: [
                { id: 'e1', source: 'internet', target: 'gateway' }
            ]
        };

        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockGraph
        });

        render(<NetworkPlugin />);
        
        await waitFor(() => {
            expect(screen.getByTestId('node-internet')).toBeDefined();
            expect(screen.getByTestId('node-gateway')).toBeDefined();
        });
    });

    it('handles empty graph gracefully', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ nodes: [], edges: [] })
        });

        render(<NetworkPlugin />);
        
        await waitFor(() => {
            expect(screen.getByTestId('flow-nodes-count').textContent).toBe('0');
        });
    });
});
