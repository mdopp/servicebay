
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
}));

import { checkOnboardingStatus, saveGatewayConfig } from '@/app/actions/onboarding';

// 2. Mock Toast Provider
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn() })
}));

// 3. Mock Navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

describe('OnboardingWizard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not render if onboarding is complete', async () => {
        (checkOnboardingStatus as any).mockResolvedValue({ needsSetup: false, features: {} });
        
        render(<OnboardingWizard />);
        
        // Should not see the Welcome text
        await waitFor(() => {
            expect(screen.queryByText(/Welcome to ServiceBay/i)).toBeNull();
        });
    });

    it('renders welcome screen if setup is needed', async () => {
        (checkOnboardingStatus as any).mockResolvedValue({ 
            needsSetup: true, 
            features: { gateway: false, ssh: false } 
        });
        
        render(<OnboardingWizard />);
        
        await waitFor(() => {
            expect(screen.getByText(/Welcome to ServiceBay/i)).toBeDefined();
        });
    });

    it('navigates to first selected step', async () => {
        (checkOnboardingStatus as any).mockResolvedValue({ 
            needsSetup: true, 
            features: { gateway: false } // Will default to selected=true
        });
        
        render(<OnboardingWizard />);
        
        // Wait for load - Find "Next" button part of footer
        // Using getAllByRole because there might be multiple buttons, but "Next" with icon should be unique enough or we filter
        await waitFor(() => screen.getByRole('button', { name: /Next/i }));

        // Click Next
        fireEvent.click(screen.getByRole('button', { name: /Next/i }));

        // Should be on Gateway step 
        // Header: Internet Gateway
        await waitFor(() => {
            expect(screen.getAllByText(/Internet Gateway/i).length).toBeGreaterThan(0);
            expect(screen.getByPlaceholderText('fritz.box')).toBeDefined();
        });
    });

    it('submits gateway config', async () => {
        (checkOnboardingStatus as any).mockResolvedValue({ 
            needsSetup: true, 
            features: { gateway: false } 
        }); 
        
        render(<OnboardingWizard />);
        await waitFor(() => screen.getByRole('button', { name: /Next/i }));
        fireEvent.click(screen.getByRole('button', { name: /Next/i }));

        // Fill Form
        await waitFor(() => screen.getByPlaceholderText('fritz.box'));
        const hostInput = screen.getByPlaceholderText('fritz.box');
        fireEvent.change(hostInput, { target: { value: '192.168.1.1' } });
        
        // Click Save & Next
        const saveBtn = screen.getByRole('button', { name: /Save & Next/i });
        fireEvent.click(saveBtn);

        await waitFor(() => {
            expect(saveGatewayConfig).toHaveBeenCalledWith('192.168.1.1', '', '');
        });
    });
});
