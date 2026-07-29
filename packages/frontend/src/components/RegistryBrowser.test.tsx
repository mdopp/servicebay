/**
 * RegistryBrowser — design-system migration coverage (lint-ratchet sweep).
 *
 * The two-pane registry browser moved off raw gray/blue/purple Tailwind ramps
 * onto the semantic @theme tokens, and its list rows moved onto the shared
 * <Button> primitive from @/components/ui. The component had no test at all,
 * so none of that was measured.
 *
 * These tests render the browser with the heavy leaf panels stubbed and
 * assert the rendered output:
 *   - list rows are real, keyboard-reachable <button> primitives (the sweep
 *     must not degrade them to click-only <div>s),
 *   - selected vs unselected rows carry the accent/surface token classes,
 *   - the section headings, empty state, README pane, and the stack badge
 *     ride semantic tokens,
 *   - selection behaviour: default selection, ?selected= deep-links (special
 *     item and template), click-to-select pushing the URL, and opening the
 *     installer modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Template } from '@servicebay/api-client';

const push = vi.fn();
let searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/registry',
  useSearchParams: () => searchParams,
}));

const fetchReadme = vi.fn(() => Promise.resolve('# Readme body'));
vi.mock('@/app/actions', () => ({ fetchReadme: (...a: unknown[]) => fetchReadme(...(a as [])) }));

// react-markdown is ESM-heavy and irrelevant here — render the raw text.
vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: string }) => <div data-testid="readme">{children}</div>,
}));

// The four "Create New" leaf panels each own real forms/fetches; stub them.
vi.mock('./InstallerModal', () => ({
  __esModule: true,
  default: ({ isOpen, template }: { isOpen: boolean; template: Template }) =>
    isOpen ? <div data-testid="installer-modal">{template.name}</div> : null,
}));
vi.mock('./ExternalLinkConfig', () => ({
  __esModule: true,
  default: () => <div data-testid="panel-link" />,
}));
vi.mock('./ManualServiceForm', () => ({
  __esModule: true,
  default: () => <div data-testid="panel-manual" />,
}));
vi.mock('./ReverseProxyConfig', () => ({
  __esModule: true,
  default: () => <div data-testid="panel-proxy" />,
}));
vi.mock('./ServiceForm', () => ({
  __esModule: true,
  default: () => <div data-testid="panel-blank" />,
}));

import RegistryBrowser from './RegistryBrowser';

const jellyfin = { name: 'jellyfin', type: 'template', source: 'builtin' } as Template;
const paperless = { name: 'paperless', type: 'template', source: 'community' } as Template;
const homeStack = { name: 'home', type: 'stack', source: 'builtin' } as Template;

/** The sidebar pane — scopes row queries so a name that also appears in the
 *  detail header (the selected item) stays unambiguous. */
function sidebar(): HTMLElement {
  const el = document.querySelector('.w-80');
  if (!el) throw new Error('sidebar not rendered');
  return el as HTMLElement;
}

/** The detail pane (everything right of the sidebar). */
function detail(): HTMLElement {
  return sidebar().nextElementSibling as HTMLElement;
}

/** The list row (a <Button>) whose visible label is `name`. */
function row(name: string): HTMLElement {
  const el = within(sidebar()).getByText(name).closest('button');
  if (!el) throw new Error(`no list row button for "${name}"`);
  return el;
}

beforeEach(() => {
  push.mockClear();
  fetchReadme.mockClear();
  searchParams = new URLSearchParams();
});

describe('RegistryBrowser — sidebar list', () => {
  it('renders every row as a keyboard-reachable Button primitive', async () => {
    render(<RegistryBrowser templates={[homeStack, jellyfin]} />);

    // The four "Create New" specials plus one stack and one template row.
    for (const label of [
      'Reverse Proxy',
      'Manual Service',
      'Blank Quadlet',
      'External Link',
      'home',
      'jellyfin',
    ]) {
      const el = row(label);
      expect(el.tagName).toBe('BUTTON');
      expect(el.getAttribute('type')).toBe('button');
    }
    await waitFor(() => expect(fetchReadme).toHaveBeenCalled());
  });

  it('groups the list under token-styled Create New / Stacks / Templates headings', async () => {
    render(<RegistryBrowser templates={[homeStack, jellyfin]} />);
    for (const heading of ['Create New', 'Stacks', 'Templates']) {
      expect(screen.getByText(heading).className).toContain('text-muted');
    }
    // A stack row is badged, and the badge rides surface/accent tokens.
    const badge = within(sidebar()).getByText('Stack');
    expect(badge.className).toContain('bg-surface-2');
    expect(badge.className).toContain('text-accent');
    await waitFor(() => expect(fetchReadme).toHaveBeenCalled());
  });

  it('tints the selected row with accent/surface tokens and leaves the rest neutral', async () => {
    render(<RegistryBrowser templates={[jellyfin, paperless]} />);
    // First template is auto-selected when no ?selected= param is present.
    await waitFor(() => expect(row('jellyfin').className).toContain('text-accent'));
    expect(row('jellyfin').className).toContain('bg-surface');
    expect(row('jellyfin').className).toContain('ring-border');
    expect(row('paperless').className).toContain('text-foreground');
    expect(row('paperless').className).not.toContain('ring-border');
    // The row's source line rides the muted token.
    expect(within(row('paperless')).getByText('community').className).toContain('text-muted');
  });

  it('shows a token-styled empty state when the registry has nothing', () => {
    render(<RegistryBrowser templates={[]} />);
    const empty = screen.getByText('No templates or stacks found in registry.');
    expect(empty.className).toContain('text-muted');
    // Nothing selected → the placeholder pane on the subtle token.
    expect(screen.getByText('Select an item to view details').className).toContain('text-subtle');
  });
});

