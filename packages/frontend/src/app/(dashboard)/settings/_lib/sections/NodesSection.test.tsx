/**
 * NodesSection — design-system migration (#2100 cluster 2). Asserts the section
 * renders on token surfaces with Badge health chips and Button-primitive actions
 * (no raw colour literals), and that add/remove still call the context methods.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

const SECOND_NODE: PodmanConnection = {
  Name: 'attic',
  URI: 'ssh://core@attic:22',
  Identity: '/app/data/ssh/id_rsa',
  Default: false,
} as PodmanConnection;

// Mutable so a test can render the two-node list without a second mock factory.
let nodes: PodmanConnection[] = [NODE];

vi.mock('../SettingsContext', () => ({
  useSettings: () => ({
    nodes,
    nodeHealth: {
      box: { loading: false, online: true, auth: true },
      attic: { loading: false, online: true, auth: true },
    },
    submitNode,
    removeNode,
    setDefault: vi.fn(),
    openSSHModal,
    parseDestination: () => ({ host: 'host', port: 22, user: 'core' }),
    router: { push: vi.fn() },
  }),
}));

describe('NodesSection (#2100 settings migration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nodes = [NODE];
    removeNode.mockResolvedValue(undefined);
  });

  it('renders its controls with no inner duplicate title and no raw colour literals (#2109)', () => {
    const { container } = render(<NodesSection />);
    // No "System Connections" h3 inside the section — the SettingDisclosure
    // header carries the icon+title+description now (#2109).
    expect(container.querySelector('h3')).toBeNull();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo|green|yellow)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('shows a Connected health Badge for an online+authed node', () => {
    render(<NodesSection />);
    expect(screen.getByText('Connected')).toBeDefined();
  });

  it('Remove eventually calls removeNode, via the confirm step (behaviour preserved)', async () => {
    render(<NodesSection />);
    fireEvent.click(screen.getByTitle('Remove Node'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove node' }));
    });
    expect(removeNode).toHaveBeenCalledWith('box');
  });
});

/**
 * #2458 — the trash icon used to call removeNode() straight from onClick, so a
 * mis-click silently dropped a configured node (and its health checks) with no
 * undo, unlike every other destructive settings action. These specs reproduce
 * that: the first one FAILS against the pre-fix component (removeNode fires on
 * the trash click and no dialog exists).
 */
describe('NodesSection — node delete is gated by a ConfirmModal (#2458)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nodes = [NODE];
    removeNode.mockResolvedValue(undefined);
  });

  const clickTrash = (title = 'Remove Node') => fireEvent.click(screen.getByTitle(title));

  it('no dialog is mounted until the trash icon is clicked', () => {
    render(<NodesSection />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking the trash icon opens a ConfirmModal and does NOT call removeNode', () => {
    render(<NodesSection />);
    clickTrash();

    // The dialog is the shared ConfirmModal: aria-modal dialog, labelled by its
    // own title element, with an explicit warning and a destructive confirm.
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('confirm-modal-title');
    expect(document.getElementById('confirm-modal-title')?.textContent).toBe('Remove Node');
    expect(dialog.textContent).toMatch(/cannot be undone/i);
    // Names the node being removed, so the operator can see what they hit.
    expect(dialog.textContent).toContain('box');

    // The whole point of the issue: nothing destructive has happened yet.
    expect(removeNode).not.toHaveBeenCalled();
  });

  it('confirming the dialog calls removeNode with that node and closes it', async () => {
    render(<NodesSection />);
    clickTrash();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove node' }));
    });

    expect(removeNode).toHaveBeenCalledTimes(1);
    expect(removeNode).toHaveBeenCalledWith('box');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling the dialog closes it and never calls removeNode', () => {
    render(<NodesSection />);
    clickTrash();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(removeNode).not.toHaveBeenCalled();
  });

  it('Escape dismisses the dialog without removing the node', () => {
    render(<NodesSection />);
    clickTrash();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(removeNode).not.toHaveBeenCalled();
  });

  it('confirms the node whose trash icon was clicked, not the first in the list', async () => {
    nodes = [NODE, SECOND_NODE];
    render(<NodesSection />);

    const trashButtons = screen.getAllByTitle('Remove Node');
    expect(trashButtons).toHaveLength(2);
    fireEvent.click(trashButtons[1]);

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('attic');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove node' }));
    });
    expect(removeNode).toHaveBeenCalledWith('attic');
  });

  it('a second confirm click while the removal is in flight cannot double-fire removeNode', async () => {
    let release!: () => void;
    removeNode.mockImplementation(() => new Promise<void>(resolve => { release = () => resolve(); }));

    render(<NodesSection />);
    clickTrash();
    const confirm = screen.getByRole('button', { name: 'Remove node' });
    fireEvent.click(confirm);

    // In-flight: the confirm button is disabled and relabelled, and the dialog
    // stays open so the operator isn't dropped back into an ambiguous state.
    const inFlight = screen.getByRole('button', { name: 'Removing…' });
    expect((inFlight as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(inFlight);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(removeNode).toHaveBeenCalledTimes(1);

    await act(async () => { release(); });
    expect(removeNode).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed removal still closes the dialog and leaves the row clickable again', async () => {
    removeNode.mockRejectedValue(new Error('boom'));
    render(<NodesSection />);
    clickTrash();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove node' }));
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    // Not wedged in the "removing" state: the trash icon re-opens the dialog.
    clickTrash();
    expect(screen.getByRole('button', { name: 'Remove node' })).toBeDefined();
  });
});
