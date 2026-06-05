import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DiskImportSection, { DiskImportReview, type ScanReview } from './DiskImportSection';
import { ToastProvider } from '@/providers/ToastProvider';

const review: ScanReview = {
  sessionId: 'sess-1',
  device: '/dev/sda1',
  totalFiles: 3,
  totalBytes: 6000,
  categories: [
    { category: 'photos', files: 2, bytes: 3000, copy: 2, skipDupe: 0, conflict: 0 },
    { category: 'documents', files: 1, bytes: 3000, copy: 1, skipDupe: 0, conflict: 0 },
  ],
  actions: [
    {
      id: 'ambiguous:/mnt/misc/mystery.xyz',
      kind: 'ambiguous-folder',
      label: "Couldn't auto-sort mystery.xyz",
      subject: '/mnt/misc/mystery.xyz',
      defaultOutcome: 'Filed under documents/ — open to re-file it.',
    },
  ],
};

describe('DiskImportReview (presentational)', () => {
  it('renders per-category sizing and the non-blocking actions[]', () => {
    render(<DiskImportReview review={review} onConfirm={() => {}} onCancel={() => {}} busy={false} />);

    // Per-category rows.
    expect(screen.getByText('photos')).toBeDefined();
    expect(screen.getByText('documents')).toBeDefined();

    // Ambiguous item surfaces as an action — and the copy says it doesn't block.
    const actions = screen.getByTestId('disk-import-actions');
    expect(actions.textContent).toContain("Couldn't auto-sort mystery.xyz");
    expect(screen.getByText(/don't block the import/i)).toBeDefined();
  });

  it('fires onConfirm only on the explicit Confirm & import click (review gate)', () => {
    const onConfirm = vi.fn();
    render(<DiskImportReview review={review} onConfirm={onConfirm} onCancel={() => {}} busy={false} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Confirm & import/i));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders even with zero actions (nothing ambiguous → no action wall)', () => {
    render(
      <DiskImportReview
        review={{ ...review, actions: [] }}
        onConfirm={() => {}}
        onCancel={() => {}}
        busy={false}
      />,
    );
    expect(screen.queryByTestId('disk-import-actions')).toBeNull();
    expect(screen.getByText(/Confirm & import/i)).toBeDefined();
  });
});

/** Fresh Response per call, dispatched by URL (memory: never reuse a Response). */
function mockFetchByUrl(map: Record<string, () => unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = Object.keys(map).find(k => url.includes(k));
    const body = key ? map[key]() : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

const renderSection = () => render(<ToastProvider><DiskImportSection /></ToastProvider>);

describe('DiskImportSection (flow)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetchByUrl({
      'list-devices': () => ({ ok: true, devices: [{ path: '/dev/sda1', display: 'USB (15 GB, exfat)' }] }),
      'disk-import/scan': () => ({ ok: true, ...review }),
      'disk-import/apply': () => ({ ok: true, applied: 3, items: [] }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('walks device → scan → review → confirm → apply with the apply gated on the reviewed plan', async () => {
    renderSection();

    // Device auto-selected (single device); scan it.
    const scanBtn = await screen.findByText('Scan disk');
    fireEvent.click(scanBtn);

    // Review appears with the plan + the ambiguous action (non-blocking).
    await waitFor(() => expect(screen.getByTestId('disk-import-review')).toBeDefined());
    expect(screen.getByTestId('disk-import-actions')).toBeDefined();

    // Confirm → apply.
    fireEvent.click(screen.getByText(/Confirm & import/i));

    await waitFor(() => expect(screen.getByText(/Imported 3 file/i)).toBeDefined());

    // The apply call carried the reviewed plan's sessionId + explicit confirm.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const applyCall = fetchMock.mock.calls.find(c => String(c[0]).includes('disk-import/apply'));
    expect(applyCall).toBeDefined();
    const sent = JSON.parse((applyCall![1] as RequestInit).body as string);
    expect(sent).toEqual({ sessionId: 'sess-1', confirmed: true });
  });
});
