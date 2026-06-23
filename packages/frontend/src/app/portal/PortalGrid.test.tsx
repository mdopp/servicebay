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
import { render, screen, fireEvent } from '@testing-library/react';
import PortalGrid from './PortalGrid';
import type { PortalCard } from '@/lib/portal/services';

/** Minimal valid PortalCard with no optional extras. */
const baseCard: PortalCard = {
  id: 'immich:IMMICH_SUBDOMAIN',
  name: 'immich',
  subdomainVar: 'IMMICH_SUBDOMAIN',
  label: 'Photos',
  category: 'Media',
  lucideIcon: 'camera',
  icon: '',
  tagline: 'Auto-backup your family photos.',
  url: 'https://photos.home.arpa',
  status: 'ok',
  primaryAction: null,
  secondaryActions: [],
  body: '',
  recommendedApps: [],
  setupAssets: [],
  manualPairing: [],
  sizeTier: 'compact',
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

  describe('BasicSync install QR asset (#1560)', () => {
    const basicSyncCard: PortalCard = {
      ...baseCard,
      id: 'file-share:SYNCTHING_SUBDOMAIN',
      name: 'file-share',
      label: 'File Share',
      setupAssets: [{ kind: 'basicsync_install_qr', description: 'Open-source Syncthing client.' }],
    };

    it('renders the install button (closed by default, no modal)', () => {
      render(<PortalGrid cards={[basicSyncCard]} />);
      expect(screen.getByRole('button', { name: /install basicsync on your phone/i })).toBeDefined();
      expect(screen.getByText('Open-source Syncthing client.')).toBeDefined();
      // Modal heading is not present until the button is clicked.
      expect(screen.queryByRole('heading', { name: /install basicsync/i })).toBeNull();
    });

    it('opens the QR modal on click and closes it on backdrop click', () => {
      render(<PortalGrid cards={[basicSyncCard]} />);
      fireEvent.click(screen.getByRole('button', { name: /install basicsync on your phone/i }));
      // Modal now shows: heading + the direct-download link.
      expect(screen.getByRole('heading', { name: /install basicsync/i })).toBeDefined();
      const link = screen.getByRole('link', { name: /open the download link directly/i });
      expect(link.getAttribute('href')).toContain('/api/system/downloads/basicsync');

      // Clicking the backdrop (the outermost overlay div) closes the modal.
      fireEvent.click(screen.getByRole('heading', { name: /install basicsync/i }).closest('div')!.parentElement!);
      expect(screen.queryByRole('heading', { name: /install basicsync/i })).toBeNull();
    });
  });

  describe('appless cards + action links (#1618)', () => {
    const applessCard: PortalCard = {
      ...baseCard,
      id: 'claude-dev:default',
      name: 'claude-dev',
      label: 'Claude Dev',
      url: '', // no subdomain → no Open-URL button
      primaryAction: {
        type: 'in_app',
        label: 'Open terminal',
        href: '/terminal?node=Local&container=claude-dev',
        desktop_only: false,
      },
    };

    it('renders the primary action as the CTA when there is no URL', () => {
      render(<PortalGrid cards={[applessCard]} />);
      // No "Open" link (no url), but the primary action link is present.
      expect(screen.queryByRole('link', { name: /^open$/i })).toBeNull();
      const cta = screen.getByRole('link', { name: /open terminal/i });
      expect(cta.getAttribute('href')).toBe('/terminal?node=Local&container=claude-dev');
    });

    it('keeps in-app deep-links in the same tab (no target=_blank)', () => {
      render(<PortalGrid cards={[applessCard]} />);
      const cta = screen.getByRole('link', { name: /open terminal/i });
      expect(cta.getAttribute('target')).toBeNull();
    });

    it('renders secondary actions as extra buttons', () => {
      const card: PortalCard = {
        ...applessCard,
        secondaryActions: [
          { type: 'external_scheme', label: 'Open in VS Code', href: 'vscode://vscode-remote/ssh-remote+box', desktop_only: true },
        ],
      };
      render(<PortalGrid cards={[card]} />);
      const vscode = screen.getByRole('link', { name: /open in vs code/i });
      expect(vscode.getAttribute('href')).toBe('vscode://vscode-remote/ssh-remote+box');
      // External scheme opens in a new tab/handoff.
      expect(vscode.getAttribute('target')).toBe('_blank');
    });

    it('shows desktop-only actions on desktop (default jsdom UA)', () => {
      const card: PortalCard = {
        ...applessCard,
        primaryAction: { type: 'external_scheme', label: 'Open in VS Code', href: 'vscode://x', desktop_only: true },
      };
      render(<PortalGrid cards={[card]} />);
      // jsdom's default UA is non-mobile → desktop-only action is visible.
      expect(screen.getByRole('link', { name: /open in vs code/i })).toBeDefined();
    });

    it('hides a desktop-only primary action on a phone UA', () => {
      const original = navigator.userAgent;
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
        configurable: true,
      });
      try {
        const card: PortalCard = {
          ...applessCard,
          primaryAction: { type: 'external_scheme', label: 'Open in VS Code', href: 'vscode://x', desktop_only: true },
        };
        render(<PortalGrid cards={[card]} />);
        expect(screen.queryByRole('link', { name: /open in vs code/i })).toBeNull();
        // A graceful "available on desktop" hint replaces it.
        expect(screen.getByText(/available on desktop/i)).toBeDefined();
      } finally {
        Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true });
      }
    });

    it('still shows the Open-URL button for ordinary URL-based cards', () => {
      render(<PortalGrid cards={[baseCard]} />);
      expect(screen.getByRole('link', { name: /^open$/i })).toBeDefined();
    });
  });

  describe('sizeTier → column span (#1700)', () => {
    /** Walk up from the card heading to the grid-cell wrapper (the div
     *  that carries the `col-span-*` class). Post design-system migration
     *  (#2107) the wrapper is the <Card> primitive — the heading's nearest
     *  ancestor div with `rounded-card` (the token card chrome). */
    const cardWrapper = (label: string): HTMLElement => {
      const heading = screen.getByRole('heading', { name: label });
      const wrapper = heading.closest('div.rounded-card');
      expect(wrapper).not.toBeNull();
      return wrapper as HTMLElement;
    };

    it('gives a compact card md:col-span-3', () => {
      render(<PortalGrid cards={[{ ...baseCard, sizeTier: 'compact' }]} />);
      const cls = cardWrapper('Photos').className;
      expect(cls).toContain('md:col-span-3');
      expect(cls).toContain('col-span-1'); // mobile stays 1 col
    });

    it('gives a regular card md:col-span-4', () => {
      render(<PortalGrid cards={[{ ...baseCard, sizeTier: 'regular' }]} />);
      expect(cardWrapper('Photos').className).toContain('md:col-span-4');
    });

    it('gives a feature card md:col-span-6 (action-rich → wider)', () => {
      render(<PortalGrid cards={[{ ...baseCard, sizeTier: 'feature' }]} />);
      expect(cardWrapper('Photos').className).toContain('md:col-span-6');
    });

    it('renders a feature (action-rich) card wider than a compact one', () => {
      const compact: PortalCard = { ...baseCard, id: 'a:x', label: 'Bare', sizeTier: 'compact' };
      const feature: PortalCard = { ...baseCard, id: 'b:y', label: 'Files', sizeTier: 'feature' };
      render(<PortalGrid cards={[compact, feature]} />);
      expect(cardWrapper('Bare').className).toContain('md:col-span-3');
      expect(cardWrapper('Files').className).toContain('md:col-span-6');
    });
  });

  describe('per-service status badge (#1654)', () => {
    it('renders no down/degraded badge text when status is ok', () => {
      render(<PortalGrid cards={[{ ...baseCard, status: 'ok' }]} />);
      // ok renders a subtle dot (aria-label Online), not a text label.
      expect(screen.getByLabelText('Online')).toBeDefined();
      expect(screen.queryByText('Down')).toBeNull();
      expect(screen.queryByText('Degraded')).toBeNull();
    });

    it('renders nothing for unknown status', () => {
      render(<PortalGrid cards={[{ ...baseCard, status: 'unknown' }]} />);
      expect(screen.queryByLabelText('Online')).toBeNull();
      expect(screen.queryByText('Down')).toBeNull();
      expect(screen.queryByText('Degraded')).toBeNull();
    });

    it('renders a red Down badge with the reason as its tooltip', () => {
      render(
        <PortalGrid
          cards={[{ ...baseCard, status: 'down', statusReason: 'Not reachable' }]}
        />,
      );
      const badge = screen.getByText('Down');
      expect(badge).toBeDefined();
      expect(badge.closest('span')?.getAttribute('title')).toBe('Not reachable');
    });

    it('renders an amber Degraded badge', () => {
      render(
        <PortalGrid
          cards={[{ ...baseCard, status: 'degraded', statusReason: 'Partially unhealthy' }]}
        />,
      );
      const badge = screen.getByText('Degraded');
      expect(badge).toBeDefined();
      expect(badge.closest('span')?.getAttribute('title')).toBe('Partially unhealthy');
    });
  });

  describe('design-system migration (#2107)', () => {
    /** Nearest <Card> ancestor of the card heading. */
    const wrapperOf = (label: string): HTMLElement => {
      const w = screen.getByRole('heading', { name: label }).closest('div.rounded-card');
      expect(w).not.toBeNull();
      return w as HTMLElement;
    };

    it('renders the card surface on semantic tokens, not raw gray/white literals', () => {
      render(<PortalGrid cards={[baseCard]} />);
      const cls = wrapperOf('Photos').className;
      expect(cls).toContain('bg-surface');
      expect(cls).toContain('border-border');
      // No bespoke raw-colour card chrome.
      expect(cls).not.toContain('bg-white');
      expect(cls).not.toContain('dark:bg-gray-800');
      expect(cls).not.toContain('rounded-2xl');
    });

    it('renders the Open CTA on the accent token (no raw blue-600)', () => {
      render(<PortalGrid cards={[baseCard]} />);
      const open = screen.getByRole('link', { name: /^open$/i });
      expect(open.className).toContain('bg-accent');
      expect(open.className).not.toContain('bg-blue-600');
    });

    it('renders the appless primary action on the accent token', () => {
      const applessCard: PortalCard = {
        ...baseCard,
        id: 'claude-dev:default',
        name: 'claude-dev',
        label: 'Claude Dev',
        url: '',
        primaryAction: {
          type: 'in_app',
          label: 'Open terminal',
          href: '/terminal?node=Local&container=claude-dev',
          desktop_only: false,
        },
      };
      render(<PortalGrid cards={[applessCard]} />);
      const cta = screen.getByRole('link', { name: /open terminal/i });
      expect(cta.className).toContain('bg-accent');
      expect(cta.className).not.toContain('bg-blue-600');
    });

    it('renders the card icon chip on the accent token', () => {
      render(<PortalGrid cards={[baseCard]} />);
      // The lucide icon chip wraps the svg in an accent-tinted div.
      const heading = screen.getByRole('heading', { name: 'Photos' });
      const header = heading.closest('div.rounded-card')!.querySelector('div.bg-accent\\/15');
      expect(header).not.toBeNull();
    });

    it('renders the recommended-app link on the accent token (function preserved)', () => {
      const card: PortalCard = {
        ...baseCard,
        recommendedApps: [{ name: 'Immich App', url: 'https://immich.app', platforms: ['ios'] }],
      };
      render(<PortalGrid cards={[card]} />);
      const app = screen.getByRole('link', { name: 'Immich App' });
      expect(app.getAttribute('href')).toBe('https://immich.app');
      expect(app.className).toContain('text-accent');
    });
  });

  describe('Syncthing pairing QR preserved through migration (#2107)', () => {
    const syncCard: PortalCard = {
      ...baseCard,
      id: 'file-share:SYNCTHING_SUBDOMAIN',
      name: 'file-share',
      label: 'File Share',
      setupAssets: [{ kind: 'syncthing_qr', description: 'Pair your phone.' }],
    };

    it('renders the pair button on tokens and keeps the fetch-on-click QR flow', () => {
      render(<PortalGrid cards={[syncCard]} />);
      const btn = screen.getByRole('button', { name: /pair/i });
      expect(btn.className).toContain('bg-accent');
      expect(btn.className).not.toContain('bg-emerald-600');
      // Modal heading appears only after click (QR fetched lazily).
      expect(screen.queryByRole('heading', { name: /pair this device/i })).toBeNull();
      fireEvent.click(btn);
      expect(screen.getByRole('heading', { name: /pair this device/i })).toBeDefined();
    });
  });
});
