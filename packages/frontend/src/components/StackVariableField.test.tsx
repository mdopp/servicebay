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

// #2577 — the regenerate button must mint the SAME shape the install path
// generates for a device-facing variable. Without this the operator can
// regenerate their way back into a value the device truncates, and the
// symptom (a device claiming the credentials are wrong) points nowhere near
// this button. The length policy stays server-side; the browser only forwards
// the declaration.
describe('StackVariableField — device-safe regenerate (#2577)', () => {
  type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
  const stubFetch = (secret: string): FetchMock => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(JSON.stringify({ secret }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const fetchBody = (fetchMock: FetchMock) =>
    JSON.parse(String(fetchMock.mock.calls[0][1].body));

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the device-safe profile when the variable declares it', async () => {
    const fetchMock = stubFetch('short');

    render(
      <StackVariableField
        variable={{ name: 'MQTT_PASSWORD', value: 'old', meta: { type: 'secret', deviceSafe: true } }}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Regenerate'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/install/generate-secret');
    expect(fetchBody(fetchMock)).toEqual({ deviceSafe: true });
  });

  it('leaves an ordinary secret on the default profile', async () => {
    const fetchMock = stubFetch('long');

    render(<StackVariableField variable={secretVar} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Regenerate'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchBody(fetchMock)).toEqual({});
  });

  it('hides Regenerate on a mintApiToken variable, but keeps the field typeable (#2673)', () => {
    // `/api/install/generate-secret` returns a RANDOM string. On a variable
    // that holds a real ServiceBay API token, one click would swap a working
    // credential for one that authenticates as nothing — silently. The field
    // itself stays editable so an operator can still paste their own token.
    const onChange = vi.fn();
    render(
      <StackVariableField
        variable={{ name: 'SERVICEBAY_MCP_TOKEN', value: 'sb_a_b', meta: { type: 'secret', mintApiToken: true } }}
        onChange={onChange}
      />,
    );

    expect(screen.queryByTitle('Regenerate')).toBeNull();
    fireEvent.change(screen.getByDisplayValue('sb_a_b'), { target: { value: 'sb_c_d' } });
    expect(onChange).toHaveBeenCalledWith('sb_c_d');
  });
});
