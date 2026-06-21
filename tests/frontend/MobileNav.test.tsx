
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MobileTopBar, MobileBottomBar } from '@/components/MobileNav';
import { ToastProvider } from '@/providers/ToastProvider';

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
        expect(networkBtn.className).toContain('text-blue-600');
        const servicesBtn = screen.getByTitle('Services');
        expect(servicesBtn.className).not.toContain('text-blue-600');
    });

    it('MobileBottomBar threads ?node= into navigation', () => {
        currentNode = 'edge-1';
        renderWithToast(<MobileBottomBar />);
        fireEvent.click(screen.getByTitle('Services'));
        expect(mockPush).toHaveBeenCalledWith('/services?node=edge-1');
    });
});
