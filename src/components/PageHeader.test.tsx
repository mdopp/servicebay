import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PageHeader from './PageHeader';

// Mock useRouter
const backMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    back: backMock,
  }),
}));

describe('PageHeader', () => {
  it('renders the title correctly', () => {
    render(<PageHeader title="Test Title" />);
    expect(screen.getByText('Test Title')).toBeDefined();
  });

  it('calls router.back() when back button is clicked', () => {
    render(<PageHeader title="Test Title" />);
    const backButton = screen.getByTitle('Go Back');
    fireEvent.click(backButton);
    expect(backMock).toHaveBeenCalled();
  });
});
