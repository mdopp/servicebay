/**
 * PortalGrid component tests — covers the ManualPairingPanel (#1253)
 * and the per-card layout invariants.
 *
 * ManualPairingPanel is pure-presentational: it takes `steps[]` from
 * the PortalCard's `manualPairing` array and renders the amber
 * "Manual setup needed" callout with each step's title, optional
 * why-note, and a copyable command block. These tests exercise that
 * path directly by passing a card with `manualPairing` populated.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PortalGrid from './PortalGrid';
import type { PortalCard } from '@/lib/portal/services';

/** Minimal valid PortalCard with no optional extras. */
const baseCard: PortalCard = {
  id: 'immich:IMMICH_SUBDOMAIN',
  name: 'immich',
  subdomainVar: 'IMMICH_SUBDOMAIN',
  label: 'Photos',
  lucideIcon: 'camera',
  icon: '',
  tagline: 'Auto-backup your family photos.',
  url: 'https://photos.home.arpa',
  body: '',
  recommendedApps: [],
  setupAssets: [],
  manualPairing: [],
};

describe('PortalGrid', () => {
  it('renders a card with its label and open button', () => {
    render(<PortalGrid cards={[baseCard]} />);
    expect(screen.getByRole('heading', { name: 'Photos' })).toBeDefined();
    expect(screen.getByRole('link', { name: /open/i })).toBeDefined();
  });

  it('does not render the manual-setup panel when manualPairing is empty', () => {
    render(<PortalGrid cards={[baseCard]} />);
    expect(screen.queryByText(/manual setup needed/i)).toBeNull();
  });

  it('renders the amber "Manual setup needed" panel when manualPairing is present (#1253)', () => {
    const card: PortalCard = {
      ...baseCard,
      id: 'hermes:HERMES_SUBDOMAIN',
      name: 'hermes',
      label: 'Hermes',
      manualPairing: [
        {
          title: 'Pair the Signal account',
          command: 'podman exec -it hermes signal-cli link -n HermesAgent',
          why: 'Scan the QR shown in the terminal with Signal → Linked devices → Link new device.',
        },
      ],
    };
    render(<PortalGrid cards={[card]} />);
    expect(screen.getByText(/manual setup needed/i)).toBeDefined();
  });

  it('renders the step title and command for each manual_pairing entry (#1253)', () => {
    const card: PortalCard = {
      ...baseCard,
      manualPairing: [
        {
          title: 'Pair the Signal account',
          command: 'podman exec -it hermes signal-cli link -n HermesAgent',
        },
      ],
    };
    render(<PortalGrid cards={[card]} />);
    expect(screen.getByText('Pair the Signal account')).toBeDefined();
    expect(screen.getByText('podman exec -it hermes signal-cli link -n HermesAgent')).toBeDefined();
  });

  it('renders the why-note when provided (#1253)', () => {
    const card: PortalCard = {
      ...baseCard,
      manualPairing: [
        {
          title: 'Pair the Signal account',
          command: 'podman exec -it hermes signal-cli link -n HermesAgent',
          why: 'Scan the QR in the terminal with Signal on your phone.',
        },
      ],
    };
    render(<PortalGrid cards={[card]} />);
    expect(screen.getByText(/scan the qr in the terminal/i)).toBeDefined();
  });

  it('renders a copy button for each command block (#1253)', () => {
    const card: PortalCard = {
      ...baseCard,
      manualPairing: [
        {
          title: 'Pair the Signal account',
          command: 'podman exec -it hermes signal-cli link -n HermesAgent',
        },
      ],
    };
    render(<PortalGrid cards={[card]} />);
    expect(screen.getByRole('button', { name: /copy command/i })).toBeDefined();
  });

  it('renders multiple manual_pairing steps (#1253)', () => {
    const card: PortalCard = {
      ...baseCard,
      manualPairing: [
        { title: 'Step one', command: 'cmd-one' },
        { title: 'Step two', command: 'cmd-two' },
      ],
    };
    render(<PortalGrid cards={[card]} />);
    expect(screen.getByText('Step one')).toBeDefined();
    expect(screen.getByText('cmd-one')).toBeDefined();
    expect(screen.getByText('Step two')).toBeDefined();
    expect(screen.getByText('cmd-two')).toBeDefined();
    // Two copy buttons — one per step.
    expect(screen.getAllByRole('button', { name: /copy command/i })).toHaveLength(2);
  });
});
