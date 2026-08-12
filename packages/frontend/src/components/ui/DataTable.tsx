import { cn } from './cn';

/**
 * <DataTable> — the uniform table primitive (#2075, epic #2071).
 *
 * Replaces the audited 6 tables / 5 header styles (incl. the random
 * per-column colours of the Containers tab — Node purple, ID blue, Image
 * green…) with ONE quiet, consistent header/row/hover/divider story on the
 * surface tokens. Generic over the row type; columns declare a header, a
 * cell renderer, and optional alignment / className.
 */
export interface Column<Row> {
  /** Stable key for React + a11y. */
  key: string;
  header: React.ReactNode;
  /** Cell renderer for a given row. */
  cell: (row: Row, index: number) => React.ReactNode;
  align?: 'left' | 'center' | 'right';
  /** Extra classes applied to BOTH the <th> and the <td> (e.g. width, font-mono). */
  className?: string;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  /** Stable key per row. */
  rowKey: (row: Row, index: number) => string;
  /** Optional per-row click — makes the row a button-like target. */
  onRowClick?: (row: Row, index: number) => void;
  /** Optional per-row className — called with (row, index) to compute the row's className. */
  rowClassName?: (row: Row, index: number) => string;
  /** Shown (spanning all columns) when `rows` is empty. */
  empty?: React.ReactNode;
  /** Classes on the scroll container. */
  className?: string;
  /**
   * Min table width to force horizontal scroll on narrow viewports.
   *
   * Optional — when omitted the table falls back to a **column-count derived
   * default** (see `defaultMinWidth`). Before #2520 this prop had no default
   * and *zero* call-sites set it, which made the `overflow-x-auto` wrapper
   * below dead code everywhere: the table was pinned to `w-full`, so it could
   * never overflow and narrow viewports crushed columns instead of scrolling.
   * Pass an explicit class to override, or `'min-w-0'` to opt out entirely.
   */
  minWidthClassName?: string;
}

/**
 * Per-column floor for the derived default min-width (#2520). Wide enough that
 * a column keeps a readable few words rather than collapsing to one token per
 * line, narrow enough that a small table doesn't grow a spurious scrollbar on a
 * desktop viewport. Capped so a very wide table scrolls rather than exploding.
 */
const MIN_WIDTH_REM_PER_COLUMN = 8;
const MIN_WIDTH_REM_CAP = 64;

/**
 * The table's min-width when the caller didn't specify one: `columns × 8rem`,
 * capped at 64rem. A 3-column table gets 24rem (no scrollbar in a drawer), a
 * 5-column table 40rem, a 7-column table 56rem — each below a typical desktop
 * content width but above a phone's, so the scroll only kicks in where the
 * alternative is crushed columns.
 */
export function defaultMinWidth(columnCount: number): string {
  return `${Math.min(columnCount * MIN_WIDTH_REM_PER_COLUMN, MIN_WIDTH_REM_CAP)}rem`;
}

const alignClass: Record<NonNullable<Column<unknown>['align']>, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function HeaderRow<Row>({ columns }: { columns: Column<Row>[] }) {
  return (
    <tr className="border-b border-border bg-surface-muted">
      {columns.map((col) => (
        <th
          key={col.key}
          scope="col"
          className={cn(
            'px-space-3 py-space-2 text-xs font-semibold uppercase tracking-wide text-text-muted',
            col.align && alignClass[col.align],
            col.className,
          )}
        >
          {col.header}
        </th>
      ))}
    </tr>
  );
}

function BodyRow<Row>({
  columns,
  row,
  index,
  onRowClick,
  rowClassName,
}: {
  columns: Column<Row>[];
  row: Row;
  index: number;
  onRowClick?: (row: Row, index: number) => void;
  rowClassName?: (row: Row, index: number) => string;
}) {
  return (
    <tr
      onClick={onRowClick ? () => onRowClick(row, index) : undefined}
      className={cn(
        'border-b border-border last:border-0 text-text',
        onRowClick && 'cursor-pointer hover:bg-surface-2',
        rowClassName && rowClassName(row, index),
      )}
    >
      {columns.map((col) => (
        <td
          key={col.key}
          // `break-words` (overflow-wrap) — NOT `break-all` (#2520). Both stop a
          // long token overflowing its cell, but `break-all` also drops the
          // cell's min-content width to a single character, so the browser's
          // auto table-layout happily squeezes that column to ~8 chars and hands
          // the width to whichever column has the longest prose. `break-words`
          // leaves min-content at the longest token, so a URL stays readable as
          // a unit and only wraps when it genuinely cannot fit.
          className={cn(
            'px-space-3 py-space-2 break-words',
            col.align && alignClass[col.align],
            col.className,
          )}
        >
          {col.cell(row, index)}
        </td>
      ))}
    </tr>
  );
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowClassName,
  empty = 'No data',
  className,
  minWidthClassName,
}: DataTableProps<Row>) {
  return (
    <div className={cn('overflow-x-auto rounded-card border border-border', className)}>
      <table
        className={cn('w-full text-left text-sm', minWidthClassName)}
        // Only when the caller didn't pass a class — an inline style would win
        // over their Tailwind `min-w-*` utility and silently ignore the override.
        style={minWidthClassName ? undefined : { minWidth: defaultMinWidth(columns.length) }}
      >
        <thead>
          <HeaderRow columns={columns} />
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-space-3 py-space-4 text-center text-sm text-text-subtle"
              >
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <BodyRow
                key={rowKey(row, i)}
                columns={columns}
                row={row}
                index={i}
                onRowClick={onRowClick}
                rowClassName={rowClassName}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

