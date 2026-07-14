/**
 * PortalGrid component tests (#2126 redesign).
 *
 * The portal is now a uniform launcher grid: every card is the same size,
 * grouped into small labelled sections. Each card's FRONT is calm (accent
 * icon-chip + name + status dot + one-line description + a single Open
 * CTA) and EVERYTHING secondary — recommended apps, manual-pairing steps,
 * setup assets (Syncthing install + pairing QRs, calendar one-tap
 * profile, audiobook deep-link), the how-to body — collapses behind a
 * per-card "Apps & setup" disclosure, closed by default. These tests pin
 * the disclosure behaviour, the uniform grid (no bento/full-row), the
 * per-service accent, the grouping sections, and that all prior function
 * is preserved.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

/** A file-share/Syncthing card carrying the heavy QR pairing block. */
const syncthingCard: PortalCard = {
  ...baseCard,
  id: 'file-share:SYNCTHING_SUBDOMAIN',
  name: 'file-share',
  label: 'Syncthing',
  lucideIcon: 'refresh-cw',
  url: 'https://files.home.arpa',
  setupAssets: [
    { kind: 'basicsync_install_qr', label: 'Install BasicSync on your phone', description: 'Install the app first.' },
    { kind: 'syncthing_qr', label: 'Pair this device', description: 'Use /var/syncthing/Sync/<name> for the shared drive.' },
  ],
  recommendedApps: [{ name: 'Syncthing', url: 'https://syncthing.net', platforms: ['android'] }],
};

/** Open the "Apps & setup" disclosure on the card whose heading matches. */
const openDisclosure = (label: string): void => {
  const summary = screen.getByRole('heading', { name: label })
    .closest('[data-testid="service-card"]')!
    .querySelector('summary')!;
  fireEvent.click(summary);
};

describe('PortalGrid', () => {
  it('renders a card with its label and open button', () => {
    render(<PortalGrid cards={[baseCard]} />);
    expect(screen.getByRole('heading', { name: 'Photos' })).toBeDefined();
    expect(screen.getByRole('link', { name: /open/i })).toBeDefined();
  });

  it('still shows the Open-URL button for ordinary URL-based cards', () => {
    render(<PortalGrid cards={[baseCard]} />);
    const open = screen.getByRole('link', { name: /^open$/i });
    expect(open.getAttribute('href')).toBe('https://photos.home.arpa');
    expect(open.getAttribute('target')).toBe('_blank');
  });
});

describe('uniform launcher grid (#2126)', () => {
  const gridOf = (label: string): HTMLElement =>
    screen.getByRole('heading', { name: label }).closest('div.grid') as HTMLElement;
  const cardOf = (label: string): HTMLElement =>
    screen.getByRole('heading', { name: label }).closest('[data-testid="service-card"]') as HTMLElement;

  it('lays out a responsive 1 / 2 / 3-column grid with even gaps', () => {
    render(<PortalGrid cards={[baseCard]} />);
    const grid = gridOf('Photos');
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('sm:grid-cols-2');
    expect(grid.className).toContain('lg:grid-cols-3');
    expect(grid.className).toContain('gap-space-5');
  });

  it('makes every card equal-sized — no full-row / bento col-span special-casing', () => {
    render(<PortalGrid cards={[baseCard, syncthingCard]} />);
    for (const label of ['Photos', 'Syncthing']) {
      const card = cardOf(label);
      expect(card.className).toContain('h-full');
      // No bento footprint hooks survive the redesign.
      expect(card.className).not.toContain('md:col-span-full');
      expect(card.className).not.toContain('col-span');
      expect(card.getAttribute('data-footprint')).toBeNull();
    }
  });

  it('stretches cards to a shared height (items-stretch, not bento items-start)', () => {
    render(<PortalGrid cards={[baseCard]} />);
    const grid = gridOf('Photos');
    expect(grid.className).toContain('items-stretch');
    expect(grid.className).not.toContain('items-start');
  });

  it('renders the Syncthing card as an ordinary equal-sized tile (no wide slot)', () => {
    render(<PortalGrid cards={[syncthingCard]} />);
    const card = cardOf('Syncthing');
    expect(card.className).not.toContain('md:col-span-full');
    // Its heavy pairing block is collapsed behind the disclosure, not inline.
    expect(card.querySelector('[data-testid="card-disclosure"]')).not.toBeNull();
  });
});

