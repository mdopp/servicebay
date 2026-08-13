'use client';

import { Search as SearchIcon, X } from 'lucide-react';
import { useRef, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { cn } from './cn';

/**
 * <Search> — the ONE search field (#2550, child of the #2546 shell epic).
 *
 * `components/ui/` had no search at all, so seven surfaces hand-built one, in
 * three different looks (`rounded-card`+`bg-surface-2`, `rounded-lg`+`bg-surface`,
 * and a `size={14}` icon at `pl-8`), with four different labels for the same
 * control ("Search…", "Search containers…", "Search the catalog", "Search
 * settings…"). Same control, no shared semantics, and — because two of them
 * sat on one page — no way for the operator to tell what any of them searched.
 *
 * OWNER DECISION (#2550, 2026-08-13): **one search per tab, not one per page.**
 * The scopes stay separate; the presentation does not. So the primitive's job is
 * to make every field look identical, sit in the same place, and *say what it
 * searches* — which is why {@link SearchProps.label} is required and doubles as
 * the placeholder. There is no way to render this component without naming its
 * scope.
 *
 * ACCESSIBILITY IS PART OF THE PRIMITIVE: `type="search"` (⇒ `role=searchbox`),
 * a real `aria-label` rather than a placeholder standing in for one (five of the
 * seven had no accessible name at all), and a keyboard-reachable clear button
 * that returns focus to the field.
 *
 * WHAT IT DELIBERATELY DOES NOT IMPOSE (the #2542/#2484 lesson that <PageFrame>
 * (#2548) and <Tabs> (#2549) both encode):
 *   - it renders a raw `<input>`, NOT `<Input>`, so there is no wrapper between
 *     the caller's props and the DOM node;
 *   - no width, no margin, no `flex-*` on the wrapper. Where the field sits is
 *     the caller's business. The *shared* position is an opt-in export,
 *     {@link SEARCH_SLOT_CLASS} — pass it and you get the PageHeader convention
 *     (`max-w-md`, kept deliberately in #2548); don't and nothing is decided
 *     for you.
 *
 * Escape is deliberately NOT handled here: SettingsSearch uses it to close its
 * results popover, so swallowing it in the primitive would regress that call
 * site. `onKeyDown` is forwarded untouched.
 */

/** Positioning context for the optional popover. Carries no width. */
export const SEARCH_FIELD_CLASS = 'relative min-w-0';

/**
 * The shared *position* for a search in a `<PageHeader>` — opt-in, passed by the
 * caller as `className`. This is the one place the `max-w-md` reading measure is
 * written down; #2548 kept it deliberately (it bounds one element, not the page).
 */
export const SEARCH_SLOT_CLASS = 'flex-1 min-w-0 max-w-md';

/**
 * The shared *look*. `pr-9` reserves the clear button's gutter unconditionally so
 * the text does not reflow when the button appears.
 */
export const SEARCH_INPUT_CLASS =
  'w-full pl-9 pr-9 py-2 text-sm rounded-card border border-border bg-surface-2 ' +
  'text-text placeholder:text-text-subtle focus:ring-2 focus:ring-accent outline-none ' +
  // We render our own clear button; WebKit's would be a second one.
  '[&::-webkit-search-cancel-button]:hidden';

export interface SearchProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'type' | 'className' | 'placeholder' | 'children'
  > {
  /**
   * What this field searches, as an imperative phrase: `"Search checks"`,
   * `"Search containers"`. Becomes the accessible name and (with an ellipsis)
   * the placeholder. Required — naming the scope IS the fix.
   */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Override the derived `${label}…` placeholder. The `label` still names it. */
  placeholder?: string;
  /** Wrapper classes — position and width the caller owns. */
  className?: string;
  /** Ref to the wrapper (SettingsSearch closes its popover on outside click). */
  containerRef?: Ref<HTMLDivElement>;
  /** Rendered inside the wrapper, below the field — e.g. a results popover. */
  children?: ReactNode;
}

export function Search({
  label,
  value,
  onChange,
  placeholder,
  className,
  containerRef,
  children,
  ...rest
}: SearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div ref={containerRef} className={cn(SEARCH_FIELD_CLASS, className)}>
      {/* Inner box so the icon/clear button centre on the FIELD, not on the
          wrapper — whose height grows when a popover is passed as children. */}
      <div className="relative">
        <SearchIcon
          size={16}
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle pointer-events-none"
        />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder ?? `${label}…`}
          aria-label={label}
          className={SEARCH_INPUT_CLASS}
          {...rest}
        />
        {value !== '' && (
          <button
            type="button"
            // Named after the scope too, so a screen-reader user knows *which*
            // of the page's searches this one clears.
            aria-label={`Clear ${label.replace(/^search\s+/i, '') || 'search'}`}
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-text-subtle hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
