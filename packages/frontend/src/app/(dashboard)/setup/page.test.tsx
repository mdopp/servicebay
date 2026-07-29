import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import SetupPage from './page';
import { completeStackSetup } from '@/app/actions/onboarding';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('@/app/actions/onboarding', () => ({ completeStackSetup: vi.fn(async () => undefined) }));
vi.mock('@/components/DoneStepDnsCheck', () => ({ DoneStepDnsCheck: () => <div>dns</div> }));
vi.mock('@/components/DiagnoseProbeList', () => ({ default: () => <div>probes</div> }));

function jobResponse(over: Record<string, unknown> = {}) {
  return {
    job: {
      id: 'job-1',
      phase: 'done',
      progress: { deployedNames: ['immich'], totalCount: 1, currentItem: null },
      input: { items: [{ name: 'immich', checked: true, alreadyInstalled: false }], variables: [] },
      credentialsManifest: [],
      error: null,
      ...over,
    },
    logs: 'line one\nline two',
    logsOffset: 12,
  };
}

describe('SetupPage — design-system tokens (#2100)', () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    vi.mocked(completeStackSetup).mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      if (String(u).includes('/api/install/status')) {
        return new Response(JSON.stringify(jobResponse()), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ probes: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the running install view with token surfaces, no raw gray/rose/emerald literals', async () => {
    const { container } = render(<SetupPage />);
    await waitFor(() => expect(screen.getByText('Install in progress')).toBeTruthy());
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface|status-/);
    expect(html).toMatch(/border-border|border-status-/);
    expect(html).not.toMatch(/bg-white|dark:bg-(gray|slate)|border-(gray|slate|rose|emerald|red)-\d|text-(gray|slate|rose|emerald)-\d/);
  });

  it('surfaces the service-status strip and install log (function preserved)', async () => {
    render(<SetupPage />);
    await waitFor(() => expect(screen.getByText('Service status')).toBeTruthy());
    expect(screen.getByText('Install log')).toBeTruthy();
    expect(screen.getByText('1/1 deployed')).toBeTruthy();
  });
});

/**
 * #2460 — a throwing completeStackSetup() used to stop the Finish spinner via
 * `finally` and do nothing else: no error, no navigation, no way for the
 * operator to tell whether setup completed.
 */
describe('SetupPage — Finish failure is visible (#2460)', () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    vi.mocked(completeStackSetup).mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      if (String(u).includes('/api/install/status')) {
        return new Response(JSON.stringify(jobResponse()), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ probes: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows an error alert and does not navigate when completeStackSetup throws', async () => {
    vi.mocked(completeStackSetup).mockRejectedValue(new Error('config write failed'));
    render(<SetupPage />);
    const finish = await waitFor(() => screen.getByRole('button', { name: /Finish/i }));
    fireEvent.click(finish);

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/Couldn't finish setup/i);
    expect(alert.textContent).toMatch(/config write failed/);
    expect(alert.textContent).toMatch(/still pending/i);
    // The spinner stopped, but not silently: no navigation happened and the
    // button is clickable again for a retry.
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect((finish as HTMLButtonElement).disabled).toBe(false);
  });

  it('navigates with no error banner when Finish succeeds', async () => {
    render(<SetupPage />);
    const finish = await waitFor(() => screen.getByRole('button', { name: /Finish/i }));
    fireEvent.click(finish);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/services'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
