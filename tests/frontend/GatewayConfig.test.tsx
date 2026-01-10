
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import GatewayConfig from '../../src/components/GatewayConfig';

// Mock Toast securely to be stable across renders
vi.mock('@/providers/ToastProvider', () => {
    const addToast = vi.fn();
    return {
        useToast: () => ({ addToast })
    };
});

describe('GatewayConfig', () => {
    beforeEach(() => {
        global.fetch = vi.fn().mockImplementation(() => Promise.resolve({
            ok: true,
            json: async () => ({})
        }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('loads and displays settings', async () => {
        const mockConfig = { gateway: { host: '192.168.178.1', username: 'myuser' } };
        (global.fetch as any).mockImplementation(() => Promise.resolve({
            ok: true,
            json: async () => mockConfig
        }));

        render(<GatewayConfig />);

        await waitFor(() => {
            expect(screen.getByDisplayValue('192.168.178.1')).toBeDefined();
            expect(screen.getByDisplayValue('myuser')).toBeDefined();
        });
    });

    it('saves settings', async () => {
         const fetchMock = global.fetch as any;
         // Stack implementations
         fetchMock
            .mockImplementationOnce(() => Promise.resolve({
                ok: true,
                json: async () => ({ gateway: {} })
            })) // 1st call: Load
            .mockImplementationOnce(() => Promise.resolve({
                 ok: true,
                 json: async () => ({ success: true })
            })); // 2nd call: Save

        render(<GatewayConfig />);
        
        await waitFor(() => screen.getByRole('button', { name: /Save/i }));

        const hostInput = screen.getByPlaceholderText('fritz.box');
        fireEvent.change(hostInput, { target: { value: 'new.fritz.box' } });

        const userInput = screen.getByPlaceholderText('admin');
        fireEvent.change(userInput, { target: { value: 'newuser' } });

        fireEvent.click(screen.getByRole('button', { name: /Save/i }));

        await waitFor(() => {
            // We want to verify the POST call
            // Since there might be spurious GET calls if my stability fix failed, let's look for the POST specifically
            // But expect(times(2)) is safer to ensure no infinite loops
            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(global.fetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('new.fritz.box'),
            }));
        });
    });
});
