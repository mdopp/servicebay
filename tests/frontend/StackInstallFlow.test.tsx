import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import StackInstallFlow, {
  StackInstallConfigureForm,
  StackInstallProgress,
  StackInstallSummary,
} from '@/components/StackInstallFlow';
import type { UseStackInstallReturn } from '@/hooks/useStackInstall';

/** Build a minimal controller stub the components can render against. */
function makeController(overrides: Partial<UseStackInstallReturn> = {}): UseStackInstallReturn {
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
    reset: noop,
    ...overrides,
  } as UseStackInstallReturn;
}

describe('StackInstallFlow phase dispatch', () => {
  it('renders configure form when phase is configure', () => {
    const controller = makeController({
      phase: 'configure',
      variables: [
        { name: 'PUBLIC_DOMAIN', value: 'example.com', global: true },
        { name: 'API_KEY', value: 'k1', meta: { type: 'text', templateName: 'web' } },
      ],
    });
    render(<StackInstallFlow controller={controller} />);
    expect(screen.getByText('PUBLIC_DOMAIN')).toBeDefined();
    expect(screen.getByText('API_KEY')).toBeDefined();
  });

  it('renders progress component when phase is installing', () => {
    const controller = makeController({
      phase: 'installing',
      logs: ['Installing nginx...', 'Pulling image…'],
    });
    render(<StackInstallFlow controller={controller} />);
    expect(screen.getByText('Installing nginx...')).toBeDefined();
    expect(screen.getByText('Pulling image…')).toBeDefined();
  });

  it('renders progress + summary when phase is done', () => {
    const controller = makeController({
      phase: 'done',
      logs: ['Stack installation complete.'],
      credentialsManifest: [
        {
          service: 'Nginx Admin',
          url: 'https://admin.example.com',
          username: 'admin@example.com',
          password: 'p4ssw0rd',
          importance: 'critical',
        },
      ],
    });
    render(<StackInstallFlow controller={controller} />);
    expect(screen.getByText('Stack installation complete.')).toBeDefined();
    expect(screen.getByText('Nginx Admin')).toBeDefined();
    expect(screen.getByText(/admin@example\.com \/ p4ssw0rd/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Download CSV/i })).toBeDefined();
  });

  it('renders null for idle / error phases', () => {
    const controller = makeController({ phase: 'idle' });
    const { container } = render(<StackInstallFlow controller={controller} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('StackInstallConfigureForm', () => {
  it('hides the node selector for single-node clusters', () => {
    const controller = makeController({ phase: 'configure' });
    render(
      <StackInstallConfigureForm
        controller={controller}
        nodes={[{ Name: 'Local', URI: 'unix:///run/podman/podman.sock' }]}
        selectedNode="Local"
      />,
    );
    // Single-node clusters skip the picker entirely.
    expect(screen.queryByLabelText(/Target Node/i)).toBeNull();
  });

  it('shows the node selector for multi-node clusters', () => {
    const controller = makeController({ phase: 'configure' });
    render(
      <StackInstallConfigureForm
        controller={controller}
        nodes={[
          { Name: 'Local', URI: 'unix:///run/podman/podman.sock' },
          { Name: 'Edge', URI: 'ssh://edge.example' },
        ]}
        selectedNode=""
      />,
    );
    expect(screen.getByText(/Target Node/i)).toBeDefined();
  });
});

describe('StackInstallProgress — NPM credentials prompt', () => {
  it('shows the prompt with the fallback email pre-filled', () => {
    const controller = makeController({
      phase: 'installing',
      logs: [],
      npmCredPrompt: true,
      npmCredFallback: { email: 'admin@example.com', password: 'pw' },
    });
    render(<StackInstallProgress controller={controller} />);
    expect(screen.getByText(/NPM admin login required/)).toBeDefined();
    expect((screen.getByPlaceholderText('NPM admin email') as HTMLInputElement).value).toBe('admin@example.com');
  });

  it('calls retryNpmCredentials with whatever is in the inputs', () => {
    const retry = vi.fn();
    const controller = makeController({
      phase: 'installing',
      logs: [],
      npmCredPrompt: true,
      npmCredFallback: { email: 'a@b.com', password: 'init' },
      retryNpmCredentials: retry,
    });
    render(<StackInstallProgress controller={controller} />);
    const passwordInput = screen.getByPlaceholderText('NPM admin password') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 'override' } });
    fireEvent.click(screen.getByRole('button', { name: /Authenticate.*Retry/ }));
    expect(retry).toHaveBeenCalledWith('a@b.com', 'override');
  });

  // #2442 — the fallback is never present at mount. `StackInstallProgress`
  // mounts the moment the phase becomes `installing`; the fallback only
  // arrives later on the status poll that reports `needs_credentials`.
  // These cases drive that ordering, which the stub-at-mount cases above
  // cannot reproduce.
  it('pre-fills the inputs when the fallback arrives after mount (#2442)', () => {
    const { rerender } = render(<StackInstallProgress controller={makeController({ phase: 'installing', logs: [] })} />);
    expect(screen.queryByPlaceholderText('NPM admin email')).toBeNull();

    // The poll reports needs_credentials with the stored fallback.
    rerender(<StackInstallProgress controller={makeController({
      phase: 'installing',
      logs: [],
      npmCredPrompt: true,
      npmCredFallback: { email: 'stored@example.com', password: 'stored-pw' },
    })} />);

    expect((screen.getByPlaceholderText('NPM admin email') as HTMLInputElement).value).toBe('stored@example.com');
    expect((screen.getByPlaceholderText('NPM admin password') as HTMLInputElement).value).toBe('stored-pw');
  });

  it('keeps operator edits when the same fallback is re-reported by the poll (#2442)', () => {
    const paused = () => makeController({
      phase: 'installing',
      logs: [],
      npmCredPrompt: true,
      // A fresh object every poll, same values — re-seeding on identity
      // rather than on value would wipe a half-typed retry.
      npmCredFallback: { email: 'stored@example.com', password: 'stored-pw' },
    });
    const { rerender } = render(<StackInstallProgress controller={paused()} />);

    fireEvent.change(screen.getByPlaceholderText('NPM admin password'), { target: { value: 'operator-typed' } });
    rerender(<StackInstallProgress controller={paused()} />);
    rerender(<StackInstallProgress controller={paused()} />);

    expect((screen.getByPlaceholderText('NPM admin password') as HTMLInputElement).value).toBe('operator-typed');
    expect((screen.getByPlaceholderText('NPM admin email') as HTMLInputElement).value).toBe('stored@example.com');
  });

  it('re-seeds when the runner reports a genuinely different fallback (#2442)', () => {
    const { rerender } = render(<StackInstallProgress controller={makeController({
      phase: 'installing', logs: [], npmCredPrompt: true,
      npmCredFallback: { email: 'first@example.com', password: 'pw1' },
    })} />);
    rerender(<StackInstallProgress controller={makeController({
      phase: 'installing', logs: [], npmCredPrompt: true,
      npmCredFallback: { email: 'second@example.com', password: 'pw2' },
    })} />);

    expect((screen.getByPlaceholderText('NPM admin email') as HTMLInputElement).value).toBe('second@example.com');
    expect((screen.getByPlaceholderText('NPM admin password') as HTMLInputElement).value).toBe('pw2');
  });

  it('says so when ServiceBay has no stored credentials to pre-fill (#2442)', () => {
    render(<StackInstallProgress controller={makeController({
      phase: 'installing', logs: [], npmCredPrompt: true,
      npmCredFallback: { email: '', password: '' },
    })} />);

    expect(screen.getByText(/no stored credentials for this host/i)).toBeDefined();
    expect(screen.queryByText(/fields below are pre-filled/i)).toBeNull();
  });

  it('renders the retry error so a rejected submit is visible (#2442)', () => {
    render(<StackInstallProgress controller={makeController({
      phase: 'installing', logs: [], npmCredPrompt: true,
      npmCredError: 'Enter the NPM admin email — ServiceBay had no stored value to pre-fill.',
    })} />);

    expect(screen.getByRole('alert').textContent).toMatch(/Enter the NPM admin email/);
  });

  it('calls skipNpmCredentials when the operator clicks Skip', () => {
    const skip = vi.fn();
    const controller = makeController({
      phase: 'installing',
      logs: [],
      npmCredPrompt: true,
      skipNpmCredentials: skip,
    });
    render(<StackInstallProgress controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));
    expect(skip).toHaveBeenCalled();
  });
});

describe('StackInstallSummary', () => {
  it('groups system secrets in a collapsed details block', () => {
    const controller = makeController({
      phase: 'done',
      credentialsManifest: [
        { service: 'Critical', url: '/u', username: 'u', password: 'p', importance: 'critical' },
        { service: 'System secret', url: '/u', username: 's', password: 'x', importance: 'system' },
      ],
    });
    render(<StackInstallSummary controller={controller} />);
    expect(screen.getByText('Critical')).toBeDefined();
    expect(screen.getByText(/System \/ DR secrets/)).toBeDefined();
  });

  it('renders the doneFooter slot below the credentials banner', () => {
    const controller = makeController({ phase: 'done', credentialsManifest: [] });
    render(
      <StackInstallSummary
        controller={controller}
        doneFooter={<div data-testid="footer">DNS steps</div>}
      />,
    );
    expect(screen.getByTestId('footer')).toBeDefined();
  });
});
