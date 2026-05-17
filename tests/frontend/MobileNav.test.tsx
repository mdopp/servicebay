
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MobileTopBar, MobileBottomBar } from '../../src/components/MobileNav';
import { ToastProvider } from '../../src/providers/ToastProvider';

const mockPush = vi.fn();
let currentNode: string | null = null;
vi.mock('next/navigation', () => ({
  usePathname: () => '/network',
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: (key: string) => (key === 'node' ? currentNode : null) }),
}));

const renderWithToast = (ui: React.ReactNode) =>
    render(<ToastProvider>{ui}</ToastProvider>);

describe('MobileNav', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        currentNode = null;
        if (typeof window !== 'undefined') window.localStorage.clear();
    });

    it('MobileTopBar renders logo and routes Settings click', () => {
        renderWithToast(<MobileTopBar />);
        expect(screen.getByText('ServiceBay')).toBeDefined();

        const settingsBtn = screen.getByLabelText('Open settings');
        fireEvent.click(settingsBtn);
        expect(mockPush).toHaveBeenCalledWith('/settings');
    });

    it('MobileTopBar preserves ?node= on Settings click', () => {
        currentNode = 'edge-1';
        renderWithToast(<MobileTopBar />);
        fireEvent.click(screen.getByLabelText('Open settings'));
        expect(mockPush).toHaveBeenCalledWith('/settings?node=edge-1');
    });

    it('MobileBottomBar renders dashboards except Settings using shortLabel', () => {
        renderWithToast(<MobileBottomBar />);
        expect(screen.getByTitle('Container Engine')).toBeDefined();
        expect(screen.getByTitle('Network Map')).toBeDefined();
        expect(screen.queryByTitle('Settings')).toBeNull();
        // shortLabel renders "Containers", not the trimmed-first-word "Container".
        expect(screen.getByText('Containers')).toBeDefined();
    });

    it('MobileBottomBar highlights active route', () => {
        renderWithToast(<MobileBottomBar />);
        const networkBtn = screen.getByTitle('Network Map');
        expect(networkBtn.className).toContain('text-blue-600');
        const containersBtn = screen.getByTitle('Container Engine');
        expect(containersBtn.className).not.toContain('text-blue-600');
    });

    it('MobileBottomBar threads ?node= into navigation', () => {
        currentNode = 'edge-1';
        renderWithToast(<MobileBottomBar />);
        fireEvent.click(screen.getByTitle('Container Engine'));
        expect(mockPush).toHaveBeenCalledWith('/containers?node=edge-1');
    });
});
