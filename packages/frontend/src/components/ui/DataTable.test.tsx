import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTable, defaultMinWidth, type Column } from './DataTable';

interface Row {
  id: string;
  name: string;
}
const columns: Column<Row>[] = [
  { key: 'id', header: 'ID', cell: (r) => r.id, className: 'font-mono' },
  { key: 'name', header: 'Name', cell: (r) => r.name, align: 'right' },
];
const rows: Row[] = [
  { id: 'a1', name: 'alpha' },
  { id: 'b2', name: 'beta' },
];

describe('ui/DataTable', () => {
  it('renders a uniform token header and one row per item', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['ID', 'Name']);
    // header uses the muted token, not an ad-hoc per-column color
    expect(headers[0].className).toContain('text-text-muted');
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('beta')).toBeDefined();
  });

  it('applies per-column className and alignment to header and cell', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByText('a1').className).toContain('font-mono');
    expect(screen.getByText('alpha').className).toContain('text-right');
  });

  it('fires onRowClick with the row', () => {
    const onRowClick = vi.fn();
    render(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    fireEvent.click(screen.getByText('alpha'));
    expect(onRowClick).toHaveBeenCalledWith(rows[0], 0);
  });

  it('renders the empty state spanning all columns', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} empty="Nothing here" />);
    const cell = screen.getByText('Nothing here');
    expect(cell.getAttribute('colspan')).toBe('2');
  });

  // #2520 — the credentials table crushed its URL column to ~8 characters and
  // broke `https://nginx.dopp.cloud` into "http/s://ngi/nx.dop/p.cloud", while
  // Notes took half the table. Two root causes, both fixed in the primitive.
  describe('column widths and wrapping (#2520)', () => {
    it('wraps cells with break-words, never break-all', () => {
      render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
      const cell = screen.getByText('a1');
      // `break-all` drops a cell's min-content width to ONE character, which is
      // what let auto table-layout squeeze the URL column to nothing. The
      // primitive must never ship it as a default.
      expect(cell.className).toContain('break-words');
      expect(cell.className).not.toContain('break-all');
    });

    it('gives the table a column-count derived min-width so overflow-x-auto can fire', () => {
      render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
      // Before the fix the table was pinned to w-full with no floor, so the
      // scroll container could never overflow and columns crushed instead.
      expect(screen.getByRole('table').style.minWidth).toBe(defaultMinWidth(2));
    });

    it('scales the default min-width with the column count and caps it', () => {
      expect(defaultMinWidth(3)).toBe('24rem');
      expect(defaultMinWidth(5)).toBe('40rem');
      expect(defaultMinWidth(7)).toBe('56rem');
      // Capped, so a very wide table scrolls rather than forcing an absurd floor.
      expect(defaultMinWidth(20)).toBe('64rem');
    });

    it('lets a caller override the min-width without the inline default winning', () => {
      render(
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          minWidthClassName="min-w-[80rem]"
        />,
      );
      const table = screen.getByRole('table');
      expect(table.className).toContain('min-w-[80rem]');
      // An inline style beats a Tailwind utility — emitting both would silently
      // ignore the caller's override.
      expect(table.style.minWidth).toBe('');
    });

    it('applies a column width class to both the header and the cell', () => {
      const sized: Column<Row>[] = [
        { key: 'id', header: 'ID', cell: (r) => r.id, className: 'w-[28%]' },
        { key: 'name', header: 'Name', cell: (r) => r.name, className: 'w-[22%]' },
      ];
      render(<DataTable columns={sized} rows={rows} rowKey={(r) => r.id} />);
      // Width lives on <th> AND <td> so the browser can't hand the spare width
      // to whichever column happens to hold the longest prose.
      expect(screen.getByRole('columnheader', { name: 'ID' }).className).toContain('w-[28%]');
      expect(screen.getByText('a1').className).toContain('w-[28%]');
    });
  });
});
