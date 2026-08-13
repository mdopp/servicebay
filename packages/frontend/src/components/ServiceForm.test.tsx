/**
 * ServiceForm — rename modal Escape-to-close (#2188).
 *
 * The rename-service modal now closes on Escape like every other modal in
 * the app (ConfirmModal etc.), via the shared `useEscapeKey` hook. These
 * tests assert Escape dismisses the modal, guarded so it can't dismiss
 * while a rename request is in flight.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const toastMocks = vi.hoisted(() => ({ addToast: vi.fn(), updateToast: vi.fn() }));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => toastMocks,
}));
vi.mock('@/app/actions/system', () => ({ getNodes: () => Promise.resolve([]) }));
// Keep the history panel out of the render.
vi.mock('./HistoryViewer', () => ({ __esModule: true, default: () => <div /> }));

import ServiceForm from './ServiceForm';

function openRenameModal() {
  render(
    <ServiceForm
      isEdit
      initialData={{
        name: 'my-service',
        yamlFileName: 'my-service.yml',
        kubeContent: '',
        yamlContent: '',
      }}
    />,
  );
  fireEvent.click(screen.getByTitle('Rename Service & Files'));
  return screen.getByRole('heading', { name: /rename service/i });
}

describe('ServiceForm — rename modal Escape-to-close (#2188)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('closes the rename modal when Escape is pressed', async () => {
    openRenameModal();
    expect(screen.getByRole('heading', { name: /rename service/i })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /rename service/i })).toBeNull(),
    );
  });

  it('does not close the modal while a rename request is in flight', async () => {
    // A rename POST that never resolves — keeps isRenaming latched true.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    openRenameModal();
    // Trigger the rename (button enabled once newServiceName is set, which the
    // open-handler seeds with the current name).
    fireEvent.click(screen.getByRole('button', { name: 'Rename Service' }));

    await waitFor(() => expect(screen.getByText('Renaming...')).toBeTruthy());

    // Escape must be ignored while the request is in flight.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: /rename service/i })).toBeTruthy();
  });
});

/**
 * "Re-render from template" — #2537. The route now names any variable it could
 * not resolve instead of handing back quietly-blank YAML; the operator only
 * benefits if the form SAYS so, because the blanked line is exactly what
 * scrolls off screen in the diff they are reviewing.
 */
describe('ServiceForm — re-render reports unresolved values (#2537)', () => {
  function renderForm() {
    render(
      <ServiceForm
        isEdit
        initialData={{
          name: 'my-service',
          yamlFileName: 'my-service.yml',
          kubeContent: '',
          yamlContent: '',
        }}
      />,
    );
  }

  function stubPreview(payload: unknown, ok = true, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('reconfigure-preview')) {
        return { ok, status, json: async () => payload } as unknown as Response;
      }
      // The editor revalidates the YAML it was handed — irrelevant here.
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }));
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    toastMocks.addToast.mockClear();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('warns, naming each variable that rendered empty', async () => {
    stubPreview({ yamlContent: 'kind: Pod\n', unresolved: ['HASS_TOKEN'] });
    renderForm();

    fireEvent.click(screen.getByTitle(/Re-render this YAML/i));

    await waitFor(() => expect(toastMocks.addToast).toHaveBeenCalled());
    const [type, title, message] = toastMocks.addToast.mock.calls.at(-1) as string[];
    expect(type).toBe('warning');
    expect(title).toMatch(/empty/i);
    expect(message).toContain('HASS_TOKEN');
  });

  it('reports plain success when everything resolved', async () => {
    stubPreview({ yamlContent: 'kind: Pod\n', unresolved: [] });
    renderForm();

    fireEvent.click(screen.getByTitle(/Re-render this YAML/i));

    await waitFor(() => expect(toastMocks.addToast).toHaveBeenCalled());
    expect((toastMocks.addToast.mock.calls.at(-1) as string[])[0]).toBe('success');
  });

  it('surfaces the server refusal when a secret could not be recovered', async () => {
    stubPreview(
      { error: 'Refusing to re-render: the stored value for LLDAP_ADMIN_PASSWORD ...' },
      false,
      400,
    );
    renderForm();

    fireEvent.click(screen.getByTitle(/Re-render this YAML/i));

    await waitFor(() => expect(toastMocks.addToast).toHaveBeenCalled());
    const [type, , message] = toastMocks.addToast.mock.calls.at(-1) as string[];
    expect(type).toBe('error');
    expect(message).toContain('LLDAP_ADMIN_PASSWORD');
  });
});
