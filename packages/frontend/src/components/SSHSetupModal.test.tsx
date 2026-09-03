import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SSHSetupModal from './SSHSetupModal';

// Stub the api-client method the modal drives.
vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  installSSHKey: vi.fn(async () => ({ success: true, logs: ['Test log'] })),
}));

describe('SSHSetupModal (#2430 design-token migration)', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    mockOnClose.mockClear();
  });

  it('should not render when isOpen is false', () => {
    const { container } = render(
      <SSHSetupModal isOpen={false} onClose={mockOnClose} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('should render modal with semantic token classes when isOpen is true', () => {
    render(
      <SSHSetupModal
        isOpen={true}
        onClose={mockOnClose}
        initialHost="example.com"
        initialPort={22}
        initialUser="root"
      />,
    );

    // Check for semantic token classes in the dialog background (backdrop)
    const backdrop = screen.getByRole('heading', { name: /Setup SSH Keys/i }).closest('.fixed');
    expect(backdrop?.className).toContain('bg-black/50');

    // Check modal container has semantic tokens
    const modal = backdrop?.querySelector('div[class*="bg-surface"]');
    expect(modal?.className).toContain('bg-surface');
    expect(modal?.className).toContain('border-border');
  });

  it('should render header with semantic token text colors', () => {
    render(
      <SSHSetupModal isOpen={true} onClose={mockOnClose} />,
    );

    const heading = screen.getByRole('heading', { name: /Setup SSH Keys/i });
    expect(heading.className).toContain('text-text');

    // Check close button has semantic token colors
    const closeButton = heading.parentElement?.querySelector('button[class*="text-"]');
    expect(closeButton?.className).toContain('text-text-muted');
  });

  it('should render input fields with semantic token border and background', () => {
    render(
      <SSHSetupModal isOpen={true} onClose={mockOnClose} />,
    );

    const inputs = screen.getAllByRole('textbox');
    inputs.forEach((input) => {
      expect(input.className).toContain('border-border');
      expect(input.className).toContain('bg-surface-2');
      expect(input.className).toContain('text-text');
    });
  });

  it('should render number input with semantic token border and background', () => {
    render(
      <SSHSetupModal isOpen={true} onClose={mockOnClose} />,
    );

    const portInput = screen.getByPlaceholderText('22') as HTMLInputElement;
    expect(portInput.className).toContain('border-border');
    expect(portInput.className).toContain('bg-surface-2');
    expect(portInput.className).toContain('text-text');
  });

  it('should render labels with semantic token text color', () => {
    render(
      <SSHSetupModal isOpen={true} onClose={mockOnClose} />,
    );

    // Find the label elements that contain Host, Port, Username, or Password text
    const hostLabel = screen.getByText('Host').closest('label');
    const portLabel = screen.getByText('Port').closest('label');
    const userLabel = screen.getByText('Username').closest('label');
    const passwordLabel = screen.getByText('Password').closest('label');

    [hostLabel, portLabel, userLabel, passwordLabel].forEach((label) => {
      expect(label?.className).toContain('text-text-muted');
    });
  });

  it('should render description text with semantic token color', () => {
    render(
      <SSHSetupModal isOpen={true} onClose={mockOnClose} />,
    );

    const description = screen.getByText(/This tool will copy/);
    expect(description.className).toContain('text-text-muted');
  });

  it('should render footer with semantic token background', () => {
    render(
      <SSHSetupModal isOpen={true} onClose={mockOnClose} />,
    );

    const closeButton = screen.getByRole('button', { name: /^Close$/ });
    const footer = closeButton.parentElement;

    expect(footer?.className).toContain('border-border');
    expect(footer?.className).toContain('bg-surface-2');
  });

  it('should render buttons with semantic token colors', () => {
    render(
      <SSHSetupModal isOpen={true} onClose={mockOnClose} />,
    );

    const closeButton = screen.getByRole('button', { name: /^Close$/ });
    expect(closeButton.className).toContain('text-text-muted');

    const setupButton = screen.getByRole('button', { name: /Run ssh-copy-id/ });
    expect(setupButton.className).toContain('bg-accent');
  });

  it('should render logs with semantic token text color', async () => {
    const { installSSHKey } = await import('@servicebay/api-client');
    vi.mocked(installSSHKey).mockResolvedValueOnce({
      success: true,
      logs: ['Test log message'],
    });

    render(
      <SSHSetupModal
        isOpen={true}
        onClose={mockOnClose}
        initialHost="example.com"
        initialPort={22}
        initialUser="root"
      />,
    );

    const hostInput = screen.getByPlaceholderText('192.168.1.x') as HTMLInputElement;
    const portInput = screen.getByPlaceholderText('22') as HTMLInputElement;
    const userInput = screen.getByPlaceholderText('root') as HTMLInputElement;
    const passwordInput = screen.getByPlaceholderText('••••••') as HTMLInputElement;
    const setupButton = screen.getByRole('button', { name: /Run ssh-copy-id/ });

    fireEvent.change(hostInput, { target: { value: 'example.com' } });
    fireEvent.change(portInput, { target: { value: '22' } });
    fireEvent.change(userInput, { target: { value: 'root' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });

    fireEvent.click(setupButton);

    await waitFor(() => {
      const logContainer = document.querySelector('.text-status-ok');
      expect(logContainer).toBeTruthy();
    });
  });

  it('should call onClose when close button is clicked', () => {
    render(
      <SSHSetupModal isOpen={true} onClose={mockOnClose} />,
    );

    const closeButton = screen.getByRole('button', { name: /^Close$/ });
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalled();
  });
});
