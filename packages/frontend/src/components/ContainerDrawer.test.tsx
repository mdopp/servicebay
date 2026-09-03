/**
 * ContainerDrawer (#2734) — the one container Logs/Terminal drawer, extracted
 * out of ContainerList so ServicesDashboard stops carrying a near-identical
 * copy. Locks the open/closed contract and the twin→drawer data mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ContainerDrawer, { toContainerDrawerData } from './ContainerDrawer';

vi.mock('@/components/ContainerLogsPanel', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="logs-panel">
      <button onClick={onClose}>close-logs</button>
    </div>
  ),
}));

vi.mock('@/components/Terminal', () => ({
  default: () => <div data-testid="terminal" />,
}));

const data = toContainerDrawerData({
  id: 'abcdef0123456789',
  names: ['/immich-server'],
  image: 'ghcr.io/immich-app/immich-server:v1.0',
  state: 'running',
  status: 'Up 2 hours',
  nodeName: 'Local',
  ports: [{ containerPort: 2283, hostPort: 2283, protocol: 'tcp' }],
});

describe('toContainerDrawerData', () => {
  it('normalises the leading-slash container name and defaults the port shape', () => {
    expect(data.name).toBe('immich-server');
    expect(data.ports?.[0]).toMatchObject({ containerPort: 2283, hostPort: 2283, protocol: 'tcp' });
    expect(data.hideMeta).toBe(true);
  });

  it('falls back to the id when the twin carries no names', () => {
    expect(toContainerDrawerData({ id: 'deadbeef' }).name).toBe('deadbeef');
  });
});

describe('ContainerDrawer', () => {
  it('renders nothing while closed (no mode, or no container)', () => {
    const { container: a } = render(<ContainerDrawer mode={null} container={data} onClose={() => {}} />);
    expect(a.innerHTML).toBe('');
    const { container: b } = render(<ContainerDrawer mode="logs" container={null} onClose={() => {}} />);
    expect(b.innerHTML).toBe('');
  });

  it('opens the logs panel in logs mode and wires its close affordance', () => {
    const onClose = vi.fn();
    render(<ContainerDrawer mode="logs" container={data} onClose={onClose} />);
    expect(screen.getByTestId('logs-panel')).toBeDefined();
    screen.getByText('close-logs').click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens the terminal header in terminal mode and closes on the X button', () => {
    const onClose = vi.fn();
    render(<ContainerDrawer mode="terminal" container={data} onClose={onClose} />);
    expect(screen.getByText('Terminal')).toBeDefined();
    expect(screen.getByText('immich-server')).toBeDefined();
    screen.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
