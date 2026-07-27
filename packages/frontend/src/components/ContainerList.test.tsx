/**
 * ContainerList is the canonical container-list component (#2367): the Status →
 * Containers card layout with a per-container Logs / Terminal / Actions row,
 * shared by Service → Containers so both views render identically and Service
 * gains the "open terminal" action. (Supersedes the #2078 DataTable, which was
 * the divergent Service-only list this unification removed.)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EnrichedContainer } from '@servicebay/api-client';
import ContainerList from './ContainerList';

vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({ data: null }),
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

function container(over: Partial<EnrichedContainer> = {}): Partial<EnrichedContainer> {
  return {
    id: 'abcdef0123456789',
    names: ['immich-server'],
    image: 'ghcr.io/immich-app/immich-server:v1.0',
    state: 'running',
    status: 'Up 2 hours',
    nodeName: 'Local',
    verifiedDomains: ['photos.dopp.cloud'],
    ...over,
  };
}

describe('ContainerList (#2367 canonical card layout)', () => {
  it('renders a container card with name, image, node and domain link', () => {
    render(<ContainerList containers={[container()]} />);
    expect(screen.getByText('Local')).toBeDefined();
    expect(screen.getByText('immich-server')).toBeDefined();
    expect(screen.getByText('ghcr.io/immich-app/immich-server:v1.0')).toBeDefined();
    // a verified domain stays a clickable link (Service-only feature preserved)
    const link = screen.getByRole('link', { name: 'photos.dopp.cloud' });
    expect(link.getAttribute('href')).toBe('https://photos.dopp.cloud');
  });

  it('exposes the Logs, Terminal and Actions per-container controls', () => {
    render(<ContainerList containers={[container()]} />);
    // The "open terminal" action Service/Container gained from Status.
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Logs & Info' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Actions' })).toBeDefined();
  });

  it('uses no random per-column colour literals (the old "bunte Tabelle")', () => {
    const { container: root } = render(<ContainerList containers={[container()]} />);
    const html = root.innerHTML;
    for (const banned of ['text-purple-400', 'text-blue-400', 'text-green-400', 'text-yellow-400']) {
      expect(html).not.toContain(banned);
    }
  });
});
