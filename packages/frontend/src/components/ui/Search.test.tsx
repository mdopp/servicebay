import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Search, SEARCH_FIELD_CLASS, SEARCH_INPUT_CLASS, SEARCH_SLOT_CLASS } from './Search';

// #2550: the ONE search field. These pin the three things the seven hand-rolled
// inputs each got wrong in their own way:
//   - the visual language (three different chrome chains for one control),
//   - the semantics (no accessible name, no clear button, no role),
//   - and — the owner's actual complaint — that a field never said what it
//     searched, so a page with two of them was a guessing game.

function Live({ label = 'Search checks', initial = '' }) {
  const [value, setValue] = useState(initial);
  return <Search label={label} value={value} onChange={setValue} />;
}

describe('ui/Search — semantics', () => {
  it('is a real searchbox with an accessible name taken from the scope label', () => {
    render(<Live />);
    expect(screen.getByRole('searchbox', { name: 'Search checks' })).toBeTruthy();
  });

  it('derives the placeholder from the label, so the scope is visible too', () => {
    // Acceptance #4: a user must not have to guess which search they are in.
    render(<Live label="Search containers" />);
    expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe('Search containers…');
  });

  it('lets a caller override the placeholder while the label still names it', () => {
    render(<Search label="Search the map" value="" onChange={() => {}} placeholder="node, service…" />);
    const input = screen.getByRole('searchbox', { name: 'Search the map' });
    expect(input.getAttribute('placeholder')).toBe('node, service…');
  });

  it('reports every keystroke as a plain string, not an event', () => {
    const onChange = vi.fn();
    render(<Search label="Search checks" value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ngin' } });
    expect(onChange).toHaveBeenCalledWith('ngin');
  });

  it('forwards native input props (onFocus/onKeyDown) untouched', () => {
    // SettingsSearch opens its popover on focus and drives ↑/↓/Enter/Esc from
    // onKeyDown — swallowing either here would regress that call site.
    const onFocus = vi.fn();
    const onKeyDown = vi.fn();
    render(<Search label="Search settings" value="" onChange={() => {}} onFocus={onFocus} onKeyDown={onKeyDown} />);
    const input = screen.getByRole('searchbox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onFocus).toHaveBeenCalled();
    expect(onKeyDown).toHaveBeenCalled();
  });

  it('renders children inside the wrapper, so a results popover can anchor to it', () => {
    render(
      <Search label="Search settings" value="x" onChange={() => {}}>
        <div data-testid="popover">hits</div>
      </Search>,
    );
    expect(screen.getByTestId('popover')).toBeTruthy();
  });
});

describe('ui/Search — clear button', () => {
  it('appears only once there is something to clear', () => {
    render(<Live />);
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'a' } });
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('names itself after the scope, so it is unambiguous on a multi-search page', () => {
    render(<Live label="Search containers" initial="nginx" />);
    expect(screen.getByRole('button', { name: 'Clear containers' })).toBeTruthy();
  });

  it('clears the query and returns focus to the field', () => {
    render(<Live initial="nginx" />);
    fireEvent.click(screen.getByRole('button'));
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
  });

  it('is type=button so a search inside a <form> cannot submit it', () => {
    render(<Live initial="nginx" />);
    expect((screen.getByRole('button') as HTMLButtonElement).type).toBe('button');
  });
});

describe('ui/Search — presentation contract', () => {
  it('gives every call site the identical chrome — one look, from one string', () => {
    // Acceptance #3: the fields differ in scope, never in appearance. Same class
    // chain ⇒ same pixels, whichever surface renders it.
    const { unmount } = render(<Search label="Search checks" value="" onChange={() => {}} />);
    const a = screen.getByRole('searchbox').className;
    unmount();
    cleanup();
    render(<Search label="Search the catalog" value="" onChange={() => {}} className="w-full" />);
    expect(screen.getByRole('searchbox').className).toBe(a);
    expect(a).toBe(SEARCH_INPUT_CLASS);
  });

  it('uses semantic tokens only — no raw colour literals', () => {
    expect(SEARCH_INPUT_CLASS).not.toMatch(/\b(?:text|bg|border)-(?:blue|gray|slate|zinc)-\d/);
    expect(SEARCH_INPUT_CLASS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(SEARCH_INPUT_CLASS).toContain('bg-surface-2');
    expect(SEARCH_INPUT_CLASS).toContain('border-border');
    expect(SEARCH_INPUT_CLASS).toContain('focus:ring-accent');
  });

  it('imposes no width, margin or flex on the wrapper — the caller owns position', () => {
    // <PageFrame> (#2548) and <Tabs> (#2549) made the same promise; the #2542
    // regression is what happens when a shared wrapper decides layout for its
    // call sites. `min-w-0` IS wanted (the #1992 shrink pattern).
    expect(SEARCH_FIELD_CLASS).not.toMatch(/(?<![-\w])(?:w|max-w|h)-/);
    expect(SEARCH_FIELD_CLASS).not.toMatch(/\b(?:m|mx|my|mt|mb|ml|mr)-/);
    expect(SEARCH_FIELD_CLASS).not.toMatch(/\bflex(?:-|\b)/);
  });

  it('offers the shared PageHeader position as an opt-in constant', () => {
    // "All search fields sit in the same place" is a caller-applied convention,
    // not something the primitive forces on a settings sidebar.
    expect(SEARCH_SLOT_CLASS).toContain('flex-1');
    expect(SEARCH_SLOT_CLASS).toContain('max-w-md');
  });

  it('lets the caller add position without losing the field chrome', () => {
    render(<Search label="Search checks" value="" onChange={() => {}} className={SEARCH_SLOT_CLASS} />);
    const wrapper = screen.getByRole('searchbox').parentElement?.parentElement;
    expect(wrapper?.className).toContain('max-w-md');
    expect(wrapper?.className).toContain('relative');
  });

  it('reserves the clear-button gutter so text does not reflow when it appears', () => {
    expect(SEARCH_INPUT_CLASS).toContain('pr-9');
    expect(SEARCH_INPUT_CLASS).toContain('pl-9');
  });

  it('hides the WebKit cancel button so there is only ever one clear affordance', () => {
    expect(SEARCH_INPUT_CLASS).toContain('[&::-webkit-search-cancel-button]:hidden');
  });
});