describe('per-card "Apps & setup" disclosure (#2126)', () => {
  it('hides the recommended apps + how-to body behind a closed disclosure', () => {
    const card: PortalCard = {
      ...baseCard,
      body: 'How to use Photos.',
      recommendedApps: [{ name: 'Immich App', url: 'https://immich.app', platforms: ['ios'] }],
    };
    render(<PortalGrid cards={[card]} />);
    const details = screen.getByTestId('card-disclosure');
    // Closed by default.
    expect((details as HTMLDetailsElement).open).toBe(false);
    // The disclosure trigger is present...
    expect(screen.getByText(/apps & setup/i)).toBeDefined();
    // ...and the secondary affordances live inside it (not on the front).
    expect(within(details as HTMLElement).getByRole('link', { name: 'Immich App' })).toBeDefined();
    expect(within(details as HTMLElement).getByRole('button', { name: /how do i use this/i })).toBeDefined();
  });

  it('renders NO disclosure for a bare Open-only card (calm front)', () => {
    render(<PortalGrid cards={[baseCard]} />);
    expect(screen.queryByTestId('card-disclosure')).toBeNull();
    expect(screen.queryByText(/apps & setup/i)).toBeNull();
  });

  it('keeps the Open CTA on the FRONT, outside the disclosure', () => {
    render(<PortalGrid cards={[syncthingCard]} />);
    const cta = screen.getByTestId('card-cta');
    expect(cta.querySelector('a')?.getAttribute('href')).toBe('https://files.home.arpa');
    // The CTA is not nested inside the <details> disclosure.
    expect(cta.closest('details')).toBeNull();
  });

  it('reveals the Syncthing install + pairing QR buttons when the disclosure opens', () => {
    render(<PortalGrid cards={[syncthingCard]} />);
    // The QR buttons exist in the DOM (collapsed), but the disclosure is closed.
    const details = screen.getByTestId('card-disclosure') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    openDisclosure('Syncthing');
    expect(details.open).toBe(true);
    expect(screen.getByRole('button', { name: /install basicsync on your phone/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /pair this device/i })).toBeDefined();
  });

  it('opens the pairing-QR modal from the disclosed button (function preserved)', () => {
    render(<PortalGrid cards={[syncthingCard]} />);
    openDisclosure('Syncthing');
    // Modal heading only appears after clicking the pair button (lazy QR fetch).
    expect(screen.queryByRole('heading', { name: /pair this device/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /pair this device/i }));
    expect(screen.getByRole('heading', { name: /pair this device/i })).toBeDefined();
  });

  it('opens the BasicSync install QR modal from the disclosed button', () => {
    render(<PortalGrid cards={[syncthingCard]} />);
    openDisclosure('Syncthing');
    expect(screen.queryByRole('heading', { name: /install basicsync/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /install basicsync on your phone/i }));
    expect(screen.getByRole('heading', { name: /install basicsync/i })).toBeDefined();
    const link = screen.getByRole('link', { name: /open the download link directly/i });
    expect(link.getAttribute('href')).toContain('/api/system/downloads/basicsync');
  });

  it('keeps the storage-path note + recommended apps inside the disclosure', () => {
    render(<PortalGrid cards={[syncthingCard]} />);
    openDisclosure('Syncthing');
    expect(screen.getByText(/\/var\/syncthing\/sync/i)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Syncthing' }).getAttribute('href')).toBe('https://syncthing.net');
  });
});

describe('Calendar one-tap iOS setup preserved behind disclosure (#2126)', () => {
  const calendarCard: PortalCard = {
    ...baseCard,
    id: 'radicale:CALDAV_SUBDOMAIN',
    name: 'radicale',
    subdomainVar: 'CALDAV_SUBDOMAIN',
    label: 'Calendar & Contacts',
    lucideIcon: 'calendar-days',
    setupAssets: [
      { kind: 'ios_calendar_profile', label: 'Add to iPhone (Calendar + Contacts)', description: 'One-tap setup.' },
    ],
  };

  it('hides the iOS profile download by default and reveals it on open', () => {
    render(<PortalGrid cards={[calendarCard]} />);
    // The download link is inside the collapsed disclosure.
    const details = screen.getByTestId('card-disclosure') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    openDisclosure('Calendar & Contacts');
    const link = screen.getByRole('link', { name: /add to iphone/i });
    expect(link.getAttribute('href')).toContain('/api/portal/asset/radicale/ios_calendar_profile');
    expect(link.getAttribute('href')).toContain('subdomain_var=CALDAV_SUBDOMAIN');
  });
});

describe('generic URL-driven asset kinds — PWA install + APK download (#2295)', () => {
  const pwaCard: PortalCard = {
    ...baseCard,
    id: 'some-app:APP_SUBDOMAIN',
    name: 'some-app',
    subdomainVar: 'APP_SUBDOMAIN',
    label: 'Some App',
    setupAssets: [
      { kind: 'pwa_install', url: 'https://app.home.arpa', label: 'Install to Home Screen', description: 'Add it to your phone.' },
    ],
  };

  const apkCard: PortalCard = {
    ...baseCard,
    id: 'some-app:APK_SUBDOMAIN',
    name: 'some-app',
    subdomainVar: 'APK_SUBDOMAIN',
    label: 'Some APK App',
    setupAssets: [
      { kind: 'apk_download', url: 'https://github.com/owner/repo/releases/latest/download/app.apk', label: 'Download the app (Android)' },
    ],
  };

  it('renders an "Install to Home Screen" card that opens a QR modal to the service url', () => {
    render(<PortalGrid cards={[pwaCard]} />);
    openDisclosure('Some App');
    const btn = screen.getByRole('button', { name: /install to home screen/i });
    expect(btn).toBeDefined();
    // Modal QR + CTA to the service url appear only after clicking.
    expect(screen.queryByRole('heading', { name: /add to home screen/i })).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByRole('heading', { name: /add to home screen/i })).toBeDefined();
    const cta = screen.getByRole('link', { name: /open to install/i });
    expect(cta.getAttribute('href')).toBe('https://app.home.arpa');
  });

  it('renders an APK download card with a direct download link + a QR modal to the release url', () => {
    render(<PortalGrid cards={[apkCard]} />);
    openDisclosure('Some APK App');
    const download = screen.getByRole('link', { name: /download the app \(android\)/i });
    expect(download.getAttribute('href')).toBe('https://github.com/owner/repo/releases/latest/download/app.apk');
    // The QR modal opens from the "Scan QR to phone" button.
    fireEvent.click(screen.getByRole('button', { name: /scan qr to phone/i }));
    expect(screen.getByRole('heading', { name: /download the app/i })).toBeDefined();
    const link = screen.getByRole('link', { name: /open the download link directly/i });
    expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/releases/latest/download/app.apk');
  });

  it('is service-agnostic — neither card hard-codes Solaris', () => {
    render(<PortalGrid cards={[pwaCard, apkCard]} />);
    expect(screen.queryByText(/solaris/i)).toBeNull();
  });
});

