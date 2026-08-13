import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  Tabs,
  tabPanelProps,
  TAB_CLASS,
  TABS_STRIP_CLASS,
  TAB_ACTIVE_CLASS,
  type TabItem,
} from './Tabs';

// #2549: the ONE tab strip. These pin three things the six hand-rolled strips
// each got wrong in their own way:
//   - the visual language (one active-tab treatment, on the accent token),
//   - the a11y semantics (tablist/tab/aria-selected + arrow keys; none of the
//     six had any of it),
//   - what the primitive must NOT impose on its call sites (the #2542/#2484
//     footgun — Button's base class silently supplying justify-center/h-10).

const ITEMS: TabItem<'a' | 'b' | 'c'>[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
];

function Panelled({ value = 'a' as 'a' | 'b' | 'c' }) {
  return (
    <>
      <Tabs label="Views" idBase="demo" value={value} items={ITEMS} onChange={() => {}} />
      <div {...tabPanelProps('demo', value)}>panel body</div>
    </>
  );
}

describe('ui/Tabs — semantics', () => {
  it('is a real tablist: role=tab + aria-selected on every tab', () => {
    render(<Panelled value="b" />);
    expect(screen.getByRole('tablist', { name: 'Views' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(t => t.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });

  it('uses a roving tabindex — the strip is ONE tab stop, not N', () => {
    render(<Panelled value="b" />);
    expect(screen.getAllByRole('tab').map(t => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('wires each tab to its panel with aria-controls/aria-labelledby', () => {
    render(<Panelled value="b" />);
    const active = screen.getByRole('tab', { selected: true });
    const panel = screen.getByRole('tabpanel');
    expect(active.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(active.id);
    // The name a screen reader announces for the panel comes from its tab.
    expect(screen.getByRole('tabpanel', { name: 'Beta' })).toBeTruthy();
  });

  it('renders <button type="button"> so a tab inside a <form> cannot submit it', () => {
    // ServiceForm's strip lives inside the service <form>; a bare <button>
    // there defaults to type="submit".
    render(<Panelled />);
    for (const tab of screen.getAllByRole('tab')) {
      expect((tab as HTMLButtonElement).type).toBe('button');
    }
  });
});

describe('ui/Tabs — keyboard', () => {
  const arrowCase = (key: string, from: 'a' | 'b' | 'c', expected: string) =>
    it(`${key} from ${from} selects ${expected}`, () => {
      const onChange = vi.fn();
      render(<Tabs label="Views" value={from} items={ITEMS} onChange={onChange} />);
      fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key });
      expect(onChange).toHaveBeenCalledWith(expected);
    });

  arrowCase('ArrowRight', 'a', 'b');
  arrowCase('ArrowLeft', 'b', 'a');
  arrowCase('ArrowDown', 'a', 'b');
  arrowCase('ArrowUp', 'b', 'a');
  arrowCase('Home', 'c', 'a');
  arrowCase('End', 'a', 'c');
  // Wrap-around, per the APG tabs pattern.
  arrowCase('ArrowRight', 'c', 'a');
  arrowCase('ArrowLeft', 'a', 'c');

  it('moves focus with the selection so the arrowed-to tab is where you are', () => {
    function Live() {
      const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
      return <Tabs label="Views" value={value} items={ITEMS} onChange={setValue} />;
    }
    render(<Live />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha' }), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Beta' }));
  });

  it('leaves other keys to the browser', () => {
    const onChange = vi.fn();
    render(<Tabs label="Views" value="a" items={ITEMS} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects on click', () => {
    const onChange = vi.fn();
    render(<Tabs label="Views" value="a" items={ITEMS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Gamma' }));
    expect(onChange).toHaveBeenCalledWith('c');
  });
});

describe('ui/Tabs — nav mode (routed panels)', () => {
  const NAV: TabItem[] = [
    { id: 'x', label: 'Network', href: '/settings/x', title: 'reachable' },
    { id: 'y', label: 'Access', href: '/settings/y' },
  ];

  it('renders links with aria-current, NOT a fake tablist', () => {
    render(<Tabs label="Settings groups" value="y" items={NAV} />);
    // The panels are routed pages; there is no tabpanel to point aria-controls
    // at, so claiming role=tab would be a lie to a screen reader.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('navigation', { name: 'Settings groups' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Access' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Network' }).getAttribute('aria-current')).toBeNull();
  });

  it('renders the caller-supplied link component so client-side routing survives', () => {
    const Link = ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
      <a href={href} data-next-link="1" {...rest}>{children}</a>
    );
    render(<Tabs label="Settings groups" value="x" items={NAV} linkComponent={Link} />);
    expect(screen.getByRole('link', { name: 'Network' }).getAttribute('data-next-link')).toBe('1');
  });

  it('looks IDENTICAL to panel mode — the two differ only in semantics', () => {
    // Acceptance #3: the active tab must look the same on Settings (nav) and
    // Status (panel). Same class chain ⇒ same pixels.
    const { unmount } = render(<Tabs label="n" value="x" items={NAV} />);
    const navActive = screen.getByRole('link', { name: 'Network' }).className;
    const navStrip = screen.getByRole('navigation').className;
    unmount();
    render(<Tabs label="p" value="a" items={ITEMS} onChange={() => {}} />);
    expect(screen.getByRole('tab', { selected: true }).className).toBe(navActive);
    expect(screen.getByRole('tablist').className).toBe(navStrip);
    expect(navActive).toContain('border-accent');
    expect(navActive).toContain('text-accent');
  });
});

describe('ui/Tabs — presentation contract', () => {
  it('marks the active tab on the accent token only, no raw colours', () => {
    expect(TAB_ACTIVE_CLASS).toBe('border-accent text-accent');
    expect(TAB_CLASS).not.toMatch(/\b(?:text|bg|border)-(?:blue|gray|slate|zinc)-\d/);
    expect(TAB_CLASS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('carries the #1992 overflow pattern so 480px scrolls instead of overflowing', () => {
    expect(TABS_STRIP_CLASS).toContain('min-w-0');
    expect(TABS_STRIP_CLASS).toContain('overflow-x-auto');
    expect(TABS_STRIP_CLASS).toContain('no-scrollbar');
    expect(TAB_CLASS).toContain('shrink-0');
    expect(TAB_CLASS).toContain('whitespace-nowrap');
  });

  it('imposes no chrome the caller owns — no bg, margin, width or sticky', () => {
    // <PageFrame> (#2548) made the same promise; the #2542 regression is what
    // happens when a shared wrapper quietly decides layout for its call sites.
    expect(TABS_STRIP_CLASS).not.toMatch(/\bbg-(?!transparent)/);
    expect(TABS_STRIP_CLASS).not.toMatch(/\b(?:m|mx|my|mt|mb|ml|mr)-/);
    expect(TABS_STRIP_CLASS).not.toMatch(/\b(?:px|py|p)-/);
    expect(TABS_STRIP_CLASS).not.toMatch(/\b(?:sticky|fixed|absolute)\b/);
    // `min-w-0` IS wanted (the #1992 shrink pattern) — this forbids an outright
    // width/height, so the lookbehind keeps `min-w-` out of the match.
    expect(TABS_STRIP_CLASS).not.toMatch(/(?<![-\w])(?:w|max-w|h)-/);
  });

  it('carries no Button geometry — the strip cannot inherit h-10/justify-center', () => {
    // ServiceMonitor + ServiceForm had to write `!h-auto !px-6` to escape
    // <Button>'s base class (#2484). A raw <button> has nothing to escape.
    expect(TAB_CLASS).not.toMatch(/\bjustify-center\b/);
    expect(TAB_CLASS).not.toMatch(/\bh-\d/);
    expect(TAB_CLASS).not.toMatch(/!/);
  });

  it('lets the caller add chrome without losing the strip', () => {
    render(
      <Tabs label="Views" value="a" items={ITEMS} onChange={() => {}} className="px-2 bg-surface sticky" />,
    );
    const strip = screen.getByRole('tablist');
    expect(strip.className).toContain('px-2');
    expect(strip.className).toContain('bg-surface');
    expect(strip.className).toContain('border-b');
  });

  it('renders an optional icon and count chip', () => {
    const Icon = ({ size }: { size?: number | string }) => <svg data-testid="icon" width={size} />;
    render(
      <Tabs
        label="Views"
        value="a"
        onChange={() => {}}
        items={[{ id: 'a', label: 'Ports', icon: Icon, count: 3 }]}
      />,
    );
    expect(screen.getByTestId('icon')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Ports\s*3/ })).toBeTruthy();
  });
});
