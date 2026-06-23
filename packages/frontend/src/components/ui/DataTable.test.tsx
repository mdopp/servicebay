import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTable, type Column } from './DataTable';

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
});
