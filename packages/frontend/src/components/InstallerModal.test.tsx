/**
 * InstallerModal — design-system migration coverage (lint-ratchet sweep).
 *
 * The modal's chrome moved off raw gray/blue/green/amber Tailwind ramps onto
 * the semantic @theme tokens (surface / border / accent / status-*). Nothing
 * rendered this component in the suite — RegistryBrowser is its only caller
 * and had no test — so every one of those lines was unmeasured.
 *
 * These tests drive the modal through each phase of the shared
 * `useStackInstall` controller and assert the *rendered* chrome: the token
 * classes on the surfaces/actions, and the behaviour attached to them
 * (select-step toggling, the upgrade-banner gate on Continue, the per-phase
 * footer actions, and the "done" DNS/SSL footer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Template } from '@servicebay/api-client';
import type { UseStackInstallReturn } from '@/hooks/useStackInstall';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/registry',
}));

const getNodes = vi.fn(() => Promise.resolve([{ Name: 'box-1' }]));
vi.mock('@/app/actions/system', () => ({ getNodes: () => getNodes() }));

// The upgrade banner owns its own network fetch; stub it to report ready so
// the Continue gate is exercised from both sides.
let bannerReports: boolean | undefined = true;
vi.mock('./TemplateUpgradeBanner', () => ({
  __esModule: true,
  default: ({
    templateName,
    onReadyToInstall,
  }: {
    templateName: string;
    onReadyToInstall: (ready: boolean | undefined) => void;
  }) => {
    onReadyToInstall(bannerReports);
    return <div data-testid={`upgrade-banner-${templateName}`} />;
  },
}));

// StackInstallFlow has its own suite; render just enough to prove the modal
// hands it the controller and the doneFooter it built.
vi.mock('./StackInstallFlow', () => ({
  __esModule: true,
  default: ({ doneFooter }: { doneFooter?: React.ReactNode }) => (
    <div data-testid="stack-install-flow">{doneFooter}</div>
  ),
}));

let controller: UseStackInstallReturn;
vi.mock('@/hooks/useStackInstall', () => ({
  useStackInstall: () => controller,
}));

import InstallerModal from './InstallerModal';

function makeController(over: Partial<UseStackInstallReturn> = {}): UseStackInstallReturn {
  const noop = () => {};
  return {
    phase: 'idle',
    items: [],
    variables: [],
    logs: [],
    installingNow: null,
    credentialsManifest: [],
    npmCredPrompt: false,
    npmCredFallback: { email: '', password: '' },
    npmCredError: null,
    error: null,
    setItemChecked: noop,
    setItems: noop,
    setVariableValue: noop,
    startConfigure: vi.fn(),
    runInstall: vi.fn(),
    retryNpmCredentials: vi.fn(),
    skipNpmCredentials: vi.fn(),
    appendLog: noop,
    reset: vi.fn(),
    ...over,
  } as UseStackInstallReturn;
}

const stack = { name: 'home', type: 'stack', source: 'builtin' } as Template;
const single = { name: 'jellyfin', type: 'template', source: 'builtin' } as Template;

const STACK_README = ['# home', '- [x] nginx', '- [ ] adguard'].join('\n');

function renderModal(
  template: Template = stack,
  readme = STACK_README,
  isOpen = true,
): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  render(
    <InstallerModal template={template} readme={readme} isOpen={isOpen} onClose={onClose} />,
  );
  return { onClose };
}

beforeEach(() => {
  controller = makeController();
  bannerReports = true;
  push.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InstallerModal — chrome', () => {
  it('renders nothing when closed', () => {
    renderModal(stack, STACK_README, false);
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
  });

  it('renders the stack header on surface/border/accent tokens', async () => {
    const { onClose } = renderModal();

    const heading = await screen.findByRole('heading', { level: 3 });
    expect(heading.textContent).toContain('Install Stack: home');
    expect(heading.className).toContain('text-foreground');
    // The dialog panel + header divider ride the semantic surface tokens, not
    // the old bg-white/dark:bg-gray-900 pair.
    const panel = heading.closest('div')?.parentElement as HTMLElement;
    expect(panel.className).toContain('bg-surface');
    expect(panel.className).toContain('border-border');

    const close = heading.parentElement!.querySelector('button')!;
    expect(close.className).toContain('text-muted');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('titles a single-template install "Install Template"', async () => {
    renderModal(single, '');
    const heading = await screen.findByRole('heading', { level: 3 });
    expect(heading.textContent).toContain('Install Template: jellyfin');
  });
});

describe('InstallerModal — select step', () => {
  it('parses the README checklist and toggles a service on click', async () => {
    renderModal();

    const nginx = await screen.findByText('nginx');
    expect(nginx.className).toContain('text-foreground');
    expect(screen.getByText('adguard')).toBeTruthy();

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    // The checkbox rides the accent token instead of text-blue-600.
    expect(boxes[0].className).toContain('text-accent');

    fireEvent.click(boxes[1]);
    await waitFor(() => expect((screen.getAllByRole('checkbox')[1] as HTMLInputElement).checked).toBe(true));
    // A newly-checked item gets its own upgrade banner.
    expect(screen.getByTestId('upgrade-banner-adguard')).toBeTruthy();
  });

  it('warns on the status-warn token when the README has no service list', async () => {
    renderModal(stack, '# home\n\nno checklist here');
    const warning = await screen.findByText(/No service definitions found/);
    expect(warning.className).toContain('text-status-warn');
    expect(warning.className).toContain('bg-surface-2');
  });

  it('enables Continue on the accent token once every banner reports ready', async () => {
    renderModal();
    const cont = await screen.findByRole('button', { name: 'Continue' });
    expect(cont.className).toContain('bg-accent');
    expect(cont.className).toContain('text-on-accent');
    await waitFor(() => expect((cont as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(cont);
    await waitFor(() => expect(controller.startConfigure).toHaveBeenCalledTimes(1));
    expect((controller.startConfigure as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
      { name: 'nginx', checked: true, alreadyInstalled: undefined },
    ]);
  });

  it('keeps Continue disabled while a breaking-change banner is unacknowledged', async () => {
    bannerReports = undefined;
    renderModal();
    const cont = await screen.findByRole('button', { name: 'Continue' });
    await waitFor(() => expect((cont as HTMLButtonElement).disabled).toBe(true));
    expect(cont.getAttribute('title')).toMatch(/Acknowledge the breaking-change banner/);
  });

  it('closes from the Cancel action on the idle footer', async () => {
    const { onClose } = renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('InstallerModal — phase footers', () => {
  it('configure: Back resets the stack controller and Install runs on the ok token', async () => {
    controller = makeController({ phase: 'configure' });
    renderModal();

    await screen.findByTestId('stack-install-flow');
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.className).toContain('text-foreground');
    fireEvent.click(back);
    expect(controller.reset).toHaveBeenCalled();

    const install = screen.getByRole('button', { name: 'Install' });
    expect(install.className).toContain('bg-status-ok');
    expect(install.className).toContain('text-on-accent');
    // getNodes resolved a single node, so it auto-selects and enables Install.
    await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(install);
    expect(controller.runInstall).toHaveBeenCalledWith({ node: 'box-1' });
  });

  it('configure: a single-template install cancels instead of going back', async () => {
    controller = makeController({ phase: 'configure' });
    const { onClose } = renderModal(single, '');
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    // The open-effect resets the controller once; the Cancel action on a
    // single-template install must close instead of resetting again.
    const resetsBefore = (controller.reset as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((controller.reset as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(resetsBefore);
  });

  it('installing: shows a disabled action on the neutral border token', async () => {
    controller = makeController({ phase: 'installing' });
    renderModal();
    const btn = await screen.findByRole('button', { name: 'Installing...' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.className).toContain('bg-border');
    expect(btn.className).toContain('text-muted');
  });

  it('done: routes to the dashboard from the accent action', async () => {
    controller = makeController({ phase: 'done' });
    const { onClose } = renderModal();
    const btn = await screen.findByRole('button', { name: 'Go to Dashboard' });
    expect(btn.className).toContain('bg-accent');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/');
  });

  it('error: shows a Close action on the neutral border token', async () => {
    controller = makeController({ phase: 'error', error: 'boom' });
    const { onClose } = renderModal();
    const btn = await screen.findByRole('button', { name: 'Close' });
    expect(btn.className).toContain('bg-border');
    expect(btn.className).toContain('text-foreground');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('InstallerModal — post-install DNS footer', () => {
  it('lists public subdomains on the info/warn tokens', async () => {
    controller = makeController({
      phase: 'done',
      variables: [
        { name: 'PUBLIC_DOMAIN', value: 'example.com' },
        { name: 'NGINX_SUB', value: 'npm', meta: { type: 'subdomain', exposure: 'public' } },
        { name: 'ZWAVE_SUB', value: 'zwave', meta: { type: 'subdomain', exposure: 'lan' } },
      ],
    } as Partial<UseStackInstallReturn>);
    renderModal();

    expect(await screen.findByText('1. Configure DNS')).toHaveProperty(
      'className',
      expect.stringContaining('text-status-info'),
    );
    expect(screen.getByText('2. SSL Certificates').className).toContain('text-status-warn');
    expect(screen.getByText('3. Access Restrictions (optional)').className).toContain(
      'text-foreground',
    );
    // Only the public-exposure subdomain is listed — a LAN-only one would
    // mislead the operator into creating an unwanted public A record.
    expect(screen.getByText('npm.example.com')).toBeTruthy();
    expect(screen.queryByText('zwave.example.com')).toBeNull();
  });

  it('omits the DNS footer when no public subdomain is configured', async () => {
    controller = makeController({
      phase: 'done',
      variables: [{ name: 'PUBLIC_DOMAIN', value: 'example.com' }],
    } as Partial<UseStackInstallReturn>);
    renderModal();
    await screen.findByTestId('stack-install-flow');
    expect(screen.queryByText('1. Configure DNS')).toBeNull();
  });
});
