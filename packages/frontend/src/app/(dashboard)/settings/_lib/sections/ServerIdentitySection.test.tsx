/**
 * ServerIdentitySection — design-system migration (#2100 cluster 2). Asserts the
 * section renders on a token Card surface with a Button primitive Save action and
 * no raw colour literals, and that Save still calls persistSettings.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ServerIdentitySection from './ServerIdentitySection';

const persistSettings = vi.fn();
const setServerName = vi.fn();

vi.mock('../SettingsContext', () => ({
  useSettings: () => ({ saving: false, serverName: 'box', setServerName, persistSettings }),
}));

describe('ServerIdentitySection (#2100 settings migration)', () => {
  it('renders on a token Card surface with no raw colour literals', () => {
    const { container } = render(<ServerIdentitySection />);
    expect(container.querySelector('.bg-surface')).not.toBeNull();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('Save still calls persistSettings (behaviour preserved)', () => {
    render(<ServerIdentitySection />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(persistSettings).toHaveBeenCalled();
  });
});
