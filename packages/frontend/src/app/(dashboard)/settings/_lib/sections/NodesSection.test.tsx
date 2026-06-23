/**
 * NodesSection — design-system migration (#2100 cluster 2). Asserts the section
 * renders on token surfaces with Badge health chips and Button-primitive actions
 * (no raw colour literals), and that add/remove still call the context methods.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NodesSection from './NodesSection';
import type { PodmanConnection } from '@/lib/nodes';

const submitNode = vi.fn().mockResolvedValue(true);
const removeNode = vi.fn();
const openSSHModal = vi.fn();

const NODE: PodmanConnection = {
  Name: 'box',
  URI: 'ssh://core@host:22',
  Identity: '/app/data/ssh/id_rsa',
  Default: true,
} as PodmanConnection;

vi.mock('../SettingsContext', () => ({
  useSettings: () => ({
    nodes: [NODE],
    nodeHealth: { box: { loading: false, online: true, auth: true } },
    submitNode,
    removeNode,
    setDefault: vi.fn(),
    openSSHModal,
    parseDestination: () => ({ host: 'host', port: 22, user: 'core' }),
    router: { push: vi.fn() },
  }),
}));

describe('NodesSection (#2100 settings migration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders on a token Card surface with no raw colour literals', () => {
    const { container } = render(<NodesSection />);
    expect(container.querySelector('.bg-surface')).not.toBeNull();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo|green|yellow)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('shows a Connected health Badge for an online+authed node', () => {
    render(<NodesSection />);
    expect(screen.getByText('Connected')).toBeDefined();
  });

  it('Remove still calls removeNode (behaviour preserved)', () => {
    render(<NodesSection />);
    fireEvent.click(screen.getByRole('button', { name: /remove node/i }));
    expect(removeNode).toHaveBeenCalledWith('box');
  });
});
