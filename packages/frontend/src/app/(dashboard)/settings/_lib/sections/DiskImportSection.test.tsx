import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import DiskImportSection, {
  DiskImportReview,
  DiskImportTree,
  JobProgressView,
  type ScanReview,
} from './DiskImportSection';
import type { FolderNode, Rule } from '../routingTree';
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

/** A review-tree fixture: root + an exact-match auto-assigned `mdopp/` owner. */
const treeNodes: FolderNode[] = [
  {
    dir: '',
    files: 0,
    bytes: 0,
    categories: [],
    explicit: {},
    resolved: { disposition: 'auto', mode: 'merge', owner: 'shared', anchor: '' },
  },
  {
    dir: 'mdopp',
    files: 2,
    bytes: 3000,
    categories: ['photos'],
    explicit: { owner: 'mdopp' }, // exact-match auto-assigned
    resolved: { disposition: 'auto', mode: 'merge', owner: 'mdopp', anchor: '' },
  },
  {
    dir: 'mdopp/Filme',
    files: 1,
    bytes: 3000,
    categories: ['movies'],
    explicit: {},
    resolved: { disposition: 'auto', mode: 'merge', owner: 'mdopp', anchor: '' },
  },
];

const treeReview: ScanReview = {
  ...review,
  tree: treeNodes,
  boxUsers: ['mdopp', 'cdopp'],
  defaultOwner: 'shared',
};

const noop = () => {};
const reviewProps = {
  rules: {} as Record<string, Rule>,
  defaultOwner: 'shared',
  onRuleChange: noop,
  onDefaultOwnerChange: noop,
  onConfirm: noop,
  onCancel: noop,
  busy: false,
};

describe('DiskImportReview (presentational)', () => {
  it('renders per-category sizing and the non-blocking actions[]', () => {
    render(<DiskImportReview {...reviewProps} review={review} />);

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
    render(<DiskImportReview {...reviewProps} review={review} onConfirm={onConfirm} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Confirm & import/i));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders even with zero actions (nothing ambiguous → no action wall)', () => {
    render(<DiskImportReview {...reviewProps} review={{ ...review, actions: [] }} />);
    expect(screen.queryByTestId('disk-import-actions')).toBeNull();
    expect(screen.getByText(/Confirm & import/i)).toBeDefined();
  });

  it('shows the per-folder tree + disk-default-owner picker when a tree is present', () => {
    // The section seeds the edit map from the tree's explicit rules (the
    // exact-match auto-assigned `mdopp` owner); pass that seed here.
    render(<DiskImportReview {...reviewProps} review={treeReview} rules={{ mdopp: { owner: 'mdopp' } }} />);
    expect(screen.getByTestId('disk-import-tree')).toBeDefined();
    expect(screen.getByLabelText('Disk default owner')).toBeDefined();
    // The exact-match auto-assigned owner (`mdopp/`) renders pre-selected.
    const node = screen.getByTestId('tree-node-mdopp');
    const ownerSelect = within(node).getByLabelText('Owner') as HTMLSelectElement;
    expect(ownerSelect.value).toBe('mdopp');
  });

  it('omits the tree for a pre-#1915 payload with no tree', () => {
    render(<DiskImportReview {...reviewProps} review={review} />);
    expect(screen.queryByTestId('disk-import-tree')).toBeNull();
  });

  it('shows a NON-BLOCKING "checking duplicates…" line while dedup runs (#1937)', () => {
    render(
      <DiskImportReview
        {...reviewProps}
        review={review}
        dedup={{ state: 'running', hashed: 7168, total: 155875 }}
      />,
    );
    // The duplicate-check note shows progress, the tree/review is fully rendered,
    // and Confirm is available — dedup never gates the review.
    const note = screen.getByTestId('disk-import-dedup');
    expect(note.textContent).toMatch(/checking for duplicates/i);
    expect(note.textContent).toContain('7168 / 155875');
    expect(screen.getByText(/Confirm & import/i)).toBeDefined();
  });

  it('shows nothing once dedup is done (no noise)', () => {
    render(<DiskImportReview {...reviewProps} review={review} dedup={{ state: 'done', hashed: 5, total: 5 }} />);
    expect(screen.queryByTestId('disk-import-dedup')).toBeNull();
  });

  it('warns when dedup was partial (some files un-checked → imported as-is)', () => {
    render(<DiskImportReview {...reviewProps} review={review} dedup={{ state: 'partial', hashed: 3, total: 5 }} />);
    expect(screen.getByTestId('disk-import-dedup').textContent).toMatch(/couldn't be checked/i);
  });
});

