/**
 * MaintenanceChatEmbed (servicebay#1781) — the maintenance chat is an iframe of
 * solilos-chat with the embed contract on the query string. These lock the URL
 * shape (embed flag, locked persona, ServiceBay accent) and the gating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MaintenanceChatEmbed from './MaintenanceChatEmbed';

const useSystemMode = vi.fn();
vi.mock('@/hooks/useSystemMode', () => ({ useSystemMode: () => useSystemMode() }));

describe('MaintenanceChatEmbed', () => {
  beforeEach(() => useSystemMode.mockReset());

  it('embeds chat.<publicDomain> with the embed/persona/accent contract', () => {
    useSystemMode.mockReturnValue({ publicDomain: 'dopp.cloud' });
    const { container } = render(<MaintenanceChatEmbed />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const src = iframe!.getAttribute('src')!;
    expect(src).toContain('https://chat.dopp.cloud/');
    expect(src).toContain('embed=1');
    expect(src).toContain('persona=servicebay-maintenance');
    // ServiceBay blue palette, not Sol-orange
    expect(src).toContain('accent=3b82f6');
    expect(src).toContain('accent2=2563eb');
  });

  it('shows an onboarding notice (no iframe) when the box has no public domain', () => {
    useSystemMode.mockReturnValue({ publicDomain: null });
    const { container } = render(<MaintenanceChatEmbed />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/public domain/i)).toBeTruthy();
  });

  it('shows a loading notice (no iframe) before the system mode resolves', () => {
    useSystemMode.mockReturnValue(null);
    const { container } = render(<MaintenanceChatEmbed />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });
});