describe('per-service accent identity (#2126)', () => {
  const chipOf = (label: string): HTMLElement => {
    const chip = screen.getByRole('heading', { name: label })
      .closest('[data-testid="service-card"]')!
      .querySelector('[data-accent]');
    expect(chip).not.toBeNull();
    return chip as HTMLElement;
  };

  const cases: [PortalCard, string, string][] = [
    [{ ...baseCard, label: 'Photos', lucideIcon: 'camera' }, 'teal', 'svc-chip-teal'],
    [{ ...baseCard, id: 'v:1', label: 'Passwords', lucideIcon: 'shield' }, 'blue', 'svc-chip-blue'],
    [{ ...baseCard, id: 'f:1', label: 'Files', lucideIcon: 'folder-open' }, 'orange', 'svc-chip-orange'],
    [{ ...baseCard, id: 'a:1', label: 'Audiobooks', lucideIcon: 'book-open' }, 'violet', 'svc-chip-violet'],
    [{ ...baseCard, id: 'm:1', label: 'Music', lucideIcon: 'music' }, 'rose', 'svc-chip-rose'],
    [{ ...baseCard, id: 'c:1', label: 'Calendar & Contacts', lucideIcon: 'calendar-days' }, 'red', 'svc-chip-red'],
    [{ ...baseCard, id: 'h:1', label: 'Smart Home', lucideIcon: 'lightbulb' }, 'amber', 'svc-chip-amber'],
    [{ ...baseCard, id: 'd:1', label: 'Claude Dev', lucideIcon: 'bot' }, 'indigo', 'svc-chip-indigo'],
    [{ ...baseCard, id: 's:1', label: 'Syncthing', lucideIcon: 'refresh-cw' }, 'green', 'svc-chip-green'],
  ];

  for (const [card, accent, cls] of cases) {
    it(`tints the ${card.label} chip ${accent}`, () => {
      render(<PortalGrid cards={[card]} />);
      const chip = chipOf(card.label);
      expect(chip.getAttribute('data-accent')).toBe(accent);
      expect(chip.className).toContain(cls);
    });
  }

  it('does not paint the whole card — only the icon chip carries the accent', () => {
    render(<PortalGrid cards={[{ ...baseCard, label: 'Music', lucideIcon: 'music' }]} />);
    const wrapper = screen.getByRole('heading', { name: 'Music' }).closest('[data-testid="service-card"]')!;
    // The card surface stays on the neutral semantic token, no garish fill.
    expect(wrapper.className).toContain('bg-surface');
    expect(wrapper.className).not.toContain('svc-chip-rose');
  });
});

