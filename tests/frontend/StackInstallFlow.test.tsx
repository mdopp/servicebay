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
    error: null,
    cleanInstall: false,
    cleanInstallConfirm: '',
    setCleanInstall: noop,
    setCleanInstallConfirm: noop,
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
    expect(screen.getByText(/Clean install/)).toBeDefined();
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
  it('toggles cleanInstall via the checkbox', () => {
    const setCleanInstall = vi.fn();
    const controller = makeController({
      phase: 'configure',
      setCleanInstall,
    });
    render(<StackInstallConfigureForm controller={controller} />);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(setCleanInstall).toHaveBeenCalledWith(true);
  });

  it('shows the RESET confirmation field only when cleanInstall is true', () => {
    const controller = makeController({ phase: 'configure', cleanInstall: true });
    render(<StackInstallConfigureForm controller={controller} />);
    expect(screen.getByPlaceholderText('RESET')).toBeDefined();
  });

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
