import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DiskImportSection, { DiskImportReview, JobProgressView, type ScanReview } from './DiskImportSection';
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

describe('JobProgressView (presentational)', () => {
  it('shows the scan phase label + scanned/hashed counts', () => {
    render(
      <JobProgressView
        status={{
          sessionId: 'sess-1',
          device: '/dev/sda1',
          phase: 'scanning',
          progress: { step: 'hash', scanned: 100, hashed: 30, copied: 0, bytes: 0, total: 50 },
        }}
      />,
    );
    expect(screen.getByText(/Checking for duplicates/i)).toBeDefined();
    const p = screen.getByTestId('disk-import-progress');
    expect(p.textContent).toContain('100'); // scanned
    expect(p.textContent).toContain('30 / 50'); // hashed / total
  });

  it('shows the apply phase label + copied/bytes counts', () => {
    render(
      <JobProgressView
        status={{
          sessionId: 'sess-1',
          device: '/dev/sda1',
          phase: 'applying',
          progress: { step: 'copy', scanned: 0, hashed: 0, copied: 2, bytes: 4096, total: 3 },
        }}
      />,
    );
    expect(screen.getByText(/Copying files/i)).toBeDefined();
    const p = screen.getByTestId('disk-import-progress');
    expect(p.textContent).toContain('2 / 3'); // copied / total
    expect(p.textContent).toContain('4.0 KB'); // bytes
  });
});

/**
 * Stateful fetch mock: scan/apply hand back a jobId immediately, then the
 * status poll walks scanning → reviewed/applied across calls (#1897). Fresh
 * Response per call (memory: never reuse a Response).
 */
function mockAsyncFetch(opts: {
  /** Status payloads the poll returns, in order; the last one repeats. */
  statuses: Array<Record<string, unknown> | { __status: number; body: Record<string, unknown> }>;
}) {
  let pollIdx = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    let body: Record<string, unknown> = {};
    let status = 200;
    if (url.includes('list-devices')) {
      body = { ok: true, devices: [{ path: '/dev/sda1', display: 'USB (15 GB, exfat)' }] };
    } else if (url.includes('disk-import/scan')) {
      body = { ok: true, jobId: 'sess-1' };
    } else if (url.includes('disk-import/apply')) {
      body = { ok: true, jobId: 'sess-1' };
    } else if (url.includes('disk-import/status')) {
      const next = opts.statuses[Math.min(pollIdx, opts.statuses.length - 1)];
      pollIdx += 1;
      if (next && '__status' in next) {
        const err = next as { __status: number; body: Record<string, unknown> };
        status = err.__status;
        body = err.body;
      } else {
        body = (next as Record<string, unknown>) ?? {};
      }
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
}

const renderSection = () => render(<ToastProvider><DiskImportSection /></ToastProvider>);

describe('DiskImportSection (async flow)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scan returns a jobId, polls to reviewed, confirms, polls to applied — apply gated on the reviewed plan', async () => {
    vi.stubGlobal('fetch', mockAsyncFetch({
      statuses: [
        { ok: true, sessionId: 'sess-1', device: '/dev/sda1', phase: 'scanning', progress: { step: 'walk', scanned: 0, hashed: 0, copied: 0, bytes: 0, total: 0 } },
        { ok: true, sessionId: 'sess-1', device: '/dev/sda1', phase: 'reviewed', progress: { step: 'done', scanned: 3, hashed: 3, copied: 0, bytes: 0, total: 3 }, review },
        // after apply starts, the poll resets to these:
        { ok: true, sessionId: 'sess-1', device: '/dev/sda1', phase: 'applying', progress: { step: 'copy', scanned: 0, hashed: 0, copied: 1, bytes: 1000, total: 3 } },
        { ok: true, sessionId: 'sess-1', device: '/dev/sda1', phase: 'applied', progress: { step: 'done', scanned: 0, hashed: 0, copied: 3, bytes: 6000, total: 3 }, applied: 3 },
      ],
    }));
    renderSection();

    // Device auto-selected; scan it → background job, progress frame shown.
    const scanBtn = await screen.findByText('Scan disk');
    fireEvent.click(scanBtn);
    await waitFor(() => expect(screen.getByTestId('disk-import-progress')).toBeDefined());

    // Poll reaches `reviewed` → the review payload renders.
    await waitFor(() => expect(screen.getByTestId('disk-import-review')).toBeDefined());
    expect(screen.getByTestId('disk-import-actions')).toBeDefined();

    // Confirm → apply (background) → progress → done.
    fireEvent.click(screen.getByText(/Confirm & import/i));
    await waitFor(() => expect(screen.getByText(/Imported 3 file/i)).toBeDefined());

    // The apply call carried the reviewed plan's sessionId + explicit confirm.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const applyCall = fetchMock.mock.calls.find(c => String(c[0]).includes('disk-import/apply'));
    expect(applyCall).toBeDefined();
    const sent = JSON.parse((applyCall![1] as RequestInit).body as string);
    expect(sent).toEqual({ sessionId: 'sess-1', confirmed: true });
  });

  it('re-attaches to a finished scan job left in localStorage after a reload', async () => {
    window.localStorage.setItem('sb.diskImport.activeJob', 'sess-1');
    vi.stubGlobal('fetch', mockAsyncFetch({
      statuses: [
        { ok: true, sessionId: 'sess-1', device: '/dev/sda1', phase: 'reviewed', progress: { step: 'done', scanned: 3, hashed: 3, copied: 0, bytes: 0, total: 3 }, review },
      ],
    }));
    renderSection();

    // No click — the card re-attaches by id and lands straight on the review.
    await waitFor(() => expect(screen.getByTestId('disk-import-review')).toBeDefined());
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('disk-import/status?id=sess-1'))).toBe(true);
    // localStorage cleared once the job reached a terminal phase.
    expect(window.localStorage.getItem('sb.diskImport.activeJob')).toBeNull();
    window.localStorage.clear();
  });

  it('drops a stale localStorage job id when the status route 404s (pruned job)', async () => {
    window.localStorage.setItem('sb.diskImport.activeJob', 'gone');
    vi.stubGlobal('fetch', mockAsyncFetch({
      statuses: [{ __status: 404, body: { ok: false, error: 'unknown job' } }],
    }));
    renderSection();

    // Falls back to the device picker; stale id cleared.
    await waitFor(() => expect(screen.getByText('Scan disk')).toBeDefined());
    expect(window.localStorage.getItem('sb.diskImport.activeJob')).toBeNull();
    window.localStorage.clear();
  });
});
