/**
 * The first-run wizard reads its status from the ROUTE, not a server action
 * (#2745).
 *
 * `OnboardingWizard.test.tsx` mocks the api-client so it can drive the wizard's
 * many branches; that proves the wizard's logic but says nothing about the
 * wire. This spec goes the other way: the api-client is REAL and only `fetch`
 * is stubbed, so a mounted wizard has to actually issue
 * `GET /api/system/onboarding` and parse the envelope before it will open.
 *
 * Everything past the open (stack picking, install) is covered next door — the
 * point here is the seam that replaced `app/actions/onboarding.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import OnboardingWizardView from '@/components/OnboardingWizard';
import { InstallJobProvider } from '@/providers/InstallJobProvider';

vi.mock('@/app/actions', () => ({
  fetchTemplates: vi.fn(async () => []),
  fetchReadme: vi.fn(async () => ''),
  fetchTemplateYaml: vi.fn(async () => ''),
  fetchTemplateVariables: vi.fn(async () => ({})),
}));
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/hooks/useDigitalTwin', () => ({ useDigitalTwin: () => ({ data: null }) }));
vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: true }, isConnected: true }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const NEEDS_SETUP = {
  needsSetup: true,
  stackSetupPending: false,
  hasGateway: false,
  hasSshKey: false,
  hasExternalLinks: false,
  installInProgress: null,
  features: { gateway: false, ssh: false, updates: false, registries: false, email: false, auth: false },
};

let calls: string[];

const Wizard = () => (
  <InstallJobProvider>
    <OnboardingWizardView />
  </InstallJobProvider>
);

beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);

    const body = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });

    if (url.startsWith('/api/system/onboarding')) return body({ ok: true, data: NEEDS_SETUP });
    if (url.startsWith('/api/system/nodes')) return body({ ok: true, data: [] });
    if (url.includes('/api/install/status')) return body({ job: null, logs: '', logsOffset: 0 });
    if (url.includes('/api/settings')) return body({ templateSettings: {} });
    return body({ ok: true, data: {} });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

describe('OnboardingWizard → /api/system/onboarding (#2745)', () => {
  it('asks the route for its status on mount', async () => {
    render(<Wizard />);
    await waitFor(() => expect(calls).toContain('GET /api/system/onboarding'));
  });

  it('opens on a needsSetup status parsed out of the route envelope', async () => {
    render(<Wizard />);
    await waitFor(() => expect(screen.getByText(/Welcome to ServiceBay/i)).toBeDefined());
  });
});
