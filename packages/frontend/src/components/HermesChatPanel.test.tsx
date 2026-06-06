/**
 * HermesChatPanel tests (#1755, part B of epic #1704; #1760 history reload).
 *
 * Covers: mount-time history load (GET) + empty state, send -> calls POST
 * /api/system/hermes/chat and shows the reply, the 503 "Hermes is unavailable"
 * graceful state, and the typing indicator while a turn is in flight.
 *
 * fetch is mocked with mockImplementation returning a FRESH Response per call
 * (memory feedback_vitest_fetch_response_reuse — a shared Response body can
 * only be read once, so parallel/sequential reads hang). The mount GET and a
 * subsequent POST are routed by method so each gets its own fresh Response.
 *
 * No @testing-library/jest-dom in this repo's setup, so assertions use
 * toBeDefined/toBeNull/textContent (matching the existing FE test style).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import HermesChatPanel from './HermesChatPanel';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Mock fetch routing GET (mount history) and POST (send) separately, a fresh
 * Response per call. `get` defaults to an empty history so a test that only
 * cares about send doesn't have to spell it out.
 */
function mockFetch(handlers: {
  get?: () => Response;
  post?: () => Response;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return handlers.get ? handlers.get() : jsonResponse(200, { messages: [] });
    }
    return handlers.post ? handlers.post() : jsonResponse(200, { reply: '' });
  });
}

describe('HermesChatPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty maintenance-assistant state when the history loads empty', async () => {
    mockFetch({ get: () => jsonResponse(200, { messages: [] }) });
    render(<HermesChatPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Maintenance assistant/i)).toBeDefined();
    });
    expect(screen.queryByTestId('hermes-msg-user')).toBeNull();
  });

  it('loads and renders the prior conversation on mount (GET history)', async () => {
    const fetchMock = mockFetch({
      get: () =>
        jsonResponse(200, {
          messages: [
            { role: 'user', text: 'what is broken?' },
            { role: 'assistant', text: 'Let me check your services.' },
          ],
        }),
    });

    render(<HermesChatPanel />);

    await waitFor(() => {
      expect(screen.getByText('what is broken?')).toBeDefined();
      expect(screen.getByText('Let me check your services.')).toBeDefined();
    });
    // The empty state must NOT show once history is present.
    expect(screen.queryByText(/Maintenance assistant/i)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/hermes/chat',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('falls back to the empty state when the history GET 503s', async () => {
    mockFetch({ get: () => jsonResponse(503, { error: 'Hermes is unavailable.' }) });
    render(<HermesChatPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Maintenance assistant/i)).toBeDefined();
    });
    expect(screen.queryByTestId('hermes-msg-assistant')).toBeNull();
  });

  it('sends a message to /api/system/hermes/chat and renders the reply', async () => {
    const fetchMock = mockFetch({ post: () => jsonResponse(200, { reply: 'Here is your plan.' }) });

    render(<HermesChatPanel />);
    // Wait for the mount history load to settle (empty) before sending.
    await waitFor(() => expect(screen.getByText(/Maintenance assistant/i)).toBeDefined());
    const input = screen.getByTestId('hermes-input');
    fireEvent.change(input, { target: { value: 'help me' } });
    fireEvent.click(screen.getByTestId('hermes-send'));

    // The operator's turn renders immediately.
    expect(screen.getByText('help me')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText('Here is your plan.')).toBeDefined();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/hermes/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ input: 'help me' }),
      }),
    );
  });

  it('shows the "Hermes is unavailable" notice on a 503 and does not append an assistant turn', async () => {
    // History loads empty; the send POST 503s.
    mockFetch({
      post: () =>
        jsonResponse(503, { error: 'Hermes is unavailable. Is the Hermes service running?' }),
    });

    render(<HermesChatPanel />);
    await waitFor(() => expect(screen.getByText(/Maintenance assistant/i)).toBeDefined());
    fireEvent.change(screen.getByTestId('hermes-input'), { target: { value: 'are you there?' } });
    fireEvent.click(screen.getByTestId('hermes-send'));

    await waitFor(() => {
      const notice = screen.getByTestId('hermes-unavailable');
      expect(notice.textContent).toMatch(/Hermes is unavailable/i);
    });
    // The 503 path must not fabricate an assistant reply (don't mask failures).
    expect(screen.queryByTestId('hermes-msg-assistant')).toBeNull();
  });

  it('shows a typing indicator while the reply is in flight', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      // Mount history GET resolves immediately (empty); the send POST hangs
      // until we resolve it, so the typing indicator can be observed.
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse(200, { messages: [] });
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });

    render(<HermesChatPanel />);
    await waitFor(() => expect(screen.getByText(/Maintenance assistant/i)).toBeDefined());
    fireEvent.change(screen.getByTestId('hermes-input'), { target: { value: 'slow one' } });
    fireEvent.click(screen.getByTestId('hermes-send'));

    await waitFor(() => {
      expect(screen.getByTestId('hermes-typing')).toBeDefined();
    });

    resolveFetch(jsonResponse(200, { reply: 'done' }));
    await waitFor(() => {
      expect(screen.queryByTestId('hermes-typing')).toBeNull();
    });
    expect(screen.getByText('done')).toBeDefined();
  });
});
