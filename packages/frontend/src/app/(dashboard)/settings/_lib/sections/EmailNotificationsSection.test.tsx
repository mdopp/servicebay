/**
 * EmailNotificationsSection — design-system migration (#2100 cluster 2). Asserts
 * the section is on a token Card surface (no raw colour literals), the enable
 * switch toggles via persistSettings, and recipient add/remove still work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EmailNotificationsSection from './EmailNotificationsSection';

const persistSettings = vi.fn();
const setEmailEnabled = vi.fn();
const setEmailRecipients = vi.fn();

let enabled = true;
let recipients: string[] = ['a@example.com'];

vi.mock('../SettingsContext', () => ({
  useSettings: () => ({
    saving: false,
    emailEnabled: enabled, setEmailEnabled,
    emailHost: '', setEmailHost: vi.fn(),
    emailPort: 587, setEmailPort: vi.fn(),
    emailSecure: false, setEmailSecure: vi.fn(),
    emailUser: '', setEmailUser: vi.fn(),
    emailPass: '', setEmailPass: vi.fn(),
    emailFrom: '', setEmailFrom: vi.fn(),
    emailRecipients: recipients, setEmailRecipients,
    persistSettings,
  }),
}));

describe('EmailNotificationsSection (#2100 settings migration)', () => {
  beforeEach(() => { vi.clearAllMocks(); enabled = true; recipients = ['a@example.com']; });

  it('renders its controls with no inner duplicate title and no raw colour literals (#2109)', () => {
    const { container } = render(<EmailNotificationsSection />);
    // No "Email (SMTP)" h3 inside the section — the SettingDisclosure header
    // carries the icon+title+description now (#2109).
    expect(container.querySelector('h3')).toBeNull();
    expect(screen.getByRole('switch', { name: /enable email/i })).toBeDefined();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|rose|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|rose|purple|indigo)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('enable switch toggles via persistSettings (behaviour preserved)', () => {
    render(<EmailNotificationsSection />);
    fireEvent.click(screen.getByRole('switch', { name: /enable email/i }));
    expect(setEmailEnabled).toHaveBeenCalledWith(false);
    expect(persistSettings).toHaveBeenCalledWith({ email: { enabled: false } });
  });

  it('removing a recipient still persists (behaviour preserved)', () => {
    render(<EmailNotificationsSection />);
    fireEvent.click(screen.getByRole('button', { name: /remove a@example.com/i }));
    expect(setEmailRecipients).toHaveBeenCalledWith([]);
    expect(persistSettings).toHaveBeenCalledWith({ email: { to: [] } });
  });
});