describe('RegistryBrowser — selection', () => {
  it('auto-selects the first template and renders its README pane', async () => {
    render(<RegistryBrowser templates={[jellyfin, paperless]} />);

    await waitFor(() => expect(screen.getByTestId('readme').textContent).toBe('# Readme body'));
    expect(fetchReadme).toHaveBeenCalledWith('jellyfin', 'template', 'builtin');

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toContain('jellyfin');
    expect(heading.className).toContain('text-foreground');
    expect(within(detail()).getByText('builtin').className).toContain('font-mono');
  });

  it('pushes the selection into the URL when a template row is clicked', async () => {
    render(<RegistryBrowser templates={[jellyfin, paperless]} />);
    await waitFor(() => expect(fetchReadme).toHaveBeenCalled());

    fireEvent.click(row('paperless'));
    expect(push).toHaveBeenCalledWith('/registry?selected=paperless');
    await waitFor(() =>
      expect(fetchReadme).toHaveBeenCalledWith('paperless', 'template', 'community'),
    );
  });

  it('opens the special-item panel and pushes its id when a Create New row is clicked', async () => {
    render(<RegistryBrowser templates={[jellyfin]} />);
    await waitFor(() => expect(fetchReadme).toHaveBeenCalled());

    fireEvent.click(row('Manual Service'));
    expect(push).toHaveBeenCalledWith('/registry?selected=manual');
    await waitFor(() => expect(screen.getByTestId('panel-manual')).toBeTruthy());
    // The template detail pane is replaced, not stacked.
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('honours a ?selected= deep link to a special item', async () => {
    searchParams = new URLSearchParams('selected=proxy');
    render(<RegistryBrowser templates={[jellyfin]} />);
    await waitFor(() => expect(screen.getByTestId('panel-proxy')).toBeTruthy());
    expect(row('Reverse Proxy').className).toContain('text-accent');
    // A special item never triggers a README fetch.
    expect(fetchReadme).not.toHaveBeenCalled();
  });

  it('honours a ?selected= deep link to a template', async () => {
    searchParams = new URLSearchParams('selected=paperless');
    render(<RegistryBrowser templates={[jellyfin, paperless]} />);
    await waitFor(() =>
      expect(fetchReadme).toHaveBeenCalledWith('paperless', 'template', 'community'),
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('paperless');
  });

  it('falls back to a placeholder README when the fetch returns nothing', async () => {
    fetchReadme.mockResolvedValueOnce('');
    render(<RegistryBrowser templates={[jellyfin]} />);
    await waitFor(() => expect(screen.getByTestId('readme').textContent).toBe('# No README found'));
  });
});

describe('RegistryBrowser — install action', () => {
  it('labels the install action per item type and opens the installer modal', async () => {
    searchParams = new URLSearchParams('selected=home');
    render(<RegistryBrowser templates={[homeStack]} />);

    const install = await screen.findByRole('button', { name: /Install Stack/ });
    // The primary action rides the accent pair, not bg-blue-600/text-white.
    expect(install.className).toContain('bg-accent');
    expect(install.className).toContain('text-on-accent');
    expect(screen.queryByTestId('installer-modal')).toBeNull();

    fireEvent.click(install);
    await waitFor(() => expect(screen.getByTestId('installer-modal').textContent).toBe('home'));
  });

  it('labels the action "Install Template" for a single-service template', async () => {
    render(<RegistryBrowser templates={[jellyfin]} />);
    expect(await screen.findByRole('button', { name: /Install Template/ })).toBeTruthy();
  });
});
