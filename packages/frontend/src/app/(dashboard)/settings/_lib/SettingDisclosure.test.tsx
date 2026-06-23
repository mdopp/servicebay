/**
 * SettingDisclosure design-system migration (#2079). The advanced disclosure —
 * the shared chrome every settings group page composes — now renders on the
 * <Card> primitive + semantic tokens (no raw gray-200/gray-700 literals), while
 * keeping the essential=flat / advanced=collapsed behaviour and the deep-link
 * auto-expand.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Users } from 'lucide-react';
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

// #2109 — the disclosure section IS the single container + title: icon, title
// and one-line description live in this header (the box-in-box / duplicate-
// title inner Card is gone). The section body holds the controls directly.
describe('SettingDisclosure (#2109 single container)', () => {
  it('carries the icon + title + description in the header, content directly in the body', () => {
    render(
      <SettingDisclosure
        id="portal-access"
        tier="essential"
        label="Portal access"
        icon={Users}
        description="Limits for the family portal."
      >
        <input aria-label="Maximum users" />
      </SettingDisclosure>,
    );
    // Header carries the title + description...
    const title = screen.getByText('Portal access');
    expect(title.tagName).toBe('H3');
    expect(screen.getByText('Limits for the family portal.')).toBeDefined();
    // ...and an icon chip (lucide renders an <svg>).
    expect(title.closest('h3')?.parentElement?.parentElement?.querySelector('svg')).not.toBeNull();
    // The control is rendered directly in the single body.
    expect(screen.getByLabelText('Maximum users')).toBeDefined();
  });

  it('exposes exactly ONE container Card (no nested box-in-box) for an essential section', () => {
    const { container } = render(
      <SettingDisclosure id="x" tier="essential" label="Server identity" icon={Users} description="d">
        <button>Save</button>
      </SettingDisclosure>,
    );
    // The single surface is the disclosure Card itself; the section content
    // contributes no second bordered Card (no rounded-card border wrapper).
    const cards = container.querySelectorAll('.rounded-card.border');
    expect(cards.length).toBe(1);
  });

  it('advanced section: a single header toggle owns the title; one container only', () => {
    const { container } = render(
      <SettingDisclosure id="mcp" tier="advanced" label="MCP access" icon={Users} description="d">
        <p>body</p>
      </SettingDisclosure>,
    );
    // One title, in the toggle button; no duplicate title text anywhere.
    expect(screen.getAllByText('MCP access')).toHaveLength(1);
    expect(screen.getByText('Advanced')).toBeDefined();
    // Closed → no body; single Card container.
    expect(screen.queryByText('body')).toBeNull();
    expect(container.querySelectorAll('.rounded-card.border').length).toBe(1);
  });
});