describe('light section grouping (#2126)', () => {
  const sectionHeading = (name: string) =>
    screen.getByRole('heading', { name, level: 2 });

  it('groups cards under Media / Productivity / Files & Sync / Smart Home & Dev headers', () => {
    const cards: PortalCard[] = [
      { ...baseCard, id: 'photos:1', label: 'Photos', lucideIcon: 'camera' },
      { ...baseCard, id: 'music:1', label: 'Music', lucideIcon: 'music' },
      { ...baseCard, id: 'pw:1', label: 'Passwords', lucideIcon: 'shield' },
      { ...baseCard, id: 'cal:1', label: 'Calendar', lucideIcon: 'calendar-days' },
      { ...baseCard, id: 'files:1', label: 'Files', lucideIcon: 'folder-open' },
      { ...baseCard, id: 'sync:1', label: 'Syncthing', lucideIcon: 'refresh-cw' },
      { ...baseCard, id: 'ha:1', label: 'Smart Home', lucideIcon: 'lightbulb' },
      { ...baseCard, id: 'dev:1', label: 'Claude Dev', lucideIcon: 'bot' },
    ];
    render(<PortalGrid cards={cards} />);
    for (const name of ['Media', 'Productivity', 'Files & Sync', 'Smart Home & Dev']) {
      expect(sectionHeading(name)).toBeDefined();
    }
  });

  it('files each card under the right section', () => {
    const cards: PortalCard[] = [
      { ...baseCard, id: 'music:1', label: 'Music', lucideIcon: 'music' },
      { ...baseCard, id: 'pw:1', label: 'Passwords', lucideIcon: 'shield' },
    ];
    render(<PortalGrid cards={cards} />);
    const media = sectionHeading('Media').closest('section')!;
    const productivity = sectionHeading('Productivity').closest('section')!;
    expect(within(media).getByRole('heading', { name: 'Music' })).toBeDefined();
    expect(within(productivity).getByRole('heading', { name: 'Passwords' })).toBeDefined();
  });

  it('drops empty sections (only renders sections that have cards)', () => {
    render(<PortalGrid cards={[{ ...baseCard, label: 'Photos', lucideIcon: 'camera' }]} />);
    expect(sectionHeading('Media')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Productivity', level: 2 })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Files & Sync', level: 2 })).toBeNull();
  });

  it('renders Media before Productivity before Files & Sync before Smart Home & Dev', () => {
    const cards: PortalCard[] = [
      { ...baseCard, id: 'dev:1', label: 'Claude Dev', lucideIcon: 'bot' },
      { ...baseCard, id: 'files:1', label: 'Files', lucideIcon: 'folder-open' },
      { ...baseCard, id: 'pw:1', label: 'Passwords', lucideIcon: 'shield' },
      { ...baseCard, id: 'photos:1', label: 'Photos', lucideIcon: 'camera' },
    ];
    render(<PortalGrid cards={cards} />);
    const order = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
    expect(order).toEqual(['Media', 'Productivity', 'Files & Sync', 'Smart Home & Dev']);
  });
});

