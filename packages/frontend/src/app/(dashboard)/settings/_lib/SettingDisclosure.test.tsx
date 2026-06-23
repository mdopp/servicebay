/**
 * SettingDisclosure design-system migration (#2079). The advanced disclosure —
 * the shared chrome every settings group page composes — now renders on the
 * <Card> primitive + semantic tokens (no raw gray-200/gray-700 literals), while
 * keeping the essential=flat / advanced=collapsed behaviour and the deep-link
 * auto-expand.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SettingDisclosure from './SettingDisclosure';

describe('SettingDisclosure (#2079 primitive migration)', () => {
  it('renders an essential setting open and flat (no advanced toggle)', () => {
    render(
      <SettingDisclosure id="creds" tier="essential" label="Credentials">
        <p>secret body</p>
      </SettingDisclosure>,
    );
    expect(screen.getByText('secret body')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('collapses an advanced setting behind a toggle on a token Card surface', () => {
    const { container } = render(
      <SettingDisclosure id="mcp" tier="advanced" label="MCP access">
        <p>advanced body</p>
      </SettingDisclosure>,
    );
    const toggle = screen.getByRole('button', { name: /MCP access/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('advanced body')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('advanced body')).toBeDefined();

    // Card surface + token chrome, no raw gray literals.
    expect(container.querySelector('.bg-surface')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/(bg|text|border)-gray-\d/);
  });
});
