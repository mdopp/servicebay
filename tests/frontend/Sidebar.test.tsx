
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

    it('preserves EVERY navigation entry incl. the restored Terminal (#2083)', async () => {
        const { NAVIGATION_ENTRIES } = await import('@/config/navigation');
        render(<Sidebar />);
        for (const entry of NAVIGATION_ENTRIES) {
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
});
