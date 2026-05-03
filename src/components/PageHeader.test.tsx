import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PageHeader from './PageHeader';
import { ToastProvider } from '../providers/ToastProvider';

const backMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    back: backMock,
    push: pushMock,
  }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null, isConnected: true }),
}));

const renderWithToast = (ui: React.ReactNode) =>
  render(<ToastProvider>{ui}</ToastProvider>);

describe('PageHeader', () => {
  it('renders the title correctly', () => {
    renderWithToast(<PageHeader title="Test Title" />);
    expect(screen.getByText('Test Title')).toBeDefined();
  });

  it('does not render a back button by default (root pages)', () => {
    renderWithToast(<PageHeader title="Root Page" />);
    expect(screen.queryByLabelText('Go back')).toBeNull();
  });

  it('calls router.back() when back button is clicked and history exists', () => {
    Object.defineProperty(window, 'history', {
      configurable: true,
      value: { length: 5 },
    });
    renderWithToast(<PageHeader title="Sub Page" showBack />);
    fireEvent.click(screen.getByLabelText('Go back'));
    expect(backMock).toHaveBeenCalled();
  });

  it('falls back to /services when there is no browser history', () => {
    Object.defineProperty(window, 'history', {
      configurable: true,
      value: { length: 1 },
    });
    renderWithToast(<PageHeader title="Sub Page" showBack />);
    fireEvent.click(screen.getByLabelText('Go back'));
    expect(pushMock).toHaveBeenCalledWith('/services');
  });
});
