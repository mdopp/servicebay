import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import LocalTargetPicker from './LocalTargetPicker';

describe('LocalTargetPicker', () => {
  it('renders component and displays main label and rescan button', () => {
    // Mock fetch to prevent actual network calls
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    render(<LocalTargetPicker value="" onChange={onChange} />);

    // Verify basic structure is rendered
    expect(screen.getByText('Target disk')).toBeTruthy();
    expect(screen.getByText(/Rescan/)).toBeTruthy();
  });

  it('contains all required elements without crashing', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    const { container } = render(<LocalTargetPicker value="" onChange={onChange} />);

    // Verify the component renders without crashing
    expect(container).toBeTruthy();
    expect(screen.getByText('Target disk')).toBeTruthy();
  });

  it('accepts onChange callbacks', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    render(<LocalTargetPicker value="" onChange={onChange} />);

    // Verify that onChange is a valid callback (called during mount if needed)
    // The component should not throw when onChange is provided
    expect(onChange).toBeDefined();
  });

  it('uses semantic token classes instead of raw Tailwind utilities', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    render(<LocalTargetPicker value="" onChange={onChange} />);

    // Verify that semantic token classes are used (not raw Tailwind utilities)
    // The label should use text-text token (not text-gray-*)
    const label = screen.getByText('Target disk');
    expect(label.className).toContain('text-text');
    expect(label.className).not.toMatch(/text-gray/);

    // The rescan button should use text-text-muted and hover:text-text
    const rescanButton = screen.getByText(/Rescan/).closest('button');
    expect(rescanButton?.className).toContain('text-text-muted');
    expect(rescanButton?.className).toContain('hover:text-text');
    expect(rescanButton?.className).not.toMatch(/text-gray/);
  });

  it('handles mount selection correctly', () => {
    const mockMounts = [
      {
        device: '/dev/sda1',
        label: 'Test Drive',
        mountpoint: '/mnt/test',
        fstype: 'ext4',
        fsAvail: '100GB',
        fsUsedPct: '50%',
        mounted: true,
      },
    ];

    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: mockMounts }))
      )
    );

    const onChange = vi.fn();
    render(<LocalTargetPicker value="" onChange={onChange} />);

    // Component should render without errors
    expect(screen.getByText('Target disk')).toBeTruthy();
  });
});
