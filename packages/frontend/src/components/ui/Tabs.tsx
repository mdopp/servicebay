'use client';

import { useRef, type ElementType, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

/**
 * <Tabs> — the ONE tab strip (#2549, child of the #2546 shell epic).
 *
 * Six strips were hand-built, in two visual languages and with no shared
 * semantics:
 *   - underline: Settings (`border-status-info`), Status/HealthDashboard,
 *     the per-service Operate page, the wizard's Configure strip (`border-accent`)
 *   - folder tab: ServiceForm and ServiceMonitor — a filled `bg-surface` cell
 *     with a `border-t-2` cap.
 * Same control, two looks, and (in the folder-tab pair) a `<Button>` fighting
 * its own base geometry with `!h-auto !px-6`.
 *
 * CONVERGED ON THE UNDERLINE, on the `accent` token. Why underline: it was
 * already 4 of the 6 strips, it needs no fill so it works on any background,
 * and the folder-tab look only reads correctly when the strip is welded to the
 * top edge of a card (which is why the two that used it are both inside cards
 * and neither could be reused anywhere else). Why `accent` and not
 * `status-info`: `status-info` is the *informational status* colour (an info
 * banner), and Settings was the only surface borrowing it for chrome.
 *
 * ACCESSIBILITY IS PART OF THE PRIMITIVE, not an add-on — not one of the six
 * hand-rolled strips had `role="tab"`, `aria-selected`, or arrow keys. Two
 * modes, because the two kinds of "tab" are genuinely different controls:
 *
 *  - **panel mode** (default, `onChange`): the APG tabs pattern — `role=tablist`
 *    / `role=tab` / `aria-selected`, roving `tabindex` (only the active tab is a
 *    tab stop), Left/Right/Home/End move *and* select (automatic activation),
 *    and `aria-controls` wired to the panel via {@link tabPanelProps}.
 *  - **nav mode** (items carry `href`): a `<nav>` of links with
 *    `aria-current="page"`. Deliberately NOT `role=tab`: Settings' "panels" are
 *    routed pages, so there is no tabpanel in the DOM to put in `aria-controls`,
 *    and arrow-key roving would break the browser's own link semantics. The
 *    look is identical; only the semantics differ, because the control does.
 *
 * WHAT IT DELIBERATELY DOES NOT IMPOSE (the #2542 / #2484 lesson — a shared
 * primitive that quietly carries layout defaults is how the sidebar inherited
 * `justify-center` and how five migrated buttons silently changed size):
 *   - it renders a raw `<button>`, NOT `<Button>`, so there is no height,
 *     padding or `justify-*` default to fight. The two folder-tab call sites
 *     were already fighting exactly that with `!h-auto !px-6`;
 *   - no margin, no width, no background on the strip — the caller's `className`
 *     keeps chrome (`px-2`, `bg-surface-muted`, `sticky top-0`) under its own
 *     control, exactly as <PageFrame> (#2548) leaves padding to its callers.
 *
 * The strip carries the #1992 overflow pattern (`min-w-0 overflow-x-auto
 * no-scrollbar` + `shrink-0` items) so it scrolls instead of overflowing at
 * 480px.
 */

/** Lucide-shaped icon component (`<Icon size={16} />`). */
export type TabIcon = ElementType<{ size?: number | string; className?: string }>;

export interface TabItem<Id extends string = string> {
  id: Id;
  label: ReactNode;
  /** Optional leading icon — Settings/Operate/ServiceForm use one, Status does not. */
  icon?: TabIcon;
  /** Optional trailing count chip (the wizard's per-tab variable counts). */
  count?: number;
  /** Present ⇒ nav mode: this tab navigates instead of swapping a panel. */
  href?: string;
  /** Native tooltip (Settings shows each group's intent). */
  title?: string;
}

export interface TabsProps<Id extends string = string> {
  items: readonly TabItem<Id>[];
  /** The active tab's id. */
  value: Id;
  /** Panel mode only. Omit when items carry `href`. */
  onChange?: (id: Id) => void;
  /** Accessible name for the strip (`aria-label` on the tablist / nav). */
  label: string;
  /**
   * Panel mode only: id prefix wiring each tab to its panel. Pass the SAME
   * value to {@link tabPanelProps} on the panel container.
   */
  idBase?: string;
  /**
   * Nav mode only: the link component to render (`next/link`). Defaults to a
   * plain `<a>` so this primitive stays framework-free.
   */
  linkComponent?: ElementType;
  /** Extra classes for the strip itself (chrome the caller owns). */
  className?: string;
}

/** The strip. No background, no padding, no margin — chrome is the caller's. */
export const TABS_STRIP_CLASS =
  'flex items-center gap-1 border-b border-border min-w-0 overflow-x-auto no-scrollbar';

/** One tab, in either mode. Identical in both — that is the point of the unit. */
export const TAB_CLASS =
  'shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium ' +
  'border-b-2 whitespace-nowrap transition-colors bg-transparent cursor-pointer ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset';

export const TAB_ACTIVE_CLASS = 'border-accent text-accent';

export const TAB_INACTIVE_CLASS =
  'border-transparent text-text-muted hover:text-text hover:border-border';

/** `id`/`aria-labelledby` for a tab's panel container. Pair with `idBase`. */
export function tabPanelProps(idBase: string, id: string) {
  return {
    id: `${idBase}-panel-${id}`,
    role: 'tabpanel' as const,
    'aria-labelledby': `${idBase}-tab-${id}`,
  };
}

function TabBody({ item }: { item: TabItem }) {
  const Icon = item.icon;
  return (
    <>
      {Icon ? <Icon size={16} /> : null}
      {item.label}
      {item.count === undefined ? null : (
        <span className="px-1.5 py-0.5 rounded-full bg-surface-2 text-[10px] opacity-70">
          {item.count}
        </span>
      )}
    </>
  );
}

export function Tabs<Id extends string = string>({
  items,
  value,
  onChange,
  label,
  idBase,
  linkComponent,
  className,
}: TabsProps<Id>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const isNav = items.some(item => item.href !== undefined);

  if (isNav) {
    const Link: ElementType = linkComponent ?? 'a';
    return (
      <nav aria-label={label} className={cn(TABS_STRIP_CLASS, className)}>
        {items.map(item => {
          const active = item.id === value;
          return (
            <Link
              key={item.id}
              href={item.href}
              title={item.title}
              // Nav mode: the "panel" is a routed page, so `aria-current="page"`
              // is the correct statement, not `aria-selected` on a fake tab.
              aria-current={active ? 'page' : undefined}
              className={cn(TAB_CLASS, active ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS)}
            >
              <TabBody item={item} />
            </Link>
          );
        })}
      </nav>
    );
  }

  const move = (from: number, delta: number) => {
    const next = (from + delta + items.length) % items.length;
    onChange?.(items[next].id);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Automatic activation (APG's default for cheap panels): arrowing moves
    // focus AND selection, so a screen-reader user hears the panel they landed
    // on rather than having to press Enter.
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        move(index, -index);
        break;
      case 'End':
        event.preventDefault();
        move(index, items.length - 1 - index);
        break;
      default:
        break;
    }
  };

  return (
    <div role="tablist" aria-label={label} className={cn(TABS_STRIP_CLASS, className)}>
      {items.map((item, index) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={idBase ? `${idBase}-tab-${item.id}` : undefined}
            aria-selected={active}
            aria-controls={idBase ? `${idBase}-panel-${item.id}` : undefined}
            // Roving tabindex: the strip is ONE tab stop; arrows move within it.
            tabIndex={active ? 0 : -1}
            title={item.title}
            ref={el => {
              refs.current[index] = el;
            }}
            onClick={() => onChange?.(item.id)}
            onKeyDown={event => onKeyDown(event, index)}
            className={cn(TAB_CLASS, active ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS)}
          >
            <TabBody item={item} />
          </button>
        );
      })}
    </div>
  );
}
