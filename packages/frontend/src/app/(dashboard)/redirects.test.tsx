import { describe, it, expect, vi, beforeEach } from 'vitest';

// IA redesign slice 2 (#2030/#1950) + Home restore: `/` now RENDERS the lean
// Home overview (it no longer redirects to /services). `/health` still folds
// into `/status` (carrying its tab query so deep links survive).
//
// We assert the redirect TARGET via a spy rather than the thrown control-flow:
// Next's real redirect() throws to unwind, but the unit under test is purely
// "which path do we send the operator to", so the spy call is the contract.
const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect }));

beforeEach(() => redirect.mockClear());

describe('root page → renders Home (no redirect)', () => {
  it('does not redirect / — it renders the Home overview', async () => {
    const { default: HomePage } = await import('./page');
    expect(typeof HomePage).toBe('function');
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('/health → /status (Diagnostics folds into Status)', () => {
  it('redirects /health to /status with no query', async () => {
    const { default: HealthPage } = await import('./health/page');
    await HealthPage({ searchParams: Promise.resolve({}) });
    expect(redirect).toHaveBeenCalledWith('/status');
  });

  it('carries the tab query so /health?tab=containers lands on box-wide containers', async () => {
    const { default: HealthPage } = await import('./health/page');
    await HealthPage({ searchParams: Promise.resolve({ tab: 'containers' }) });
    expect(redirect).toHaveBeenCalledWith('/status?tab=containers');
  });

  it('preserves additional params (e.g. a selected containerId from the network map)', async () => {
    const { default: HealthPage } = await import('./health/page');
    await HealthPage({ searchParams: Promise.resolve({ tab: 'containers', containerId: 'abc123' }) });
    const target = redirect.mock.calls.at(-1)![0] as string;
    expect(target.startsWith('/status?')).toBe(true);
    expect(target).toContain('tab=containers');
    expect(target).toContain('containerId=abc123');
  });
});
