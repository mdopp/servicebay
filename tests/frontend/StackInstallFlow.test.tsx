import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import StackInstallFlow, {
  StackInstallConfigureForm,
  StackInstallProgress,
  StackInstallSummary,
} from '@/components/StackInstallFlow';
import type { UseStackInstallReturn } from '@/hooks/useStackInstall';
import { CREDENTIALS_CHANGED_EVENT } from '@/components/CredentialHandoverGate';

/** Build a minimal controller stub the components can render against. */
function makeController(overrides: Partial<UseStackInstallReturn> = {}): UseStackInstallReturn {
  const noop = () => {};
  return {
    phase: 'idle',
    items: [],
    variables: [],
    logs: [],
    installingNow: null,
    deployedNames: [],
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
    const { container } = render(<StackInstallFlow controller={controller} />);
    expect(screen.getByText('Stack installation complete.')).toBeDefined();
    // #2560 — the done step never prints a password again. The hand-over is
    // a file, and the blocking gate in the dashboard layout owns it.
    expect(container.textContent).not.toContain('p4ssw0rd');
    expect(screen.queryByRole('button', { name: /Download CSV/i })).toBeNull();
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

// ─── #2601 — a run that deployed nothing must not read as a finished one ───
describe('StackInstallProgress — terminal state honesty (#2601)', () => {
  /** The exact shape the reference box produced on 2026-08-24: a single
   *  `media` upgrade seeded with 16 already-installed dependency satisfiers,
   *  stopped by the missing v7→v8 migration hop before `deployItem`. */
  function silentStopController(extra: Partial<UseStackInstallReturn> = {}) {
    return makeController({
      phase: 'error',
      error: 'Migration chain for media is incomplete: no script for v7→v8 (have v1, v3, v4, v5, v6). Aborting deploy.',
      items: [
        { name: 'media', checked: true },
        { name: 'nginx', checked: false, alreadyInstalled: true },
        { name: 'auth', checked: false, alreadyInstalled: true },
      ],
      deployedNames: ['nginx', 'auth'],
      logs: [
        "✅ media's dependencies are healthy.",
        'Installing media...',
        '❌ Migration chain for media is incomplete: no script for v7→v8 (have v1, v3, v4, v5, v6). Aborting deploy.',
      ],
      ...extra,
    });
  }

  it('states the failure the runner reported — it used to render nowhere', () => {
    render(<StackInstallProgress controller={silentStopController()} />);
    // `controller.error` was populated by the status poll and read by no
    // component at all before this; the operator saw a green tick and buttons.
    expect(screen.getByRole('alert').textContent).toMatch(/Migration chain for media is incomplete/);
  });

  it('says nothing was deployed, and does not count the skipped dependencies as deployed', () => {
    render(<StackInstallProgress controller={silentStopController()} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Nothing was deployed/i);
    // deployedNames carries nginx + auth (skipped satisfiers). The denominator
    // that matters is the REQUESTED set — 0 of 1, not 2 of 3.
    expect(alert.textContent).toMatch(/0 of 1 requested service/);
    expect(alert.textContent).toMatch(/Still on the previous version: media/);
  });

  it('the failure is on screen without expanding the service row', () => {
    const { container } = render(<StackInstallProgress controller={silentStopController()} />);
    // The row is collapsed by default; the ❌ line must still be in the tail.
    expect(screen.queryByText(/No log lines yet for media/)).toBeNull();
    const tail = container.querySelectorAll('.font-mono');
    const tailText = Array.from(tail).map(e => e.textContent).join(' ');
    expect(tailText).toMatch(/Migration chain for media is incomplete/);
  });

  it('marks the row that failed as Failed, not Pending', () => {
    render(<StackInstallProgress controller={silentStopController()} />);
    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.queryByText('Pending')).toBeNull();
  });

  it('a genuinely successful run shows no failure banner', () => {
    render(<StackInstallProgress controller={makeController({
      phase: 'done',
      items: [{ name: 'media', checked: true }, { name: 'nginx', checked: false, alreadyInstalled: true }],
      deployedNames: ['media', 'nginx'],
      logs: ['Installing media...', '✅ media deployed.'],
    })} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Deployed')).toBeDefined();
  });

  it('flags a run that ended `done` having rolled nothing out', () => {
    // Defence in depth: the runner now ends such a run in `error`, but a job
    // recorded before that fix (or replayed from disk) must still not read as
    // a success.
    render(<StackInstallProgress controller={makeController({
      phase: 'done',
      items: [{ name: 'media', checked: true }],
      deployedNames: [],
      logs: ['✅ Pulled 1/1 image.'],
    })} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing was deployed/i);
  });
});

// ─── #2600 — dependency satisfiers are not sixteen rows of pending work ────
describe('InstallServiceRows — already-installed dependencies (#2600)', () => {
  const satisfiers = ['nginx', 'auth', 'adguard', 'vaultwarden', 'immich', 'radicale'];
  const upgradeController = (overrides: Partial<UseStackInstallReturn> = {}) => makeController({
    phase: 'installing',
    items: [
      { name: 'home-assistant', checked: true },
      ...satisfiers.map(name => ({ name, checked: false, alreadyInstalled: true })),
    ],
    installingNow: 'home-assistant',
    deployedNames: [],
    logs: ['Installing home-assistant...'],
    ...overrides,
  });

  it('renders one row for the service being upgraded, not one per installed service', () => {
    render(<StackInstallProgress controller={upgradeController()} />);
    expect(screen.getByText('home-assistant')).toBeDefined();
    // The satisfiers used to each render their own row, permanently "Pending"
    // because a skipped item never emits the `Installing X...` marker the
    // status was inferred from.
    for (const name of satisfiers) {
      expect(screen.queryByText(name)).toBeNull();
    }
    expect(screen.queryByText('Pending')).toBeNull();
  });

  it('collapses them behind one labelled, counted row', () => {
    render(<StackInstallProgress controller={upgradeController()} />);
    expect(screen.getByText(`${satisfiers.length} already-installed dependencies`)).toBeDefined();
    expect(screen.getByText('Not touched')).toBeDefined();
  });

  it('still lists them on expand — the install order keeps its meaning', () => {
    render(<StackInstallProgress controller={upgradeController()} />);
    fireEvent.click(screen.getByRole('button', { name: /already-installed dependencies/ }));
    for (const name of satisfiers) {
      expect(screen.getByText(name)).toBeDefined();
    }
  });

  it('singularises the summary row for a single satisfier', () => {
    render(<StackInstallProgress controller={makeController({
      phase: 'installing',
      items: [
        { name: 'media', checked: true },
        { name: 'nginx', checked: false, alreadyInstalled: true },
      ],
      installingNow: 'media',
      deployedNames: [],
      logs: [],
    })} />);
    expect(screen.getByText('1 already-installed dependency')).toBeDefined();
  });

  it('a real stack install still shows every selected service as its own row', () => {
    render(<StackInstallProgress controller={makeController({
      phase: 'installing',
      items: [
        { name: 'nginx', checked: true },
        { name: 'auth', checked: true },
        { name: 'immich', checked: true },
      ],
      installingNow: 'nginx',
      deployedNames: [],
      logs: ['Installing nginx...'],
    })} />);
    expect(screen.getByText('nginx')).toBeDefined();
    expect(screen.getByText('auth')).toBeDefined();
    expect(screen.getByText('immich')).toBeDefined();
    expect(screen.queryByText(/already-installed/)).toBeNull();
    // The two not yet started are genuinely pending — that word is still right here.
    expect(screen.getAllByText('Pending')).toHaveLength(2);
  });
});

describe('StackInstallSummary', () => {
  it('shows no secret and wakes the hand-over gate instead (#2560)', () => {
    const events: string[] = [];
    const listener = () => events.push('changed');
    window.addEventListener(CREDENTIALS_CHANGED_EVENT, listener);
    const controller = makeController({
      phase: 'done',
      credentialsManifest: [
        { service: 'Critical', url: '/u', username: 'u', password: 'p', importance: 'critical' },
        { service: 'System secret', url: '/u', username: 's', password: 'x', importance: 'system' },
      ],
    });
    const { container } = render(<StackInstallSummary controller={controller} />);
    window.removeEventListener(CREDENTIALS_CHANGED_EVENT, listener);

    expect(container.textContent).not.toContain('System secret');
    expect(events).toEqual(['changed']);
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
