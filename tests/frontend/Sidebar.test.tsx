
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Sidebar from '@/components/Sidebar';

// Mock Next Navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/services', // Default active
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mockPush })
}));

// Sidebar consumes the digital twin (#1755 gates the Maintenance Chat link on
// installedTemplates). These tests render Sidebar outside a DigitalTwinProvider,
// so stub the hook with a mutable snapshot the per-test setup can vary.
const twinRef: { current: { installedTemplates?: string[] } | null } = { current: null };
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({ data: twinRef.current, isConnected: false, lastUpdate: 0, isNodeSynced: () => false }),
}));

describe('Sidebar', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    // Route-aware mock. `mockResolvedValue` would hand back the same Response
    // object across calls, so the second `.json()` would throw (a Response's
    // body can only be read once). Sidebar fires fetches in parallel
    // (/api/system/version, /api/auth/lldap-url, /api/install/status), so we
    // mint a fresh Response per URL.
    const lldapResponse = { url: null as string | null };
    function mockFetch(url: RequestInfo | URL) {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('/api/system/version')) {
            return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 });
        }
        if (u.includes('/api/auth/lldap-url')) {
            return new Response(JSON.stringify(lldapResponse), { status: 200 });
        }
        if (u.includes('/api/install/status')) {
            return new Response(JSON.stringify({ jobIsActive: false, stackSetupPending: false }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset window width to Desktop
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
        window.dispatchEvent(new Event('resize'));

        lldapResponse.url = null;
        twinRef.current = null;
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => Promise.resolve(mockFetch(url)));
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it('renders expanded by default on desktop', () => {
        render(<Sidebar />);
        expect(screen.getByText('Services')).toBeDefined();
        expect(screen.getByTitle('Collapse Sidebar')).toBeDefined();
    });

    it('collapses on toggle click', async () => {
        render(<Sidebar />);

        const toggleBtn = screen.getByTitle('Collapse Sidebar');
        fireEvent.click(toggleBtn);

        await waitFor(() => {
             expect(screen.queryByText('Services')).toBeNull();
             expect(screen.getByTitle('Expand Sidebar')).toBeDefined();
        });
    });

    it('renders active state on accent tokens (design-system migration #2100)', () => {
        render(<Sidebar />);

        const text = screen.getByText('Services');
        const button = text.closest('button');
        expect(button).toBeDefined();
        // Active nav chrome now resolves through semantic accent tokens
        // (dark-mode-correct), not a raw blue-600 literal.
        expect(button?.className).toContain('bg-accent/10');
        expect(button?.className).toContain('text-accent');
        expect(button?.className).not.toMatch(/blue-\d|dark:bg-blue/);
    });

    it('idle nav rows hover on surface tokens, no raw gray literals (#2100)', () => {
        render(<Sidebar />);
        const idle = screen.getByText('Status').closest('button');
        expect(idle?.className).toContain('hover:bg-surface-2');
        expect(idle?.className).toContain('text-text-muted');
        expect(idle?.className).not.toMatch(/gray-\d|dark:hover:bg-white/);
    });

    it('preserves EVERY unconditional navigation entry incl. the restored Terminal (#2083)', async () => {
        const { NAVIGATION_ENTRIES } = await import('@/config/navigation');
        render(<Sidebar />);
        // The conditional (Maintenance Chat) and external (LLDAP) entries are
        // covered by the schema-parity test below; on a bare box they are
        // correctly absent.
        for (const entry of NAVIGATION_ENTRIES.filter(e => !e.requiresTemplate && !(e.external && e.hrefSource))) {
            expect(screen.getByText(entry.name)).toBeDefined();
        }
        // Terminal must not be buried (memory: don't drop recovery tools).
        expect(screen.getByText('Terminal')).toBeDefined();
    });

    it('navigates on click', () => {
        render(<Sidebar />);
        const text = screen.getByText('Settings');
        fireEvent.click(text);
        expect(mockPush).toHaveBeenCalledWith('/settings');
    });

    it('auto-collapses on mobile width', () => {
        // Mock mobile width
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 500 });

        render(<Sidebar />);

        // Should be collapsed initially
        expect(screen.queryByText('Services')).toBeNull();
        expect(screen.getByTitle('Expand Sidebar')).toBeDefined();
    });

    it('does not show Users & Groups when LLDAP is not deployed', async () => {
        render(<Sidebar />);

        // Wait for fetch to complete
        await waitFor(() => {
            expect(fetchSpy).toHaveBeenCalledWith('/api/auth/lldap-url');
        });

        expect(screen.queryByText('Users & Groups')).toBeNull();
    });

    it('shows Users & Groups link when LLDAP is deployed', async () => {
        lldapResponse.url = 'https://ldap.example.com';

        render(<Sidebar />);

        await waitFor(() => {
            expect(screen.getByText('Users & Groups')).toBeDefined();
        });

        const link = screen.getByText('Users & Groups').closest('a');
        expect(link).toBeDefined();
        expect(link?.getAttribute('href')).toBe('https://ldap.example.com');
        expect(link?.getAttribute('target')).toBe('_blank');
    });

    it('does not show Users & Groups when fetch fails', async () => {
        fetchSpy.mockImplementation((url: RequestInfo | URL) => {
            const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
            if (u.includes('/api/auth/lldap-url')) {
                return Promise.reject(new Error('Network error'));
            }
            return Promise.resolve(mockFetch(url));
        });

        render(<Sidebar />);

        // Give time for the failed fetch to resolve
        await waitFor(() => {
            expect(fetchSpy).toHaveBeenCalled();
        });

        expect(screen.queryByText('Users & Groups')).toBeNull();
    });

    it('does not include Users & Groups as a static nav item', () => {
        // The old code had it as a static dashboard entry — verify it's gone
        render(<Sidebar />);

        const buttons = screen.getAllByRole('button');
        const navTexts = buttons.map(b => b.textContent).filter(Boolean);
        expect(navTexts).not.toContain('Users & Groups');
    });

    it('hides the Maintenance Chat link when solilos-chat is not installed (#1755/#1781)', () => {
        twinRef.current = { installedTemplates: ['auth', 'media', 'hermes'] };
        render(<Sidebar />);
        expect(screen.queryByText('Maintenance Chat')).toBeNull();
    });

    it('shows the Maintenance Chat link when solilos-chat is installed (#1755/#1781)', () => {
        twinRef.current = { installedTemplates: ['auth', 'hermes', 'solilos-chat'] };
        render(<Sidebar />);
        expect(screen.getByText('Maintenance Chat')).toBeDefined();
    });

    // #2521 — the sidebar renders the navigation SCHEMA and nothing else. The
    // three entries that used to be inline JSX here (Maintenance Chat, Users &
    // Groups, View as user) are the reason the mobile nav showed a different
    // set of destinations; these lock the drift out.
    describe('schema-driven rendering (#2521)', () => {
        it('renders exactly the resolved schema — no inline entries', async () => {
            const { resolveNavigationEntries } = await import('@/config/navigation');
            twinRef.current = { installedTemplates: ['solilos-chat'] };
            lldapResponse.url = 'https://ldap.example.com';
            const { container } = render(<Sidebar />);

            const expected = resolveNavigationEntries({
                installedTemplates: ['solilos-chat'],
                lldapUrl: 'https://ldap.example.com',
                node: null,
            }).map(e => `nav-${e.id}`);

            await waitFor(() => {
                const rendered = Array.from(container.querySelectorAll('[data-testid^="nav-"]'))
                    .map(el => el.getAttribute('data-testid'));
                expect(rendered).toEqual(expected);
            });
        });

        it('splits in-app destinations from app-leaving links into two groups', async () => {
            lldapResponse.url = 'https://ldap.example.com';
            const { container } = render(<Sidebar />);

            await waitFor(() => {
                expect(screen.getByText('Users & Groups')).toBeDefined();
            });

            const appGroup = container.querySelector('nav[aria-label="Primary"]');
            const externalGroup = container.querySelector('nav[aria-label="Opens in a new tab"]');
            expect(appGroup).not.toBeNull();
            expect(externalGroup).not.toBeNull();
            // A visible separator, not just a 12px icon after the label.
            expect(externalGroup?.className).toContain('border-t');
            expect(externalGroup?.className).toContain('border-border');
            // Every app-leaving link lives in the external group, and no
            // in-app destination leaked into it.
            expect(externalGroup?.querySelector('[data-testid="nav-users"]')).not.toBeNull();
            expect(externalGroup?.querySelector('[data-testid="nav-portal"]')).not.toBeNull();
            expect(appGroup?.querySelector('[data-testid="nav-services"]')).not.toBeNull();
            expect(appGroup?.querySelector('[data-testid="nav-portal"]')).toBeNull();
            for (const link of Array.from(externalGroup?.querySelectorAll('a') ?? [])) {
                expect(link.getAttribute('target')).toBe('_blank');
            }
        });

        it('keeps both groups usable when collapsed (labels drop, divider stays)', async () => {
            lldapResponse.url = 'https://ldap.example.com';
            const { container } = render(<Sidebar />);
            await waitFor(() => expect(screen.getByText('Users & Groups')).toBeDefined());

            fireEvent.click(screen.getByTitle('Collapse Sidebar'));

            await waitFor(() => {
                expect(screen.getByTitle('Expand Sidebar')).toBeDefined();
                // Section label is gone; the group divider and every entry stay.
                expect(screen.queryByText('Opens in a new tab')).toBeNull();
                expect(screen.queryByText('Users & Groups')).toBeNull();
            });
            expect(container.querySelector('nav[aria-label="Opens in a new tab"]')?.className).toContain('border-t');
            expect(container.querySelector('[data-testid="nav-users"]')?.getAttribute('title'))
                .toBe('Users & Groups — opens in a new tab');
            expect(container.querySelector('[data-testid="nav-services"]')).not.toBeNull();
            expect(container.querySelector('[data-testid="nav-portal"]')).not.toBeNull();
        });
    });
});