describe('manual-pairing panel preserved behind disclosure (#1253/#2126)', () => {
  const hermesCard: PortalCard = {
    ...baseCard,
    id: 'hermes:HERMES_SUBDOMAIN',
    name: 'hermes',
    label: 'Hermes',
    manualPairing: [
      {
        title: 'Pair the Signal account',
        command: 'podman exec -it hermes signal-cli link -n HermesAgent',
        why: 'Scan the QR shown in the terminal with Signal → Linked devices.',
      },
    ],
  };

  it('does not render the manual-setup panel when manualPairing is empty', () => {
    render(<PortalGrid cards={[baseCard]} />);
    expect(screen.queryByText(/manual setup needed/i)).toBeNull();
  });

  it('renders the panel + step title + command + why + copy button on open', () => {
    render(<PortalGrid cards={[hermesCard]} />);
    openDisclosure('Hermes');
    expect(screen.getByText(/manual setup needed/i)).toBeDefined();
    expect(screen.getByText('Pair the Signal account')).toBeDefined();
    expect(screen.getByText('podman exec -it hermes signal-cli link -n HermesAgent')).toBeDefined();
    expect(screen.getByText(/scan the qr shown in the terminal/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /copy command/i })).toBeDefined();
  });

  it('renders multiple manual_pairing steps with a copy button each', () => {
    const card: PortalCard = {
      ...hermesCard,
      manualPairing: [
        { title: 'Step one', command: 'cmd-one' },
        { title: 'Step two', command: 'cmd-two' },
      ],
    };
    render(<PortalGrid cards={[card]} />);
    openDisclosure('Hermes');
    expect(screen.getByText('Step one')).toBeDefined();
    expect(screen.getByText('Step two')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /copy command/i })).toHaveLength(2);
  });
});

describe('appless cards + action links (#1618)', () => {
  const applessCard: PortalCard = {
    ...baseCard,
    id: 'claude-dev:default',
    name: 'claude-dev',
    label: 'Claude Dev',
    lucideIcon: 'bot',
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
    expect(vscode.getAttribute('target')).toBe('_blank');
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
      expect(screen.getByText(/available on desktop/i)).toBeDefined();
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true });
    }
  });
});

describe('per-service status badge (#1654)', () => {
  it('renders a subtle online dot for ok status (no text label)', () => {
    render(<PortalGrid cards={[{ ...baseCard, status: 'ok' }]} />);
    expect(screen.getByLabelText('Online')).toBeDefined();
    expect(screen.queryByText('Down')).toBeNull();
    expect(screen.queryByText('Degraded')).toBeNull();
  });

  it('renders nothing for unknown status', () => {
    render(<PortalGrid cards={[{ ...baseCard, status: 'unknown' }]} />);
    expect(screen.queryByLabelText('Online')).toBeNull();
  });

  it('renders a red Down badge with the reason as its tooltip', () => {
    render(<PortalGrid cards={[{ ...baseCard, status: 'down', statusReason: 'Not reachable' }]} />);
    const badge = screen.getByText('Down');
    expect(badge.closest('span')?.getAttribute('title')).toBe('Not reachable');
  });

  it('renders an amber Degraded badge', () => {
    render(<PortalGrid cards={[{ ...baseCard, status: 'degraded', statusReason: 'Partially unhealthy' }]} />);
    const badge = screen.getByText('Degraded');
    expect(badge.closest('span')?.getAttribute('title')).toBe('Partially unhealthy');
  });
});

describe('design-system tokens preserved (#2107/#2126)', () => {
  const wrapperOf = (label: string): HTMLElement =>
    screen.getByRole('heading', { name: label }).closest('[data-testid="service-card"]') as HTMLElement;

  it('renders the card surface on semantic tokens, not raw gray/white literals', () => {
    render(<PortalGrid cards={[baseCard]} />);
    const cls = wrapperOf('Photos').className;
    expect(cls).toContain('bg-surface');
    expect(cls).toContain('border-border');
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
      lucideIcon: 'bot',
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

  it('renders the recommended-app link on the accent token (function preserved)', () => {
    const card: PortalCard = {
      ...baseCard,
      recommendedApps: [{ name: 'Immich App', url: 'https://immich.app', platforms: ['ios'] }],
    };
    render(<PortalGrid cards={[card]} />);
    openDisclosure('Photos');
    const app = screen.getByRole('link', { name: 'Immich App' });
    expect(app.getAttribute('href')).toBe('https://immich.app');
    expect(app.className).toContain('text-accent');
  });
});
