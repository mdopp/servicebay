/**
 * KnowledgeSection (#2228) — acceptance-criteria coverage for the Settings →
 * Knowledge assists editor. Drives the real component against a mocked
 * `/api/assists/*` + `/api/approvals` surface, asserting: browse/search/filter,
 * view rendered markdown + metadata, edit with secret-scan validation error,
 * submit-as-proposal POST, approve POST, revert POST.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import KnowledgeSection, { filterAssists } from './KnowledgeSection';
import type { AssistSummary } from '../knowledge/types';

vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

const ASSISTS: AssistSummary[] = [
  { id: 'servicebay-overview', title: 'ServiceBay Overview', whenToUse: 'Understand the platform.', kind: 'guide', tags: ['overview'], source: 'Built-in' },
  { id: 'my-local-recipe', title: 'Local Recipe', whenToUse: 'A locally added recipe.', kind: 'recipe', tags: ['local'], source: 'Local' },
];

const CONTENT = `---
title: ServiceBay Overview
whenToUse: Understand the platform.
kind: guide
---
The rendered **body** text.`;

const HISTORY = [
  { version: 1, author: 'admin', timestamp: '2026-07-10T10:00:00Z', message: 'first edit' },
];

const APPROVAL = {
  id: 'req-1',
  title: 'Assist edit: servicebay-overview',
  description: 'tweak wording',
  created_at: '2026-07-11T10:00:00Z',
  status: 'pending' as const,
  payload: { kind: 'assist-edit', assistId: 'servicebay-overview', message: 'tweak wording' },
};

function mockApi(opts: { approvals?: unknown[] } = {}) {
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    if (url === '/api/assists') {
      return Promise.resolve(new Response(JSON.stringify({ assists: ASSISTS }), { status: 200 }));
    }
    if (url === '/api/approvals') {
      return Promise.resolve(new Response(JSON.stringify({ approvals: opts.approvals ?? [] }), { status: 200 }));
    }
    if (url.endsWith('/history')) {
      return Promise.resolve(new Response(JSON.stringify({ history: HISTORY }), { status: 200 }));
    }
    if (url.startsWith('/api/assists/servicebay-overview')) {
      return Promise.resolve(new Response(JSON.stringify({ id: 'servicebay-overview', content: CONTENT }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('filterAssists', () => {
  it('filters by kind and source and free-text', () => {
    expect(filterAssists(ASSISTS, '', 'recipe', 'all').map(a => a.id)).toEqual(['my-local-recipe']);
    expect(filterAssists(ASSISTS, '', 'all', 'Local').map(a => a.id)).toEqual(['my-local-recipe']);
    expect(filterAssists(ASSISTS, 'overview', 'all', 'all').map(a => a.id)).toEqual(['servicebay-overview']);
    expect(filterAssists(ASSISTS, 'nomatch', 'all', 'all')).toEqual([]);
  });
});

describe('KnowledgeSection — browse, view, edit, approve, revert', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('lists the catalog and searches it', async () => {
    mockApi();
    render(<KnowledgeSection />);
    await waitFor(() => expect(screen.getByText('ServiceBay Overview')).toBeDefined());
    expect(screen.getByText('Local Recipe')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Search the catalog'), { target: { value: 'recipe' } });
    await waitFor(() => expect(screen.queryByText('ServiceBay Overview')).toBeNull());
    expect(screen.getByText('Local Recipe')).toBeDefined();
  });

  it('renders the selected entry markdown + metadata', async () => {
    mockApi();
    render(<KnowledgeSection />);
    await waitFor(() => expect(screen.getByText('ServiceBay Overview')).toBeDefined());
    fireEvent.click(screen.getByText('ServiceBay Overview'));
    await waitFor(() => expect(screen.getByText(/rendered/)).toBeDefined());
    // history metadata surfaces
    expect(screen.getByText(/first edit/)).toBeDefined();
  });

  it('strips the YAML frontmatter from the rendered body (#2231)', async () => {
    mockApi();
    render(<KnowledgeSection />);
    await waitFor(() => expect(screen.getByText('ServiceBay Overview')).toBeDefined());
    fireEvent.click(screen.getByText('ServiceBay Overview'));
    await waitFor(() => expect(screen.getByText(/rendered/)).toBeDefined());

    // The raw YAML frontmatter lines must NOT leak into the DOM as body text.
    // (CONTENT carries a `title:/whenToUse:/kind:` frontmatter block that used to
    // render verbatim through ReactMarkdown — see #2231.)
    const domText = document.body.textContent ?? '';
    expect(domText).not.toMatch(/title:\s*ServiceBay Overview/);
    expect(domText).not.toMatch(/whenToUse:\s*Understand the platform\./);
    expect(domText).not.toMatch(/kind:\s*guide/);

    // The metadata is still surfaced as structured UI (the DetailHeader kind badge),
    // and the markdown body still renders.
    expect(screen.getAllByText('guide').length).toBeGreaterThan(0);
    expect(screen.getByText(/rendered/)).toBeDefined();
  });

  it('shows a validation error for a secret-bearing edit and blocks submit', async () => {
    mockApi();
    render(<KnowledgeSection />);
    await waitFor(() => expect(screen.getByText('ServiceBay Overview')).toBeDefined());
    fireEvent.click(screen.getByText('ServiceBay Overview'));
    await waitFor(() => expect(screen.getByText(/rendered/)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    const textarea = await screen.findByLabelText('Assist markdown source');
    fireEvent.change(textarea, {
      target: { value: `${CONTENT}\n-----BEGIN RSA PRIVATE KEY-----` },
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/secret/i));
    const submit = screen.getByRole('button', { name: /submit proposal/i });
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('submits a clean edit as a proposal (POST /propose)', async () => {
    const fetchMock = mockApi();
    render(<KnowledgeSection />);
    await waitFor(() => expect(screen.getByText('ServiceBay Overview')).toBeDefined());
    fireEvent.click(screen.getByText('ServiceBay Overview'));
    await waitFor(() => expect(screen.getByText(/rendered/)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    await screen.findByLabelText('Assist markdown source');

    fireEvent.click(screen.getByRole('button', { name: /submit proposal/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/assists/servicebay-overview/propose',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('approves a pending proposal (POST /approve/:requestId)', async () => {
    const fetchMock = mockApi({ approvals: [APPROVAL] });
    render(<KnowledgeSection />);
    await waitFor(() => expect(screen.getByText('ServiceBay Overview')).toBeDefined());
    fireEvent.click(screen.getByText('ServiceBay Overview'));
    await waitFor(() => expect(screen.getByRole('button', { name: /approve/i })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/assists/servicebay-overview/approve/req-1',
        { method: 'POST' },
      ),
    );
  });

  it('requests a revert of a historical version (POST /revert/:version)', async () => {
    const fetchMock = mockApi();
    render(<KnowledgeSection />);
    await waitFor(() => expect(screen.getByText('ServiceBay Overview')).toBeDefined());
    fireEvent.click(screen.getByText('ServiceBay Overview'));
    await waitFor(() => expect(screen.getByText(/first edit/)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /revert/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/assists/servicebay-overview/revert/1',
        { method: 'POST' },
      ),
    );
  });
});
