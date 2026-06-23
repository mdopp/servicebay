import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import SetupPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
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
