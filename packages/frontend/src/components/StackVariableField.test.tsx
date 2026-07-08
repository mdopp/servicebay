/**
 * StackVariableField — secret regenerate feedback (#2186).
 *
 * The 'Regenerate' button on a `secret` variable now shows an in-flight
 * affordance (disabled + spinner) and surfaces a visible error on failure
 * instead of failing silently. These tests assert:
 *   - the button disables while the /api/install/generate-secret POST is in
 *     flight (and a second click is a no-op — no double-fire),
 *   - a successful response updates the value,
 *   - a failed request surfaces a visible inline error, and the field stays
 *     typeable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import StackVariableField from './StackVariableField';

const secretVar = {
  name: 'API_SECRET',
  value: 'old-secret',
  meta: { type: 'secret' as const },
};

describe('StackVariableField — secret regenerate feedback (#2186)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables the regenerate button while the request is in flight and guards a double-click', async () => {
    let release: (r: Response) => void = () => {};
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }),
    );

    const onChange = vi.fn();
    render(<StackVariableField variable={secretVar} onChange={onChange} />);

    const btn = screen.getByTitle('Regenerate') as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => expect(btn.disabled).toBe(true));
    // A second click while pending must not fire another request.
    fireEvent.click(btn);
    expect(calls).toBe(1);

    release(new Response(JSON.stringify({ secret: 'fresh-secret' }), { status: 200 }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('fresh-secret'));
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it('surfaces a visible error when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))),
    );

    const onChange = vi.fn();
    render(<StackVariableField variable={secretVar} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Regenerate'));

    // Visible inline error, no silent failure; value not changed.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    // Field is still typeable after the failure.
    const input = screen.getByDisplayValue('old-secret');
    fireEvent.change(input, { target: { value: 'manual' } });
    expect(onChange).toHaveBeenCalledWith('manual');
  });
});
