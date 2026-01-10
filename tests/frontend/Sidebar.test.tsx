
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Sidebar from '../../src/components/Sidebar';

// Mock Next Navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/containers', // Default active
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mockPush })
}));

describe('Sidebar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset window width to Desktop
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
        window.dispatchEvent(new Event('resize'));
    });

    it('renders expanded by default on desktop', () => {
        render(<Sidebar />);
        expect(screen.getByText('Containers')).toBeDefined();
        expect(screen.getByTitle('Collapse Sidebar')).toBeDefined();
    });

    it('collapses on toggle click', async () => {
        render(<Sidebar />);
        
        const toggleBtn = screen.getByTitle('Collapse Sidebar');
        fireEvent.click(toggleBtn);

        await waitFor(() => {
             expect(screen.queryByText('Containers')).toBeNull();
             expect(screen.getByTitle('Expand Sidebar')).toBeDefined();
        });
    });

    it('renders active state', () => {
        render(<Sidebar />);
        // Find button for Containers
        // It should have active classes. 
        // We can check if the button contains the icon or has active class.
        // Or find by text 'Containers' and check parent button.
        
        const text = screen.getByText('Containers');
        const button = text.closest('button');
        expect(button).toBeDefined();
        
        // Active class: 'text-blue-600' or 'bg-white' (dark mode handled via class strategy)
        // From code: active ? 'bg-white ... text-blue-600 ...' : '...'
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
        expect(screen.queryByText('Containers')).toBeNull();
        expect(screen.getByTitle('Expand Sidebar')).toBeDefined();
    });
});
