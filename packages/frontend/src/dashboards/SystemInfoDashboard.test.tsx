/**
 * SystemInfoContent layout tests (#1706/#1707).
 *
 * Asserts the System health "Resources" grid layout after the two operator
 * UI-polish changes:
 *  - #1706: DNS resolvers is folded into the single Network Interfaces card as
 *    a labelled sub-section (no standalone "DNS Resolvers" card), with the
 *    public-resolver split-horizon warning kept prominent.
 *  - #1707: Graphics + Network Interfaces cards are half-width (no
 *    `md:col-span-2`), like Compute/Storage.
 *
 * The component is hook-driven (digital twin + socket + server actions), so
 * those are mocked to feed a deterministic resources snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const twinRef: { current: unknown } = { current: null };

vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({ data: twinRef.current }),
}));
vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null, isConnected: false }),
}));
vi.mock('@/app/actions/nodes', () => ({
  getNodes: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/app/actions/system', () => ({
  getSystemUpdates: vi.fn().mockResolvedValue({ count: 0, list: [] }),
}));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

import { SystemInfoContent } from './SystemInfoDashboard';

function makeTwin(dnsServers: string[], boxIp = '192.168.178.100') {
  return {
    serverName: 'box',
    nodes: {
      Local: {
        resources: {
          cpuUsage: 10,
          memoryUsage: 1_000_000,
          totalMemory: 8_000_000,
          cpu: { model: 'Test CPU', cores: 4 },
          os: {
            hostname: 'box',
            platform: 'Fedora CoreOS',
            arch: 'x86_64',
            uptime: 3600,
          },
          disks: [{ mountpoint: '/', type: 'xfs', total: 100, used: 50 }],
          network: {
            eth0: [{ internal: false, family: 'IPv4', address: boxIp }],
          },
          gpus: [{ uuid: 'gpu-1', name: 'Test GPU', vendor: 'nvidia' }],
          dnsResolvers: { servers: dnsServers, source: 'resolvectl' },
        },
      },
    },
  };
}

/** The card container <div> that holds the given heading text. */
function cardFor(headingText: string): HTMLElement {
  const heading = screen.getByText(headingText);
  // h3 heading -> parent div is the card container.
  const card = heading.closest('div');
  if (!card) throw new Error(`no card container for "${headingText}"`);
  return card;
}

describe('SystemInfoContent layout (#1706/#1707)', () => {
  beforeEach(() => {
    twinRef.current = null;
  });

  it('renders ONE Network card with a folded-in DNS resolvers sub-section, no standalone DNS card', () => {
    twinRef.current = makeTwin(['127.0.0.1', '192.168.178.1']);
    render(<SystemInfoContent />);

    // Single combined Network card.
    expect(screen.getByText('Network Interfaces')).toBeDefined();
    // No standalone "DNS Resolvers" card heading (the old h3).
    expect(screen.queryByText(/DNS Resolvers \(/)).toBeNull();
    // The folded-in labelled sub-section heading lives inside the Network card.
    const dnsSub = screen.getByText(/DNS resolvers \(/);
    const networkCard = cardFor('Network Interfaces');
    expect(networkCard.contains(dnsSub)).toBe(true);
    // Resolver rows + source line render inside the same card.
    expect(networkCard.textContent).toContain('127.0.0.1');
    expect(networkCard.textContent).toContain('192.168.178.1');
    expect(networkCard.textContent).toContain('source: resolvectl');
  });

  it('keeps the public-resolver split-horizon warning prominent in the folded sub-section', () => {
    twinRef.current = makeTwin(['8.8.8.8']);
    render(<SystemInfoContent />);

    const networkCard = cardFor('Network Interfaces');
    const warning = screen.getByText('A public DNS resolver is configured');
    expect(networkCard.contains(warning)).toBe(true);
  });

  it('renders Graphics + Network Interfaces half-width (no md:col-span-2), like Compute/Storage', () => {
    twinRef.current = makeTwin(['192.168.178.1']);
    render(<SystemInfoContent />);

    const graphicsCard = cardFor('Graphics (1)');
    const networkCard = cardFor('Network Interfaces');
    expect(graphicsCard.className).not.toContain('md:col-span-2');
    expect(networkCard.className).not.toContain('md:col-span-2');
  });
});
