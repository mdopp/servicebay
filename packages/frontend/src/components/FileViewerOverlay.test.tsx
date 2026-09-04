import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FileViewerOverlay from './FileViewerOverlay';
import { fetchFileContent } from '@servicebay/api-client';

vi.mock('@servicebay/api-client', () => ({ fetchFileContent: vi.fn() }));
vi.mock('./FileViewer', () => ({
  default: ({ content }: { content: string }) => <pre data-testid="file-content">{content}</pre>,
}));

describe('FileViewerOverlay', () => {
  beforeEach(() => {
    vi.mocked(fetchFileContent).mockResolvedValue({ content: 'hello world' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the close control is a Button primitive that calls onClose', async () => {
    const onClose = vi.fn();
    render(<FileViewerOverlay isOpen path="/etc/foo.conf" onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId('file-content')).toBeTruthy());

    const closeBtn = screen.getByRole('button', { name: 'Close file viewer' });
    expect(closeBtn.tagName).toBe('BUTTON');
    expect(closeBtn.getAttribute('data-variant')).toBe('ghost');

    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <FileViewerOverlay isOpen={false} path="/etc/foo.conf" onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
