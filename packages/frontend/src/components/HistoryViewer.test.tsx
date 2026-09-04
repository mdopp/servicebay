/**
 * HistoryViewer — Button primitive swap (no-raw-ui-primitive sweep, b640d089).
 *
 * The version-list rows and the "Restore this version" action moved off raw
 * `<button>` onto the shared `<Button>` primitive from `@/components/ui`; the
 * component had no test at all, so that swap shipped with zero coverage.
 * These tests render both states the swap touches: the history list (ghost
 * Button rows) and, once a version is selected, the restore action (primary
 * Button) — asserting each renders as a real `<button>` with its accessible
 * name and that clicking it drives the handler it's wired to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const typedFetchMock = vi.fn();
const apiFetchMock = vi.fn();
vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  typedFetch: (...args: unknown[]) => typedFetchMock(...args),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import HistoryViewer from './HistoryViewer';

const ENTRIES = [
  { timestamp: '2026-09-01T00:00:00.000Z', displayDate: 'Sep 1, 2026', filename: 'config.yaml', path: '/data/config.yaml' },
  { timestamp: '2026-09-02T00:00:00.000Z', displayDate: 'Sep 2, 2026', filename: 'config.yaml', path: '/data/config.yaml' },
];

describe('HistoryViewer — Button primitive swap (#no-raw-ui-primitive)', () => {
  beforeEach(() => {
    typedFetchMock.mockReset();
    apiFetchMock.mockReset();
  });

  it('renders each history entry as a real Button and selecting one fetches its content', async () => {
    typedFetchMock.mockResolvedValue(ENTRIES);
    apiFetchMock.mockResolvedValue({ text: () => Promise.resolve('old content') });

    render(
      <HistoryViewer filename="config.yaml" currentContent="new content" onRestore={vi.fn()} />,
    );

    const entryButton = await screen.findByRole('button', { name: 'Sep 1, 2026' });
    expect(entryButton.tagName).toBe('BUTTON');
    expect(entryButton.getAttribute('type')).toBe('button');

    fireEvent.click(entryButton);

    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/history/config.yaml?timestamp=2026-09-01T00:00:00.000Z'),
    );
  });

  it('shows a primary "Restore this version" Button once a version is selected, and clicking it restores the content', async () => {
    typedFetchMock.mockResolvedValue(ENTRIES);
    apiFetchMock.mockResolvedValue({ text: () => Promise.resolve('old content') });
    const onRestore = vi.fn();

    render(
      <HistoryViewer filename="config.yaml" currentContent="new content" onRestore={onRestore} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sep 1, 2026' }));

    const restoreButton = await screen.findByRole('button', { name: /Restore this version/i });
    expect(restoreButton.tagName).toBe('BUTTON');

    fireEvent.click(restoreButton);
    expect(onRestore).toHaveBeenCalledWith('old content');
  });
});
