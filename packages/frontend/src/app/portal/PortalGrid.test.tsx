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

    it('renders the install button inline (full-row card, no expander), no modal yet', () => {
      render(<PortalGrid cards={[basicSyncCard]} />);
      // QR-bearing assets are inline columns in the full-row card (#2120).
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

  describe('bento footprint → grid span (#2120)', () => {
    /** Walk up from the card heading to the grid-cell wrapper (the <Card>
     *  primitive — the heading's nearest ancestor div with `rounded-card`,
     *  which carries the `col-span-*` footprint class). */
    const cardWrapper = (label: string): HTMLElement => {
      const heading = screen.getByRole('heading', { name: label });
      const wrapper = heading.closest('div.rounded-card');
      expect(wrapper).not.toBeNull();
      return wrapper as HTMLElement;
    };

    /** A file-share card carrying the heavy Syncthing pairing block →
     *  derives the `full-row` footprint. */
    const syncthingCard: PortalCard = {
      ...baseCard,
      id: 'file-share:SYNCTHING_SUBDOMAIN',
      name: 'file-share',
      label: 'Syncthing',
      setupAssets: [
        { kind: 'basicsync_install_qr', label: 'Install BasicSync on your phone' },
        { kind: 'syncthing_qr', label: 'Pair this device' },
      ],
    };

    it('renders an ordinary service card as a 1×1 tile (single column)', () => {
      render(<PortalGrid cards={[baseCard]} />);
      const cls = cardWrapper('Photos').className;
      expect(cls).toContain('col-span-1');
      expect(cls).not.toContain('md:col-span-full'); // not full-row
    });

    it('gives the Syncthing pairing card the full-row footprint (spans the grid width)', () => {
      render(<PortalGrid cards={[syncthingCard]} />);
      const cls = cardWrapper('Syncthing').className;
      expect(cls).toContain('md:col-span-full');
      expect(cls).toContain('col-span-1'); // narrow screens stay full-width single column
    });

    it('marks the full-row card with a data-footprint hook', () => {
      render(<PortalGrid cards={[syncthingCard]} />);
      const wrapper = cardWrapper('Syncthing');
      expect(wrapper.getAttribute('data-footprint')).toBe('full-row');
    });

    it('renders the bento grid as a fixed multi-column composition (3-col md, 1-col mobile)', () => {
      render(<PortalGrid cards={[baseCard]} />);
      const grid = screen.getByRole('heading', { name: 'Photos' }).closest('div.grid')!;
      expect(grid.className).toContain('grid-cols-1');
      expect(grid.className).toContain('md:grid-cols-3');
      // Intentional bento, not content-driven equal-height stretch.
      expect(grid.className).not.toContain('items-stretch');
      expect(grid.className).toContain('items-start');
    });

    it('keeps a 1×1 tile equal-height with its peers (h-full) for an even bento row', () => {
      render(<PortalGrid cards={[baseCard]} />);
      expect(cardWrapper('Photos').className).toContain('h-full');
    });
  });

  describe('full-row card horizontal layout (#2120)', () => {
    const syncthingCard: PortalCard = {
      ...baseCard,
      id: 'file-share:SYNCTHING_SUBDOMAIN',
      name: 'file-share',
      label: 'Syncthing',
      url: 'https://files.home.arpa',
      setupAssets: [
        { kind: 'basicsync_install_qr', label: 'Install BasicSync on your phone', description: 'Install the app first.' },
        { kind: 'syncthing_qr', label: 'Pair this device', description: 'Use /var/syncthing/Sync/<name> for the shared drive.' },
      ],
      recommendedApps: [{ name: 'Syncthing', url: 'https://syncthing.net', platforms: ['android'] }],
    };

    const cardWrapper = (label: string): HTMLElement =>
      screen.getByRole('heading', { name: label }).closest('div.rounded-card') as HTMLElement;

    it('lays the full-row card sections out horizontally side-by-side (md:flex-row + section column grid)', () => {
      render(<PortalGrid cards={[syncthingCard]} />);
      const wrapper = cardWrapper('Syncthing');
      // Top-level row container goes horizontal on md+.
      const row = wrapper.querySelector('div.md\\:flex-row');
      expect(row).not.toBeNull();
      // The section block is a horizontal column grid (not a tall stack).
      const sectionGrid = wrapper.querySelector('div.md\\:grid-cols-2');
      expect(sectionGrid).not.toBeNull();
    });

    it('shows the BasicSync install + Pair QRs inline (NOT collapsed behind an expander)', () => {
      render(<PortalGrid cards={[syncthingCard]} />);
      // No "How to pair" expander in the full-row layout — buttons are
      // directly reachable as side-by-side columns.
      expect(screen.queryByText(/so koppelst du/i)).toBeNull();
      expect(screen.getByRole('button', { name: /install basicsync on your phone/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /pair this device/i })).toBeDefined();
    });

    it('keeps the Open CTA + storage-path note + recommended apps in the full-row card', () => {
      render(<PortalGrid cards={[syncthingCard]} />);
      const open = screen.getByRole('link', { name: /^open$/i });
      expect(open.getAttribute('href')).toBe('https://files.home.arpa');
      expect(screen.getByText(/\/var\/syncthing\/sync/i)).toBeDefined();
      expect(screen.getByRole('link', { name: 'Syncthing' }).getAttribute('href')).toBe('https://syncthing.net');
    });

    it('still opens the pairing QR modal from the inline button (function preserved)', () => {
      render(<PortalGrid cards={[syncthingCard]} />);
      expect(screen.queryByRole('heading', { name: /pair this device/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /pair this device/i }));
      expect(screen.getByRole('heading', { name: /pair this device/i })).toBeDefined();
    });

    it('stacks the full-row card columns on narrow screens (flex-col base, md:flex-row)', () => {
      render(<PortalGrid cards={[syncthingCard]} />);
      const row = cardWrapper('Syncthing').querySelector('div.flex-col.md\\:flex-row');
      expect(row).not.toBeNull();
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
      // The pairing block is an inline column in the full-row card (#2120) —
      // the pair button is directly reachable, no expander.
      const btn = screen.getByRole('button', { name: /pair/i });
      expect(btn.className).toContain('bg-accent');
      expect(btn.className).not.toContain('bg-emerald-600');
      // Modal heading appears only after click (QR fetched lazily).
      expect(screen.queryByRole('heading', { name: /pair this device/i })).toBeNull();
      fireEvent.click(btn);
      expect(screen.getByRole('heading', { name: /pair this device/i })).toBeDefined();
    });
  });

  describe('even bento tile composition (#2120)', () => {
    /** The grid container is the heading's nearest ancestor div carrying
     *  the `grid` class. */
    const gridOf = (label: string): HTMLElement => {
      const grid = screen.getByRole('heading', { name: label }).closest('div.grid');
      expect(grid).not.toBeNull();
      return grid as HTMLElement;
    };
    const cardOf = (label: string): HTMLElement =>
      screen.getByRole('heading', { name: label }).closest('div.rounded-card') as HTMLElement;

    it('renders a fixed bento composition (md:grid-cols-3, items-start, not stretch)', () => {
      render(<PortalGrid cards={[baseCard]} />);
      const grid = gridOf('Photos');
      expect(grid.className).toContain('md:grid-cols-3');
      expect(grid.className).toContain('items-start');
      expect(grid.className).not.toContain('items-stretch');
    });

    it('keeps a responsive 1 / multi-col layout (1 col mobile, 3-col md track)', () => {
      render(<PortalGrid cards={[baseCard]} />);
      const grid = gridOf('Photos');
      expect(grid.className).toContain('grid-cols-1');
      expect(grid.className).toContain('md:grid-cols-3');
      expect(grid.className).toContain('gap-6');
    });

    it('renders an even row of three 1×1 tiles that each fill the row height', () => {
      const a: PortalCard = { ...baseCard, id: 'a:x', label: 'Alpha' };
      const b: PortalCard = { ...baseCard, id: 'b:y', label: 'Beta' };
      const c: PortalCard = { ...baseCard, id: 'c:z', label: 'Gamma' };
      render(<PortalGrid cards={[a, b, c]} />);
      for (const label of ['Alpha', 'Beta', 'Gamma']) {
        expect(cardOf(label).className).toContain('h-full');
        expect(cardOf(label).className).toContain('col-span-1');
      }
    });
  });

  describe('1×1 tile keeps light setup assets inline (#2120)', () => {
    it('renders a single light asset inline (no expander) — 1×1 tiles never grow a heavy block', () => {
      const absCard: PortalCard = {
        ...baseCard,
        id: 'abs:ABS_SUBDOMAIN',
        name: 'audiobookshelf',
        label: 'Audiobooks',
        setupAssets: [{ kind: 'audiobookshelf_deeplink', label: 'Open in Audiobookshelf app' }],
      };
      render(<PortalGrid cards={[absCard]} />);
      // No expander; the deep-link button is directly reachable.
      expect(screen.queryByText(/so koppelst du/i)).toBeNull();
      expect(screen.getByRole('button', { name: /open in audiobookshelf app/i })).toBeDefined();
    });
  });
});
