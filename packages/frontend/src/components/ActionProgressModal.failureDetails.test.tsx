/**
 * #2628 — the recovery button on a failed start/stop/restart used to call
 * `addToast('info', 'AI Assistant Triggered', 'Claude is reviewing the logs…')`
 * and nothing else: no fetch, no route, nothing anywhere in the repo behind it.
 * An operator hitting a real failure was told an AI was working on it while
 * nothing happened at all.
 *
 * These tests pin the replacement: the button copies the failure and its
 * output, every outcome is derived from what actually happened, and the case
 * where nothing was copied is its own named state rather than a success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ActionProgressModal from './ActionProgressModal';
import { ToastProvider } from '@/providers/ToastProvider';

const stub = vi.hoisted(() => ({
  lines: [] as string[],
  copyToClipboard: vi.fn(async (_text: string) => true),
}));

// A terminal we can inspect: `writeln` is what the component uses to report the
// connection error, and the buffer is what the copy path reads back.
vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    buffer = {
      active: {
        get length() {
          return stub.lines.length;
        },
        getLine: (i: number) => ({ translateToString: () => stub.lines[i] ?? '' }),
      },
    };
    loadAddon() {}
    open() {}
    write(data: string) {
      stub.lines.push(...data.split('\n'));
    }
    writeln(data: string) {
      stub.lines.push(...data.split('\n'));
    }
    dispose() {}
  }
  return { Terminal: FakeTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@/app/(dashboard)/settings/_lib/clipboard', () => ({
  copyToClipboard: stub.copyToClipboard,
}));

if (!window.matchMedia) {
  window.matchMedia = vi.fn((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList));
}

/** Render the modal on a failed action and wait for the error footer. */
async function renderFailedAction(props: Record<string, unknown> = {}) {
  global.fetch = vi.fn(() => Promise.reject(new Error('socket hang up'))) as typeof global.fetch;
  render(
    <ToastProvider>
      <ActionProgressModal
        isOpen
        onClose={vi.fn()}
        serviceName="media"
        action="restart"
        onComplete={vi.fn()}
        {...props}
      />
    </ToastProvider>,
  );
  await screen.findByRole('button', { name: /Retry Action/ });
}

describe('ActionProgressModal — failure details for an assistant (#2628)', () => {
  beforeEach(() => {
    stub.lines = [];
    stub.copyToClipboard.mockClear();
    stub.copyToClipboard.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('offers a copy action, not a claim that an AI was dispatched', async () => {
    await renderFailedAction();
    expect(screen.getByRole('button', { name: /Copy Details for AI/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ask AI to Fix/ })).toBeNull();
  });

  it('copies the failure context plus the terminal output, and says how much', async () => {
    await renderFailedAction({ nodeName: 'attic' });
    await waitFor(() => expect(stub.lines.length).toBeGreaterThan(0));
    // What a real failed unit prints before the connection error line.
    stub.lines.unshift('Job for media.service failed.', 'See systemctl status media.service.');

    fireEvent.click(screen.getByRole('button', { name: /Copy Details for AI/ }));

    await waitFor(() => expect(stub.copyToClipboard).toHaveBeenCalledTimes(1));
    const copied = stub.copyToClipboard.mock.calls[0][0];
    expect(copied).toContain('restart of service "media" on node attic failed');
    expect(copied).toContain('Job for media.service failed.');
    expect(copied).toContain('socket hang up');

    // The count in the toast is the real number of lines that were copied:
    // everything after the two context lines and the blank separator.
    const outputBlock = copied.split('\n').slice(3);
    expect(outputBlock[0]).toBe('Job for media.service failed.');
    const lineCount = outputBlock.length;
    expect(lineCount).toBeGreaterThan(1);
    expect(await screen.findByText('Failure details copied')).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`^${lineCount} lines of media restart output are on the clipboard`)),
    ).toBeTruthy();
  });

  it('names the refusal when the browser blocks the clipboard, and claims nothing', async () => {
    stub.copyToClipboard.mockResolvedValue(false);
    await renderFailedAction();
    await waitFor(() => expect(stub.lines.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Copy Details for AI/ }));

    expect(await screen.findByText('Nothing was copied')).toBeTruthy();
    expect(screen.queryByText('Failure details copied')).toBeNull();
  });

  it('treats "no output to copy" as its own state instead of a silent success', async () => {
    await renderFailedAction();
    await waitFor(() => expect(stub.lines.length).toBeGreaterThan(0));
    stub.lines = [];

    fireEvent.click(screen.getByRole('button', { name: /Copy Details for AI/ }));

    expect(await screen.findByText('No details to copy')).toBeTruthy();
    expect(stub.copyToClipboard).not.toHaveBeenCalled();
    expect(screen.queryByText('Failure details copied')).toBeNull();
  });
});
