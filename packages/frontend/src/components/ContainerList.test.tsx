/**
 * ContainerList migration (#2078) — the Operate Containers tab table. Operator
 * called the old table "bunt": Node purple, ID blue, Image green, Names orange.
 * These tests lock the rebuild onto the shared <DataTable> primitive: one calm
 * surface, no random per-column colour literals.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EnrichedContainer } from '@servicebay/api-client';
import ContainerList from './ContainerList';

vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({ data: null }),
}));

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

describe('ContainerList (#2078 DataTable migration)', () => {
  it('renders the rows via DataTable and shows the cell content', () => {
    render(<ContainerList containers={[container()]} />);
    expect(screen.getByText('Local')).toBeDefined();
    expect(screen.getByText('immich-server')).toBeDefined();
    // 12-char truncated id
    expect(screen.getByText('abcdef012345')).toBeDefined();
    // a verified domain stays a clickable link
    const link = screen.getByRole('link', { name: 'photos.dopp.cloud' });
    expect(link.getAttribute('href')).toBe('https://photos.dopp.cloud');
  });

  it('uses no random per-column colour literals (the old "bunte Tabelle")', () => {
    const { container: root } = render(<ContainerList containers={[container()]} />);
    const html = root.innerHTML;
    // none of the old per-column rainbow colours
    for (const banned of ['text-purple-400', 'text-blue-400', 'text-green-400', 'text-yellow-400']) {
      expect(html).not.toContain(banned);
    }
    // the calm DataTable surface: a token-bordered table wrapper
    expect(root.querySelector('table')).not.toBeNull();
  });
});
