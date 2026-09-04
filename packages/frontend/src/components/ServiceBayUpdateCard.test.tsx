/**
 * ServiceBayUpdateCard — channel + running-build honesty (#2708).
 *
 * The card used to compare `current` against the latest release tag and say
 * "You are on the latest version" whenever they matched. On the `:dev` channel
 * an unreleased commit still carries the LAST release's version (release-please
 * only bumps on the release commit), so a box running an unreleased build was
 * indistinguishable from a box running the release — every single value true,
 * the statement false.
 *
 * These specs pin both halves: the `:dev` state must NOT claim "latest
 * version", and the ordinary `:latest`-on-the-release state must be unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ServiceBayUpdateCard from './ServiceBayUpdateCard';
import { ToastProvider } from '@/providers/ToastProvider';

const CONFIG = { autoUpdate: { enabled: false, schedule: '' } };

/** Box on `:latest`, running the published release — the ordinary case. */
const ON_RELEASE = {
  hasUpdate: false,
  current: '5.22.2',
  latest: { version: 'v5.22.2', url: 'u', date: 'd', notes: '' },
  running: { channel: 'latest', revision: 'aaaaaaaabbbbbbbbccccccccdddddddd11111111' },
  unreleasedBuild: false,
  config: CONFIG,
};

/**
 * Box left on `:dev` after a flip that never flipped back — the exact shape
 * that read "Up to date" in the field. Note `current` EQUALS the release tag:
 * the version number is not wrong, it is just not the whole truth.
 */
const ON_DEV_UNRELEASED = {
  hasUpdate: false,
  current: '5.22.2',
  latest: { version: 'v5.22.2', url: 'u', date: 'd', notes: '' },
  running: { channel: 'dev', revision: 'd01054f5aaaaaaaabbbbbbbbcccccccc22222222' },
  unreleasedBuild: true,
  config: CONFIG,
};

function stubUpdateStatus(status: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => status })) as unknown as typeof fetch,
  );
}

/** Like `stubUpdateStatus`, but a POST `configure` action echoes the
 *  requested `enabled` value back in `config` — so the auto-update toggle
 *  test below can observe a real flip instead of the GET snapshot. */
function stubUpdateFlow(initial: { config: { autoUpdate: { enabled: boolean; schedule: string } } }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const parsed = JSON.parse(init.body) as { action?: string; autoUpdate?: { enabled: boolean } };
        if (parsed.action === 'configure' && parsed.autoUpdate) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              config: { autoUpdate: { enabled: parsed.autoUpdate!.enabled, schedule: '' } },
            }),
          };
        }
      }
      return { ok: true, json: async () => initial };
    }) as unknown as typeof fetch,
  );
}

function renderCard() {
  return render(
    <ToastProvider>
      <ServiceBayUpdateCard />
    </ToastProvider>,
  );
}

describe('ServiceBayUpdateCard — release channel + running build (#2708)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT claim "You are on the latest version" while running an unreleased :dev build', async () => {
    stubUpdateStatus(ON_DEV_UNRELEASED);
    renderCard();

    // The card has to have loaded — otherwise this would pass on the spinner.
    await waitFor(() => expect(screen.getByText('5.22.2')).toBeDefined());

    expect(screen.queryByText(/You are on the latest version/i)).toBeNull();
  });

  it('names the channel and the unreleased running build on :dev', async () => {
    stubUpdateStatus(ON_DEV_UNRELEASED);
    const { container } = renderCard();

    await waitFor(() => expect(screen.getByText('5.22.2')).toBeDefined());

    const text = container.textContent ?? '';
    // The channel is named, not inferred.
    expect(text).toMatch(/dev channel/i);
    // The running build is identified by its commit, since the version can't.
    expect(text).toMatch(/d01054f/);
    expect(text).toMatch(/unreleased build/i);

    // A legitimate operating state, not an alarm: no failure styling.
    expect(container.innerHTML).not.toMatch(/status-fail/);
  });

  it('still reads "Up to date" on :latest with the current release', async () => {
    stubUpdateStatus(ON_RELEASE);
    renderCard();

    await waitFor(() => expect(screen.getByText('5.22.2')).toBeDefined());
    expect(screen.getByText(/You are on the latest version/i)).toBeDefined();
    // No channel chip clutters the ordinary case.
    expect(screen.queryByText(/unreleased/i)).toBeNull();
  });

  it('keeps reading "Up to date" when the backend sends no running-build info at all', async () => {
    stubUpdateStatus({ ...ON_RELEASE, running: undefined, unreleasedBuild: undefined });
    renderCard();

    await waitFor(() => expect(screen.getByText('5.22.2')).toBeDefined());
    expect(screen.getByText(/You are on the latest version/i)).toBeDefined();
  });

  // sb/no-raw-ui-primitive sweep: the auto-update toggle now renders through
  // the shared Input primitive (@/components/ui) instead of a raw
  // <input type="checkbox">. Assert it's a real checkbox input reflecting
  // config state, and that clicking it still round-trips through
  // configureAutoUpdate and flips the displayed state.
  it('renders the auto-update toggle as a ui Input checkbox and flips it on click', async () => {
    stubUpdateFlow(ON_RELEASE);
    renderCard();

    await waitFor(() => expect(screen.getByText('5.22.2')).toBeDefined());

    const toggle = screen.getByRole('checkbox') as HTMLInputElement;
    expect(toggle.tagName).toBe('INPUT');
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.checked).toBe(true));
  });
});
