import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';

interface Row {
  id: string;
  name: string;
  age: number;
}

const ROWS: Row[] = [
  { id: '1', name: 'Charlie', age: 40 },
  { id: '2', name: 'Alice', age: 30 },
  { id: '3', name: 'Bob', age: 20 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', sortValue: (r) => r.name, render: (r) => r.name },
  { key: 'age', header: 'Age', sortValue: (r) => r.age, render: (r) => String(r.age) },
];

describe('DataTable', () => {
  it('renders every row by default', () => {
    render(<DataTable rows={ROWS} columns={COLUMNS} getRowId={(r) => r.id} />);
    expect(screen.getByText('Charlie')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('sorts ascending then descending then back to unsorted on repeated header clicks', async () => {
    const user = userEvent.setup();
    render(<DataTable rows={ROWS} columns={COLUMNS} getRowId={(r) => r.id} />);

    const rowsInOrder = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);

    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(rowsInOrder()).toEqual(['Alice', 'Bob', 'Charlie']);

    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(rowsInOrder()).toEqual(['Charlie', 'Bob', 'Alice']);

    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(rowsInOrder()).toEqual(['Charlie', 'Alice', 'Bob']);
  });

  it('filters rows via searchPredicate', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        rows={ROWS}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        searchPlaceholder="Search…"
        searchPredicate={(r, q) => r.name.toLowerCase().includes(q.toLowerCase())}
      />,
    );

    await user.type(screen.getByPlaceholderText('Search…'), 'ali');

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    expect(screen.queryByText('Charlie')).not.toBeInTheDocument();
  });

  it('paginates and Next/Previous are disabled at the bounds', async () => {
    const user = userEvent.setup();
    render(<DataTable rows={ROWS} columns={COLUMNS} getRowId={(r) => r.id} pageSize={2} />);

    expect(screen.getByText('Page 1 of 2 (3 total)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('Page 2 of 2 (3 total)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('shows a loading state and an empty state', () => {
    const { rerender } = render(<DataTable rows={[]} columns={COLUMNS} getRowId={(r) => r.id} isLoading />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    rerender(<DataTable rows={[]} columns={COLUMNS} getRowId={(r) => r.id} emptyState="Nothing here yet." />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });
});
