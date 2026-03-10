/* eslint-disable @typescript-eslint/no-explicit-any */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OnboardingWizard from '../../src/components/OnboardingWizard';

// 1. Mock Server Actions
vi.mock('@/app/actions/onboarding', () => ({
  checkOnboardingStatus: vi.fn(),
  skipOnboarding: vi.fn(),
  saveGatewayConfig: vi.fn(),
  saveAutoUpdateConfig: vi.fn(),
  saveRegistriesConfig: vi.fn(),
  saveEmailConfig: vi.fn(),
  completeStackSetup: vi.fn(),
}));

import { checkOnboardingStatus, saveGatewayConfig, completeStackSetup } from '@/app/actions/onboarding';

// Mock template/registry actions
vi.mock('@/app/actions', () => ({
  fetchTemplates: vi.fn(),
  fetchReadme: vi.fn(),
  fetchTemplateYaml: vi.fn(),
  fetchTemplateVariables: vi.fn(),
}));

import { fetchTemplates, fetchReadme, fetchTemplateYaml, fetchTemplateVariables } from '@/app/actions';

// Mock system actions
vi.mock('@/app/actions/system', () => ({
  getNodes: vi.fn(),
}));

import { getNodes } from '@/app/actions/system';

// Mock SSH action
vi.mock('@/app/actions/ssh', () => ({
  generateLocalKey: vi.fn(),
}));

// 2. Mock Toast Provider
const mockAddToast = vi.fn();
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: mockAddToast })
}));

// 3. Mock Navigation
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh })
}));

// 4. Mock Mustache
vi.mock('mustache', () => ({
  default: {
    render: (template: string, view: Record<string, string>) => {
      let result = template;
      for (const [key, val] of Object.entries(view)) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), val);
      }
      return result;
    },
    escape: (text: string) => text,
  },
}));

// Helper: default status with no setup needed
const completedStatus = {
  needsSetup: false,
  stackSetupPending: false,
  hasGateway: true,
  hasSshKey: true,
  hasExternalLinks: false,
  features: { gateway: true, ssh: true, updates: true, registries: true, email: false, auth: true },
};

// Helper: status requiring full setup
const needsSetupStatus = {
  needsSetup: true,
  stackSetupPending: false,
  hasGateway: false,
  hasSshKey: false,
  hasExternalLinks: false,
  features: { gateway: false, ssh: false, updates: false, registries: false, email: false, auth: false },
};

// Helper: status with only stacks pending (post-install first boot)
const stacksPendingStatus = {
  needsSetup: false,
  stackSetupPending: true,
  hasGateway: true,
  hasSshKey: true,
  hasExternalLinks: false,
  features: { gateway: true, ssh: true, updates: true, registries: true, email: false, auth: true },
};

const mockStacks = [
  { name: 'full-stack', path: '/stacks/full-stack', url: '', type: 'stack' as const, source: 'Built-in' },
  { name: 'web-stack', path: '/stacks/web-stack', url: '', type: 'stack' as const, source: 'Built-in' },
];

const mockStackReadme = `# Full Stack\n\n## Included Services\n\n- [x] nginx-web\n- [x] redis-cache\n- [ ] immich\n`;

const mockNodes = [{ Name: 'Local', URI: 'unix:///run/podman/podman.sock', Identity: '', Default: true }];

