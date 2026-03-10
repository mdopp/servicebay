
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Sidebar from '../../src/components/Sidebar';

// Mock Next Navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/containers', // Default active
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mockPush })
}));

describe('Sidebar', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset window width to Desktop
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
        window.dispatchEvent(new Event('resize'));

        // Default: LLDAP not deployed (url: null)
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ url: null }), { status: 200 })
        );
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it('renders expanded by default on desktop', () => {
        render(<Sidebar />);
        expect(screen.getByText('Container Engine')).toBeDefined();
        expect(screen.getByTitle('Collapse Sidebar')).toBeDefined();
    });

    it('collapses on toggle click', async () => {
        render(<Sidebar />);

        const toggleBtn = screen.getByTitle('Collapse Sidebar');
        fireEvent.click(toggleBtn);

        await waitFor(() => {
             expect(screen.queryByText('Container Engine')).toBeNull();
             expect(screen.getByTitle('Expand Sidebar')).toBeDefined();
        });
    });

    it('renders active state', () => {
        render(<Sidebar />);

        const text = screen.getByText('Container Engine');
        const button = text.closest('button');
        expect(button).toBeDefined();
        expect(button?.className).toContain('text-blue-600');
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
        expect(screen.queryByText('Container Engine')).toBeNull();
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
        fetchSpy.mockResolvedValue(
            new Response(JSON.stringify({ url: 'https://ldap.example.com' }), { status: 200 })
        );

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
        fetchSpy.mockRejectedValue(new Error('Network error'));

        render(<Sidebar />);

        // Give time for the failed fetch to resolve
        await waitFor(() => {
            expect(fetchSpy).toHaveBeenCalled();
        });

        expect(screen.queryByText('Users & Groups')).toBeNull();
    });

    it('does not include Users & Groups as a static nav item', () => {
        // The old code had it as a static plugin entry — verify it's gone
        render(<Sidebar />);

        const buttons = screen.getAllByRole('button');
        const navTexts = buttons.map(b => b.textContent).filter(Boolean);
        expect(navTexts).not.toContain('Users & Groups');
    });
});
