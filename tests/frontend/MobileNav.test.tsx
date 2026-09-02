
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileTopBar, MobileBottomBar } from '@/components/MobileNav';
import { ToastProvider } from '@/providers/ToastProvider';

const mockPush = vi.fn();
let currentNode: string | null = null;
vi.mock('next/navigation', () => ({
  usePathname: () => '/network',
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: (key: string) => (key === 'node' ? currentNode : null) }),
}));

// #2521 — the mobile nav now renders the same resolved navigation schema as
// the desktop sidebar, so it consumes the digital twin (Maintenance Chat is
// gated on installedTemplates). These tests render outside a
// DigitalTwinProvider, so stub the hook with a mutable snapshot.
const twinRef: { current: { installedTemplates?: string[] } | null } = { current: null };
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({ data: twinRef.current, isConnected: false, lastUpdate: 0, isNodeSynced: () => false }),
}));

// The Setup badge reads the shared install poll (#2732); the provider lives
// in the dashboard layout, so stub the hook with an idle box.
vi.mock('@/hooks/useInstallJob', () => ({
  useInstallJob: () => ({ jobIsActive: false, stackSetupPending: false }),
}));

const renderWithToast = (ui: React.ReactNode) =>
    render(<ToastProvider>{ui}</ToastProvider>);

describe('MobileNav', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    // Route-aware fetch mock — a fresh Response per URL (a Response body can
    // only be read once, and the bars fetch in parallel).
    const lldapResponse = { url: null as string | null };
    function mockFetch(url: RequestInfo | URL) {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('/api/auth/lldap-url')) {
            return new Response(JSON.stringify(lldapResponse), { status: 200 });
        }
        if (u.includes('/api/system/version')) {
            return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        currentNode = null;
        twinRef.current = null;
        lldapResponse.url = null;
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => Promise.resolve(mockFetch(url)));
        if (typeof window !== 'undefined') window.localStorage.clear();
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it('MobileTopBar renders logo and routes Settings click', () => {
        renderWithToast(<MobileTopBar />);
        expect(screen.getByText('ServiceBay')).toBeDefined();

        // Top-bar icon row is schema-driven (#1992): entries flagged
        // hiddenOnMobileBottom (Settings, Backup) get an aria-label of their
        // full `name`.
        const settingsBtn = screen.getByLabelText('Settings');
        fireEvent.click(settingsBtn);
        expect(mockPush).toHaveBeenCalledWith('/settings');
    });

    it('MobileTopBar exposes Backup so it is reachable on mobile (#1992)', () => {
        renderWithToast(<MobileTopBar />);
        const backupBtn = screen.getByLabelText('Backup & restore');
        fireEvent.click(backupBtn);
        expect(mockPush).toHaveBeenCalledWith('/backup');
    });

    it('MobileTopBar preserves ?node= on Settings click', () => {
        currentNode = 'edge-1';
        renderWithToast(<MobileTopBar />);
        fireEvent.click(screen.getByLabelText('Settings'));
        expect(mockPush).toHaveBeenCalledWith('/settings?node=edge-1');
    });

    it('MobileBottomBar renders dashboards except Settings using shortLabel', () => {
        renderWithToast(<MobileBottomBar />);
        expect(screen.getByTitle('Services')).toBeDefined();
        expect(screen.getByTitle('Network Map')).toBeDefined();
        expect(screen.queryByTitle('Settings')).toBeNull();
        // Container Engine moved into Diagnostics (#802) — no longer a
        // top-level mobile-bottom entry.
        expect(screen.queryByTitle('Container Engine')).toBeNull();
    });

    it('MobileBottomBar highlights active route', () => {
        renderWithToast(<MobileBottomBar />);
        const networkBtn = screen.getByTitle('Network Map');
        expect(networkBtn.className).toContain('text-accent');
        const servicesBtn = screen.getByTitle('Services');
        expect(servicesBtn.className).not.toContain('text-accent');
    });

    it('MobileBottomBar threads ?node= into navigation', () => {
        currentNode = 'edge-1';
        renderWithToast(<MobileBottomBar />);
        fireEvent.click(screen.getByTitle('Services'));
        expect(mockPush).toHaveBeenCalledWith('/services?node=edge-1');
    });

    // #2521 — before this, Sidebar.tsx rendered Maintenance Chat, Users &
    // Groups and View as user as inline JSX, so the mobile nav (which maps the
    // schema) simply did not have them. Desktop and mobile must offer the same
    // destinations.
    describe('desktop/mobile destination parity (#2521)', () => {
        it('surfaces the app-leaving links in the top bar, after a divider', async () => {
            lldapResponse.url = 'https://ldap.example.com';
            const { container } = renderWithToast(<MobileTopBar />);

            await waitFor(() => {
                expect(container.querySelector('[data-testid="nav-users"]')).not.toBeNull();
            });
            const users = container.querySelector('[data-testid="nav-users"]');
            expect(users?.tagName).toBe('A');
            expect(users?.getAttribute('href')).toBe('https://ldap.example.com');
            expect(users?.getAttribute('target')).toBe('_blank');

            const portal = container.querySelector('[data-testid="nav-portal"]');
            expect(portal?.getAttribute('href')).toBe('/portal');
            expect(portal?.getAttribute('target')).toBe('_blank');

            // In-app icons come first, then a ruled-off group with the links.
            const group = container.querySelector('[data-testid="external-nav-group"]');
            expect(group?.className).toContain('border-l');
            expect(group?.className).toContain('border-border');
            expect(group?.contains(users!)).toBe(true);
            expect(group?.contains(portal!)).toBe(true);
            expect(group?.querySelector('[data-testid="nav-settings"]')).toBeNull();
            const order = Array.from(container.querySelectorAll('[data-testid^="nav-"]'))
                .map(el => el.getAttribute('data-testid'));
            expect(order.indexOf('nav-settings')).toBeLessThan(order.indexOf('nav-users'));
        });

        it('shows Maintenance Chat on the bottom bar once solilos-chat is installed', () => {
            twinRef.current = { installedTemplates: ['solilos-chat'] };
            const { container } = renderWithToast(<MobileBottomBar />);
            expect(container.querySelector('[data-testid="nav-chat"]')).not.toBeNull();
            expect(screen.getByTitle('Maintenance Chat')).toBeDefined();
        });

        it('hides Maintenance Chat when solilos-chat is not installed', () => {
            twinRef.current = { installedTemplates: ['media'] };
            const { container } = renderWithToast(<MobileBottomBar />);
            expect(container.querySelector('[data-testid="nav-chat"]')).toBeNull();
        });

        it('top bar + bottom bar together cover the whole resolved schema', async () => {
            const { resolveNavigationEntries } = await import('@/config/navigation');
            twinRef.current = { installedTemplates: ['solilos-chat'] };
            lldapResponse.url = 'https://ldap.example.com';

            const top = renderWithToast(<MobileTopBar />);
            const bottom = renderWithToast(<MobileBottomBar />);

            const expected = resolveNavigationEntries({
                installedTemplates: ['solilos-chat'],
                lldapUrl: 'https://ldap.example.com',
                node: null,
            }).map(e => `nav-${e.id}`).sort();

            await waitFor(() => {
                const rendered = [...top.container.querySelectorAll('[data-testid^="nav-"]'),
                                  ...bottom.container.querySelectorAll('[data-testid^="nav-"]')]
                    .map(el => el.getAttribute('data-testid'))
                    .sort();
                // Same destinations the desktop Sidebar renders (Sidebar.test.tsx
                // asserts the sidebar equals this same resolved list).
                expect(rendered).toEqual(expected);
            });
        });
    });
});