describe('DiskImportTree (per-folder routing)', () => {
  it('distinguishes inherited from explicit and previews the resolved target', () => {
    render(
      <DiskImportTree
        nodes={treeNodes}
        rules={{ mdopp: { owner: 'mdopp' } }}
        defaultOwner="shared"
        boxUsers={['mdopp', 'cdopp']}
        onChange={() => {}}
      />,
    );
    // Explicit owner on `mdopp/` is NOT inherited → solid (no italic class).
    const mdopp = screen.getByTestId('tree-node-mdopp');
    const explicitOwner = within(mdopp).getByLabelText('Owner') as HTMLSelectElement;
    expect(explicitOwner.value).toBe('mdopp');
    expect(explicitOwner.className).not.toContain('italic');

    // The child `mdopp/Filme` inherits the owner from `mdopp/` → italic + the
    // resolved target preview reflects the inherited owner (`data/mdopp/…`).
    const child = screen.getByTestId('tree-node-mdopp/Filme');
    const childOwner = within(child).getByLabelText('Owner') as HTMLSelectElement;
    expect(childOwner.className).toContain('italic');
    expect(childOwner.value).toBe('__inherit__');
    expect(screen.getByTestId('tree-target-mdopp/Filme').textContent).toContain('data/mdopp/');
  });

  it('edits flow through onChange (owner override) and clearing reverts to inherit', () => {
    const onChange = vi.fn();
    render(
      <DiskImportTree
        nodes={treeNodes}
        rules={{}}
        defaultOwner="shared"
        boxUsers={['mdopp', 'cdopp']}
        onChange={onChange}
      />,
    );
    const child = screen.getByTestId('tree-node-mdopp/Filme');
    const disp = within(child).getByLabelText('Disposition');
    // Pick "Movies → Jellyfin" on the child → an explicit disposition edit.
    fireEvent.change(disp, { target: { value: 'movies_jellyfin' } });
    expect(onChange).toHaveBeenCalledWith('mdopp/Filme', 'disposition', 'movies_jellyfin');
    // Re-pick "Inherited" → clears the axis (value === undefined).
    fireEvent.change(disp, { target: { value: '__inherit__' } });
    expect(onChange).toHaveBeenCalledWith('mdopp/Filme', 'disposition', undefined);
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

  it('a review-tree owner edit flows through to the apply body (rules + defaultOwner)', async () => {
    vi.stubGlobal('fetch', mockAsyncFetch({
      statuses: [
        { ok: true, sessionId: 'sess-1', device: '/dev/sda1', phase: 'reviewed', progress: { step: 'done', scanned: 3, hashed: 3, copied: 0, bytes: 0, total: 3 }, review: treeReview },
        { ok: true, sessionId: 'sess-1', device: '/dev/sda1', phase: 'applied', progress: { step: 'done', scanned: 0, hashed: 0, copied: 3, bytes: 6000, total: 3 }, applied: 3 },
      ],
    }));
    renderSection();

    fireEvent.click(await screen.findByText('Scan disk'));
    await waitFor(() => expect(screen.getByTestId('disk-import-tree')).toBeDefined());

    // Override the child folder's owner from the picker, then confirm.
    const child = screen.getByTestId('tree-node-mdopp/Filme');
    fireEvent.change(within(child).getByLabelText('Owner'), { target: { value: 'cdopp' } });
    fireEvent.click(screen.getByText(/Confirm & import/i));
    await waitFor(() => expect(screen.getByText(/Imported 3 file/i)).toBeDefined());

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const applyCall = fetchMock.mock.calls.find(c => String(c[0]).includes('disk-import/apply'));
    const sent = JSON.parse((applyCall![1] as RequestInit).body as string);
    expect(sent.sessionId).toBe('sess-1');
    expect(sent.confirmed).toBe(true);
    // Seeded auto-assign (mdopp owner) + the new child override both ride along.
    expect(sent.rules).toMatchObject({ mdopp: { owner: 'mdopp' }, 'mdopp/Filme': { owner: 'cdopp' } });
    expect(sent.defaultOwner).toBe('shared');
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

  it('"Start over" on a stuck scan aborts the session and returns to the picker (#1943)', async () => {
    // The scan starts but never advances past `scanning` — the zombie case.
    vi.stubGlobal('fetch', mockAsyncFetch({
      statuses: [
        { ok: true, sessionId: 'sess-1', device: '/dev/sda1', phase: 'scanning', progress: { step: 'mount', scanned: 0, hashed: 0, copied: 0, bytes: 0, total: 0 } },
      ],
    }));
    renderSection();

    fireEvent.click(await screen.findByText('Scan disk'));
    await waitFor(() => expect(screen.getByTestId('disk-import-progress')).toBeDefined());

    // The escape hatch is offered; clicking it POSTs the abort + returns to pick.
    fireEvent.click(screen.getByTestId('disk-import-start-over'));
    await waitFor(() => expect(screen.getByText('Scan disk')).toBeDefined());

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const abortCall = fetchMock.mock.calls.find(c => String(c[0]).includes('disk-import/abort'));
    expect(abortCall).toBeDefined();
    expect(JSON.parse((abortCall![1] as RequestInit).body as string)).toEqual({ id: 'sess-1' });
    expect(window.localStorage.getItem('sb.diskImport.activeJob')).toBeNull();
    window.localStorage.clear();
  });
});
