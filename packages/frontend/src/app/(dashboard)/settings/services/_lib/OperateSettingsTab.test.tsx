/**
 * OperateSettingsTab migration (#2078) — config sections wrapped in <Card> with
 * a <SectionHeading>. The non-editable branch (non-kube service) is the cheapest
 * deterministic render and locks the Card surface + token text (no dashed
 * gray-border literal).
 *
 * Plus #2392: the Target Node the embedded ServiceForm is seeded with must be
 * the service's real node — including the single-node 'Local' case, which used
 * to be deliberately blanked and left the field permanently empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import OperateSettingsTab from './OperateSettingsTab';

vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

const serviceFormProps = vi.fn();
vi.mock('@/components/ServiceForm', () => ({
  default: (props: Record<string, unknown>) => {
    serviceFormProps(props);
    return null;
  },
}));

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    name: 'pihole.service',
    displayName: 'Pi-hole',
    yamlBasename: null,
    kubeBasename: null,
    active: true,
    type: 'container',
    ports: [],
    ...over,
  };
}

describe('OperateSettingsTab (#2078 migration)', () => {
  it('renders the non-editable notice on a token-styled Card (no dashed gray literal)', () => {
    const { container } = render(<OperateSettingsTab service={svc({ type: 'container' })} />);
    expect(screen.getByText(/not managed via a Quadlet kube manifest/)).toBeDefined();
    expect(container.innerHTML).not.toContain('border-dashed');
    expect(container.innerHTML).not.toContain('text-gray-600');
  });
});

describe('OperateSettingsTab Target Node (#2392)', () => {
  beforeEach(() => {
    serviceFormProps.mockClear();
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ kubeContent: 'k', yamlContent: 'y' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('seeds the form with "Local" on a single-node box instead of a blank node', async () => {
    render(<OperateSettingsTab service={svc({ type: 'kube', nodeName: 'Local' })} />);
    await waitFor(() => expect(serviceFormProps).toHaveBeenCalled());
    expect(serviceFormProps.mock.calls.at(-1)![0].defaultNode).toBe('Local');
  });

  it('falls back to "Local" when the service carries no nodeName at all', async () => {
    render(<OperateSettingsTab service={svc({ type: 'kube' })} />);
    await waitFor(() => expect(serviceFormProps).toHaveBeenCalled());
    expect(serviceFormProps.mock.calls.at(-1)![0].defaultNode).toBe('Local');
  });

  it('shows the real node name on a multi-node box', async () => {
    render(<OperateSettingsTab service={svc({ type: 'kube', nodeName: 'nas01' })} />);
    await waitFor(() => expect(serviceFormProps).toHaveBeenCalled());
    expect(serviceFormProps.mock.calls.at(-1)![0].defaultNode).toBe('nas01');
  });
});
