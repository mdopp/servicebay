/**
 * SectionHelp — Button primitive swap (no-raw-ui-primitive sweep).
 *
 * The trigger and the modal's close action moved off raw `<button>` onto the
 * shared `<Button variant="ghost">` primitive from `@/components/ui`; the
 * component had no test at all, so that swap shipped with zero coverage.
 * These tests render both buttons the swap touches: the help trigger (opens
 * the modal and fetches content) and, once open, the close action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// react-markdown is ESM-heavy and irrelevant here — render the raw text.
vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: string }) => <div data-testid="help-content">{children}</div>,
}));

const fetchHelpContentMock = vi.fn();
vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchHelpContent: (...args: unknown[]) => fetchHelpContentMock(...args),
}));

import SectionHelp from './SectionHelp';

describe('SectionHelp — Button primitive swap (#no-raw-ui-primitive)', () => {
  beforeEach(() => {
    fetchHelpContentMock.mockReset();
  });

  it('renders the trigger as a real Button and opening it fetches + shows help content', async () => {
    fetchHelpContentMock.mockResolvedValue({ content: 'Some help text' });

    render(<SectionHelp helpId="container-engine" label="Help" />);

    const trigger = screen.getByRole('button', { name: 'Help' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');

    fireEvent.click(trigger);

    expect(fetchHelpContentMock).toHaveBeenCalledWith('container-engine');
    await waitFor(() => {
      expect(screen.getByTestId('help-content').textContent).toBe('Some help text');
    });
  });

  it('closes the modal via the real close Button', async () => {
    fetchHelpContentMock.mockResolvedValue({ content: 'Some help text' });

    render(<SectionHelp helpId="container-engine" label="Help" title="Section Help" />);

    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    await waitFor(() => {
      expect(screen.getByTestId('help-content')).toBeTruthy();
    });

    const triggerButton = screen.getByRole('button', { name: 'Help' });
    const buttons = screen.getAllByRole('button');
    const closeButton = buttons.find((btn) => btn.textContent === '' && btn !== triggerButton);
    expect(closeButton).toBeTruthy();
    expect(closeButton?.tagName).toBe('BUTTON');

    fireEvent.click(closeButton as HTMLElement);
    expect(screen.queryByTestId('help-content')).toBeNull();
  });
});
