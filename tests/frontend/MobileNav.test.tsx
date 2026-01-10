
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MobileTopBar, MobileBottomBar } from '../../src/components/MobileNav';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/network', // Default active
  useRouter: () => ({ push: mockPush })
}));

describe('MobileNav', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('MobileTopBar renders logo and settings', () => {
        render(<MobileTopBar />);
        expect(screen.getByText('ServiceBay')).toBeDefined();
        
        // Find Settings button using class logic or assumptions?
        // Actually, MobileTopBar buttons: Settings and Github.
        // We can look for buttons.
        const buttons = screen.getAllByRole('button');
        // Filter for the one that calls push('/settings') on click?
        // Or better, let's just find the first one which is Settings in the code.
        const settingsBtn = buttons[0]; 
        
        fireEvent.click(settingsBtn);
        expect(mockPush).toHaveBeenCalledWith('/settings');
    });

    it('MobileBottomBar renders plugins except Settings', () => {
        render(<MobileBottomBar />);
        
        // Should show Containers (via title)
        expect(screen.getByTitle('Containers')).toBeDefined();
        // Should show Network
        expect(screen.getByTitle('Network Map')).toBeDefined();
        
        // Should NOT show Settings (filtered out)
        expect(screen.queryByTitle('Settings')).toBeNull();
    });

    it('MobileBottomBar highlights active route', () => {
        // usePathname is '/network'
        render(<MobileBottomBar />);
        
        const networkBtn = screen.getByTitle('Network Map');
        
        // Active class logic in MobileNav: isActive ? 'text-blue-600 ...' : 'text-gray-500 ...'
        expect(networkBtn.className).toContain('text-blue-600');
        
        // Inactive
        const containersBtn = screen.getByTitle('Containers');
        expect(containersBtn.className).not.toContain('text-blue-600');
    });
});