describe('OnboardingWizard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (getNodes as any).mockResolvedValue(mockNodes);
        (fetchTemplates as any).mockResolvedValue(mockStacks);
        (fetchReadme as any).mockResolvedValue(mockStackReadme);
        (fetchTemplateYaml as any).mockResolvedValue('apiVersion: v1\nkind: Pod\nmetadata:\n  name: {{SERVICE_NAME}}');
        (fetchTemplateVariables as any).mockResolvedValue({
            SERVICE_NAME: { type: 'text', default: 'my-service', description: 'Service name' },
        });
        // Mock fetch for /api/settings, /api/services, /api/system/nginx/status
        global.fetch = vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
            if (url.includes('/api/settings')) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ templateSettings: {} }) });
            }
            if (url.includes('/api/services') && (!opts || opts.method !== 'POST')) {
                // GET: return existing services (nginx-web already installed)
                return Promise.resolve({ ok: true, json: () => Promise.resolve([
                    { name: 'nginx-web', active: true, status: 'running' },
                ]) });
            }
            if (url.includes('/api/services') && opts?.method === 'POST') {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
            }
            if (url.includes('/api/system/nginx/status')) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ installed: true, active: true }) });
            }
            if (url.includes('/api/system/nginx/proxy-hosts')) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ created: ['test.example.com'] }) });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        });
    });

    // ---- Existing tests ----

    it('does not render if onboarding is complete', async () => {
        (checkOnboardingStatus as any).mockResolvedValue(completedStatus);

        render(<OnboardingWizard />);

        await waitFor(() => {
            expect(screen.queryByText(/Welcome to ServiceBay/i)).toBeNull();
            expect(screen.queryByText(/Install Services/i)).toBeNull();
        });
    });

    it('renders welcome screen if setup is needed', async () => {
        (checkOnboardingStatus as any).mockResolvedValue(needsSetupStatus);

        render(<OnboardingWizard />);

        await waitFor(() => {
            expect(screen.getByText(/Welcome to ServiceBay/i)).toBeDefined();
        });
    });

    it('navigates to first selected step', async () => {
        (checkOnboardingStatus as any).mockResolvedValue(needsSetupStatus);

        render(<OnboardingWizard />);

        await waitFor(() => screen.getByRole('button', { name: /Next/i }));
        fireEvent.click(screen.getByRole('button', { name: /Next/i }));

        await waitFor(() => {
            expect(screen.getAllByText(/Internet Gateway/i).length).toBeGreaterThan(0);
            expect(screen.getByPlaceholderText('fritz.box')).toBeDefined();
        });
    });

    it('submits gateway config', async () => {
        (checkOnboardingStatus as any).mockResolvedValue(needsSetupStatus);

        render(<OnboardingWizard />);
        await waitFor(() => screen.getByRole('button', { name: /Next/i }));
        fireEvent.click(screen.getByRole('button', { name: /Next/i }));

        await waitFor(() => screen.getByPlaceholderText('fritz.box'));
        const hostInput = screen.getByPlaceholderText('fritz.box');
        fireEvent.change(hostInput, { target: { value: '192.168.1.1' } });

        const saveBtn = screen.getByRole('button', { name: /Save & Next/i });
        fireEvent.click(saveBtn);

        await waitFor(() => {
            expect(saveGatewayConfig).toHaveBeenCalledWith('192.168.1.1', '', '');
        });
    });

    // ---- Stacks-only mode (post-install first boot) ----

    describe('stacks-only mode (stackSetupPending)', () => {
        it('opens directly to stacks step with correct header', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => {
                // Header h2 contains "Install Services"
                expect(screen.getAllByText(/Install Services/i).length).toBeGreaterThan(0);
                expect(screen.getByText(/Choose a service stack/i)).toBeDefined();
            });
            // Should NOT show the full setup welcome
            expect(screen.queryByText(/Welcome to ServiceBay/i)).toBeNull();
        });

        it('does not show progress bar in stacks-only mode', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => screen.getByText(/Choose a service stack/i));
            // Progress bar shows "Step X of Y" — should not be present
            expect(screen.queryByText(/Step \d+ of \d+/)).toBeNull();
        });

        it('loads and displays available stacks', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => {
                expect(screen.getByText('full-stack')).toBeDefined();
                expect(screen.getByText('web-stack')).toBeDefined();
            });
            expect(fetchTemplates).toHaveBeenCalled();
        });

        it('shows skip button on stack selection', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => {
                expect(screen.getByRole('button', { name: /Skip/i })).toBeDefined();
            });
        });

        it('skip calls completeStackSetup and closes wizard', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);
            (completeStackSetup as any).mockResolvedValue(undefined);

            render(<OnboardingWizard />);

            await waitFor(() => screen.getByRole('button', { name: /Skip/i }));
            fireEvent.click(screen.getByRole('button', { name: /Skip/i }));

            await waitFor(() => {
                expect(completeStackSetup).toHaveBeenCalled();
            });
        });

        it('selecting a stack shows service checkboxes', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            await waitFor(() => {
                expect(screen.getByText('nginx-web')).toBeDefined();
                expect(screen.getByText('redis-cache')).toBeDefined();
                expect(screen.getByText('immich')).toBeDefined();
            });
        });

        it('marks already-installed services and unchecks them', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            await waitFor(() => screen.getByText('nginx-web'));

            // nginx-web is already installed (from mock /api/services GET) — unchecked + disabled
            // redis-cache is not installed but marked [x] in README — checked
            // immich is not installed and marked [ ] — unchecked
            const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
            expect(checkboxes[0].checked).toBe(false);   // nginx-web — already installed, unchecked
            expect(checkboxes[0].disabled).toBe(true);    // nginx-web — disabled
            expect(checkboxes[1].checked).toBe(true);     // redis-cache [x]
            expect(checkboxes[2].checked).toBe(false);    // immich [ ]

            // Should show "already installed" badge
            expect(screen.getByText('already installed')).toBeDefined();
        });

        it('back from services returns to stack selection', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            await waitFor(() => screen.getByText('nginx-web'));

            // Click back button
            fireEvent.click(screen.getByRole('button', { name: /Back/i }));

            await waitFor(() => {
                expect(screen.getByText('full-stack')).toBeDefined();
                expect(screen.getByText('web-stack')).toBeDefined();
            });
        });

        it('continue from services fetches variables and shows configure step', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            await waitFor(() => screen.getByRole('button', { name: /Continue/i }));
            fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

            await waitFor(() => {
                expect(fetchTemplateYaml).toHaveBeenCalled();
                expect(fetchTemplateVariables).toHaveBeenCalled();
                // Should show variable input
                expect(screen.getByText('SERVICE_NAME')).toBeDefined();
            });
        });

        it('install deploys services via API and shows done state', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            // Select stack
            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            // Continue to configure
            await waitFor(() => screen.getByRole('button', { name: /Continue/i }));
            fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

            // Wait for configure step, then install
            await waitFor(() => screen.getByRole('button', { name: /Install Stack/i }));
            fireEvent.click(screen.getByRole('button', { name: /Install Stack/i }));

            // Should show install logs and done state
            await waitFor(() => {
                expect(screen.getByText(/installation complete/i)).toBeDefined();
            });

            // Should have called the services API for each checked service
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/api/services'),
                expect.objectContaining({ method: 'POST' })
            );
        });

        it('finish after install calls completeStackSetup', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);
            (completeStackSetup as any).mockResolvedValue(undefined);

            render(<OnboardingWizard />);

            // Select stack → services → configure → install → done
            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            await waitFor(() => screen.getByRole('button', { name: /Continue/i }));
            fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

            await waitFor(() => screen.getByRole('button', { name: /Install Stack/i }));
            fireEvent.click(screen.getByRole('button', { name: /Install Stack/i }));

            await waitFor(() => screen.getByRole('button', { name: /Finish/i }));
            fireEvent.click(screen.getByRole('button', { name: /Finish/i }));

            await waitFor(() => {
                expect(completeStackSetup).toHaveBeenCalled();
            });
        });

        it('shows empty state when no stacks available', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);
            (fetchTemplates as any).mockResolvedValue([]);

            render(<OnboardingWizard />);

            await waitFor(() => {
                expect(screen.getByText(/No stacks available/i)).toBeDefined();
            });
        });

        it('shows domain prompt on services step', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);

            render(<OnboardingWizard />);

            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            await waitFor(() => {
                expect(screen.getByText(/Public Domain/i)).toBeDefined();
                expect(screen.getByPlaceholderText('example.com')).toBeDefined();
            });
        });

        it('shows post-install DNS and SSL steps after stack install', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);
            // Return variables with subdomain type
            (fetchTemplateVariables as any).mockResolvedValue({
                SERVICE_NAME: { type: 'text', default: 'my-service' },
                PUBLIC_DOMAIN: { type: 'text', default: 'example.com' },
                TEST_SUBDOMAIN: { type: 'subdomain', default: 'test', proxyPort: '8080' },
            });

            render(<OnboardingWizard />);

            // Select stack → services → configure → install → done
            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            await waitFor(() => screen.getByRole('button', { name: /Continue/i }));
            fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

            await waitFor(() => screen.getByRole('button', { name: /Install Stack/i }));
            fireEvent.click(screen.getByRole('button', { name: /Install Stack/i }));

            await waitFor(() => {
                // Should show DNS instructions
                expect(screen.getByText(/1\. Configure DNS/i)).toBeDefined();
                // Should show SSL instructions
                expect(screen.getByText(/2\. SSL Certificates/i)).toBeDefined();
                // Should show access restrictions
                expect(screen.getByText(/3\. Access Restrictions/i)).toBeDefined();
            });
        });

        it('shows NPM credential prompt when proxy auth fails', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);
            (fetchTemplateVariables as any).mockResolvedValue({
                SERVICE_NAME: { type: 'text', default: 'my-service' },
                PUBLIC_DOMAIN: { type: 'text', default: 'example.com' },
                TEST_SUBDOMAIN: { type: 'subdomain', default: 'test', proxyPort: '8080' },
            });

            // Make proxy-hosts return 401 with needsCredentials
            global.fetch = vi.fn().mockImplementation((url: string, opts?: { method?: string; body?: string }) => {
                if (url.includes('/api/settings')) {
                    return Promise.resolve({ ok: true, json: () => Promise.resolve({ templateSettings: {} }) });
                }
                if (url.includes('/api/services') && (!opts || opts.method !== 'POST')) {
                    return Promise.resolve({ ok: true, json: () => Promise.resolve([
                        { name: 'nginx-web', active: true, status: 'running' },
                    ]) });
                }
                if (url.includes('/api/services') && opts?.method === 'POST') {
                    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
                }
                if (url.includes('/api/system/nginx/status')) {
                    return Promise.resolve({ ok: true, json: () => Promise.resolve({ installed: true, active: true }) });
                }
                if (url.includes('/api/system/nginx/proxy-hosts') && opts?.method === 'POST') {
                    // Check if credentials were provided in body
                    const body = opts?.body ? JSON.parse(opts.body) : {};
                    if (body.npmCredentials?.password === 'correct-password') {
                        return Promise.resolve({ ok: true, json: () => Promise.resolve({ created: ['test.example.com'] }) });
                    }
                    return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'Auth failed', needsCredentials: true }) });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            });

            render(<OnboardingWizard />);

            // Select stack → services → configure → install
            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            await waitFor(() => screen.getByRole('button', { name: /Continue/i }));
            fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

            await waitFor(() => screen.getByRole('button', { name: /Install Stack/i }));
            fireEvent.click(screen.getByRole('button', { name: /Install Stack/i }));

            // Should show credential prompt instead of going to done
            await waitFor(() => {
                expect(screen.getByText(/NPM Admin Login/i)).toBeDefined();
                expect(screen.getByPlaceholderText('NPM admin password')).toBeDefined();
            });

            // Enter correct credentials and submit
            fireEvent.change(screen.getByPlaceholderText('NPM admin password'), { target: { value: 'correct-password' } });
            fireEvent.click(screen.getByRole('button', { name: /Authenticate & Retry/i }));

            // Should succeed and show done state with DNS steps (since we have subdomain vars)
            await waitFor(() => {
                expect(screen.getByText(/1\. Configure DNS/i)).toBeDefined();
            });
        });

        it('skips already-installed services during install', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(stacksPendingStatus);
            // nginx-web has no yaml (not fetched since it's already installed)
            // but it IS in the selected items with alreadyInstalled=true
            // The install handler checks alreadyInstalled flag before deploying

            render(<OnboardingWizard />);

            await waitFor(() => screen.getByText('full-stack'));
            fireEvent.click(screen.getByText('full-stack'));

            // Check all items to ensure nginx-web would be in selected
            await waitFor(() => screen.getByText('nginx-web'));

            // nginx-web checkbox is disabled (already installed), so it won't be in the selected list
            // Check that the badge is shown
            expect(screen.getByText('already installed')).toBeDefined();
        });
    });

    // ---- Stacks step in full wizard flow ----

    describe('stacks step in full wizard', () => {
        it('shows Install Stack toggle on welcome screen', async () => {
            (checkOnboardingStatus as any).mockResolvedValue(needsSetupStatus);

            render(<OnboardingWizard />);

            await waitFor(() => {
                expect(screen.getByText(/Install Stack/i)).toBeDefined();
                expect(screen.getByText(/Deploy a pre-configured service bundle/i)).toBeDefined();
            });
        });
    });
});
