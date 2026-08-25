import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import type { OperateLoadState } from '../../../settings/services/_lib/useOperateServices';

// #2077 regression guard: the per-service Operate page MUST own a scroll region,
// because the dashboard <main> (app/(dashboard)/layout.tsx) is overflow-hidden.
// Without it, an overlong tab (the operator hit it on Settings) clips at the
// bottom with no scrollbar. We assert the rendered page root carries the
// canonical PageScroll chain (min-h-0 + overflow-y-auto) — the exact classes
// that the load-bearing fix depends on.
//
// #2391: the summary's "Logs" quick action must reach a real log view from
// whichever tab it is clicked on, and `?drawer=logs` must do the same on arrival
// from another page.

const params = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({
  useSearchParams: () => params.current,
}));

const operate = {
  current: { service: null as ServiceViewModel | null, state: 'loading' as OperateLoadState },
};
vi.mock('../../../settings/services/_lib/useOperateServices', () => ({
  useOperateService: () => operate.current,
}));

vi.mock('../../../settings/services/_lib/OperateHealthTab', () => ({ default: () => <div>health-tab</div> }));
vi.mock('../../../settings/services/_lib/OperateSettingsTab', () => ({ default: () => <div>settings-tab</div> }));
vi.mock('../../../settings/services/_lib/OperateActionsTab', () => ({ default: () => <div>actions-tab</div> }));

vi.mock('@/components/serviceDetail/ServiceDetailSummary', () => ({
  default: ({ onShowLogs }: { onShowLogs?: () => void }) => (
    <button onClick={onShowLogs}>quick-logs</button>
  ),
}));

const containersTabProps = vi.fn();
vi.mock('./OperateContainersTab', () => ({
  default: (props: Record<string, unknown>) => {
    containersTabProps(props);
    return <div>containers-tab</div>;
  },
}));

import OperatePage from './OperatePage';

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    name: 'immich.service',
    displayName: 'Immich',
    yamlBasename: null,
    kubeBasename: null,
    active: true,
    type: 'kube',
    ports: [],
    ...over,
  };
}

beforeEach(() => {
  params.current = new URLSearchParams();
  operate.current = { service: null, state: 'loading' };
  containersTabProps.mockClear();
});

describe('OperatePage scroll container (#2077)', () => {
  it('renders a single canonical scroll region (min-h-0 + overflow-y-auto)', () => {
    const { container } = render(<OperatePage name="immich" />);
    const scrollers = Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
      el =>
        el.className.includes('min-h-0') &&
        el.className.includes('overflow-y-auto'),
    );
    expect(scrollers.length).toBeGreaterThanOrEqual(1);
    // and it fills the shell so it can scroll inside the overflow-hidden <main>
    expect(scrollers[0].className).toContain('h-full');
  });
});

// #2629: "still loading", "loaded and genuinely absent" and "couldn't load"
// are three different claims. The page may only render the definite negative
// ("was not found") in the middle one.
describe('OperatePage load states (#2629)', () => {
  it('shows the spinner and NOT "was not found" while the twin snapshot is still on its way', () => {
    operate.current = { service: null, state: 'loading' };
    render(<OperatePage name="immich" />);

    expect(screen.getByText(/Loading service/)).toBeDefined();
    expect(screen.queryByText(/was not found/)).toBeNull();
  });

  it('claims "not found" only once a synced snapshot really lacks the service', () => {
    operate.current = { service: null, state: 'ready' };
    render(<OperatePage name="immich" />);

    expect(screen.getByText(/was not found/)).toBeDefined();
    expect(screen.queryByText(/Loading service/)).toBeNull();
  });

  it('reports a failed load as unreachable, not as a missing service', () => {
    operate.current = { service: null, state: 'unavailable' };
    render(<OperatePage name="immich" />);

    expect(screen.getByText(/Can.t reach ServiceBay/)).toBeDefined();
    expect(screen.queryByText(/was not found/)).toBeNull();
    expect(screen.queryByText(/Loading service/)).toBeNull();
  });
});

describe('OperatePage Logs quick action (#2391)', () => {
  it('switches to the Containers tab and asks it for the log drawer, from the default tab', () => {
    operate.current = { service: svc(), state: 'ready' };
    render(<OperatePage name="immich" />);

    // starts on Health, no drawer requested
    expect(screen.getByText('health-tab')).toBeDefined();
    expect(containersTabProps).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('quick-logs'));

    expect(screen.getByText('containers-tab')).toBeDefined();
    expect(containersTabProps.mock.calls.at(-1)![0].initialDrawer).toEqual({
      containerId: undefined,
      mode: 'logs',
      nonce: 1,
    });
  });

  it('works from a non-default tab too (the old ?tab=health link was a same-page no-op)', () => {
    params.current = new URLSearchParams('tab=actions');
    operate.current = { service: svc(), state: 'ready' };
    render(<OperatePage name="immich" />);
    expect(screen.getByText('actions-tab')).toBeDefined();

    fireEvent.click(screen.getByText('quick-logs'));
    expect(screen.getByText('containers-tab')).toBeDefined();
    expect(containersTabProps.mock.calls.at(-1)![0].initialDrawer).toMatchObject({ mode: 'logs' });
  });

  it('re-fires with a fresh nonce so a second click re-opens a closed drawer', () => {
    operate.current = { service: svc(), state: 'ready' };
    render(<OperatePage name="immich" />);

    fireEvent.click(screen.getByText('quick-logs'));
    fireEvent.click(screen.getByText('quick-logs'));
    expect(containersTabProps.mock.calls.at(-1)![0].initialDrawer).toMatchObject({ nonce: 2 });
  });

  it('honours a ?drawer=logs&container= deep link on arrival from another page', () => {
    params.current = new URLSearchParams('tab=containers&drawer=logs&container=abc123');
    operate.current = { service: svc(), state: 'ready' };
    render(<OperatePage name="immich" />);

    expect(containersTabProps.mock.calls.at(-1)![0].initialDrawer).toEqual({
      containerId: 'abc123',
      mode: 'logs',
      nonce: 1,
    });
  });
});
