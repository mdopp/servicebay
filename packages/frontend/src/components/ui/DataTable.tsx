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
  /** Shown (spanning all columns) when `rows` is empty. */
  empty?: React.ReactNode;
  /** Classes on the scroll container. */
  className?: string;
  /** Min table width to force horizontal scroll on narrow viewports. */
  minWidthClassName?: string;
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
}: {
  columns: Column<Row>[];
  row: Row;
  index: number;
  onRowClick?: (row: Row, index: number) => void;
}) {
  return (
    <tr
      onClick={onRowClick ? () => onRowClick(row, index) : undefined}
      className={cn(
        'border-b border-border last:border-0 text-text',
        onRowClick && 'cursor-pointer hover:bg-surface-2',
      )}
    >
      {columns.map((col) => (
        <td
          key={col.key}
          className={cn('px-space-3 py-space-2', col.align && alignClass[col.align], col.className)}
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
  empty = 'No data',
  className,
  minWidthClassName,
}: DataTableProps<Row>) {
  return (
    <div className={cn('overflow-x-auto rounded-card border border-border', className)}>
      <table className={cn('w-full text-left text-sm', minWidthClassName)}>
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
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

