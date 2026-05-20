import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConfirmModal from '@/components/ConfirmModal';

describe('ConfirmModal', () => {
    // The vitest Mock type isn't a perfect fit for `() => void` props, so cast
    // through unknown to keep the prop typing happy while preserving the spy.
    let onConfirm: () => void;
    let onCancel: () => void;
    const onConfirmSpy = vi.fn();
    const onCancelSpy = vi.fn();

    beforeEach(() => {
        onConfirmSpy.mockReset();
        onCancelSpy.mockReset();
        onConfirm = onConfirmSpy as unknown as () => void;
        onCancel = onCancelSpy as unknown as () => void;
    });

    it('returns null when not open', () => {
        const { container } = render(
            <ConfirmModal isOpen={false} title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />
        );
        expect(container.firstChild).toBeNull();
    });

    it('shows resourceName when provided', () => {
        render(
            <ConfirmModal
                isOpen
                title="Delete service"
                message="Are you sure?"
                resourceName="postgres-prod"
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        expect(screen.getByText('postgres-prod')).toBeDefined();
    });

    it('disables confirm until resourceName is typed', () => {
        render(
            <ConfirmModal
                isOpen
                title="Delete service"
                message="Type to confirm."
                resourceName="postgres-prod"
                requireTypedConfirm
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        const confirmBtn = screen.getByRole('button', { name: /confirm/i }) as HTMLButtonElement;
        expect(confirmBtn.disabled).toBe(true);

        const input = screen.getByRole('textbox') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'wrong' } });
        expect(confirmBtn.disabled).toBe(true);

        fireEvent.change(input, { target: { value: 'postgres-prod' } });
        expect(confirmBtn.disabled).toBe(false);

        fireEvent.click(confirmBtn);
        expect(onConfirmSpy).toHaveBeenCalledTimes(1);
    });

    it('Enter submits when type-to-confirm is not required', () => {
        const { container } = render(
            <ConfirmModal
                isOpen
                title="Save"
                message="ok?"
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
        // Move focus away from cancel default before pressing Enter to simulate user
        // having tabbed to the confirm button.
        const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
        confirmBtn.focus();
        fireEvent.keyDown(dialog, { key: 'Enter' });
        expect(onConfirmSpy).toHaveBeenCalledTimes(1);
    });

    it('Enter does NOT submit when type-to-confirm is required', () => {
        const { container } = render(
            <ConfirmModal
                isOpen
                title="Delete"
                message="ok?"
                resourceName="x"
                requireTypedConfirm
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
        fireEvent.keyDown(dialog, { key: 'Enter' });
        expect(onConfirmSpy).not.toHaveBeenCalled();
    });

    it('disables both buttons while loading', () => {
        render(
            <ConfirmModal
                isOpen
                title="Delete"
                message="ok?"
                isLoading
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        const cancelBtn = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
        const confirmBtn = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
        expect(cancelBtn.disabled).toBe(true);
        expect(confirmBtn.disabled).toBe(true);
    });
});
