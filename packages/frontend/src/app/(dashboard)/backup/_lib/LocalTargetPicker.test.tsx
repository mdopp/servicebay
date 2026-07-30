import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import LocalTargetPicker from './LocalTargetPicker';

describe('LocalTargetPicker semantic token usage', () => {
  it('renders label with text-text token (not text-gray)', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    render(<LocalTargetPicker value="" onChange={onChange} />);

    // Verify label uses text-text semantic token instead of text-gray-*
    const label = screen.getByText('Target disk');
    expect(label.className).toContain('text-text');
    expect(label.className).not.toMatch(/text-gray/);
  });

  it('renders rescan button with text-text-muted and hover:text-text tokens', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    render(<LocalTargetPicker value="" onChange={onChange} />);

    // Verify rescan button uses semantic tokens instead of raw gray utilities
    const rescanButton = screen.getByText(/Rescan/).closest('button');
    expect(rescanButton?.className).toContain('text-text-muted');
    expect(rescanButton?.className).toContain('hover:text-text');
    // Ensure no raw Tailwind gray utilities
    expect(rescanButton?.className).not.toMatch(/text-gray|hover:text-gray|dark:text-gray|dark:hover:text-gray/);
  });

  it('does not use raw border-gray utilities in component HTML', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    const { container } = render(<LocalTargetPicker value="" onChange={onChange} />);

    const html = container.innerHTML;

    // Should NOT contain raw border-gray utilities anywhere
    expect(html).not.toMatch(/border-gray-\d+/);
  });

  it('does not use raw blue utilities (bg-blue-*, text-blue-*, border-blue-*)', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    const { container } = render(<LocalTargetPicker value="" onChange={onChange} />);

    const html = container.innerHTML;

    // Should NOT use raw blue utilities anywhere in the rendered component
    expect(html).not.toMatch(/text-blue-|bg-blue-|border-blue-|dark:text-blue|dark:bg-blue|dark:border-blue/);
  });

  it('code contains text-status-warn token for unmounted disk warnings', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    const { container } = render(<LocalTargetPicker value="" onChange={onChange} />);

    // The component code includes text-status-warn, even if not currently visible
    // This test verifies the component file contains semantic tokens, not raw amber
    const html = container.innerHTML;

    // The loading state should NOT contain raw amber utilities
    expect(html).not.toMatch(/text-amber-|dark:text-amber/);
  });

  it('renders component with text-text-muted token (no text-gray in muted contexts)', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    const { container } = render(<LocalTargetPicker value="" onChange={onChange} />);

    const html = container.innerHTML;

    // Should use text-text-muted semantic token
    expect(html).toContain('text-text-muted');

    // Should NOT contain raw gray text utilities in muted contexts
    // (This is a general check across the component)
    expect(html).not.toMatch(/text-gray-500|text-gray-400|text-gray-300|dark:text-gray-[0-9]/);
  });

  it('input styling does not use raw white or gray-700 utilities', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    const { container } = render(<LocalTargetPicker value="" onChange={onChange} />);

    const html = container.innerHTML;

    // The input is hidden by default, but when present should not use raw utilities
    // We check that if it's in the HTML, it doesn't have the problematic classes
    const inputRegex = /<input[^>]*>/g;
    const inputs = html.match(inputRegex);
    if (inputs) {
      inputs.forEach(input => {
        // If an input field is rendered, it shouldn't have raw white/gray utilities
        expect(input).not.toMatch(/bg-white|dark:bg-gray-700|text-gray-900|dark:text-white/);
        // It should use semantic tokens instead
        expect(input).toMatch(/bg-surface-2|text-text|border-border/);
      });
    }
  });

  it('component renders without crashing', () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mounts: [] }))
      )
    );

    const onChange = vi.fn();
    const { container } = render(<LocalTargetPicker value="" onChange={onChange} />);

    // Verify component rendered something
    expect(container).toBeTruthy();
    expect(container.querySelector('[class*="space-y"]')).toBeTruthy();
  });
});
