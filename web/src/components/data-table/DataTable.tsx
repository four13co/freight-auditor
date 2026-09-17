import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  /** Omit for a column that shouldn't be sortable (e.g. an actions column). */
  sortValue?: (row: T) => string | number;
  render: (row: T) => ReactNode;
  className?: string;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: DataTableColumn<T>[];
  getRowId: (row: T) => string;
  /** Search box; omitted entirely when not provided. */
  searchPlaceholder?: string;
  searchPredicate?: (row: T, query: string) => boolean;
  /** Extra toolbar content (filters, create button) rendered to the right of search. */
  toolbarEnd?: ReactNode;
  emptyState?: ReactNode;
  pageSize?: number;
  isLoading?: boolean;
}

type SortDirection = 'asc' | 'desc';

/**
 * Shared shadcn-table shell: search + sort + client-side pagination. Every
 * data source in this epic (Users 86e3a6rde, Clients/Grand
 * Clients/Vendors 86e3a6re6/ren/rf3, Rules & Rates 86e3a6rg1) fetches from a
 * real-but-not-server-paginated-across-the-whole-set endpoint, so this
 * table's own pagination/sort/filter is intentionally client-side over
 * whatever rows the page fetched -- see each page's own Uncertainties for
 * exactly which AC branch that satisfies vs. leaves as a documented gap.
 */
export function DataTable<T>({
  rows,
  columns,
  getRowId,
  searchPlaceholder,
  searchPredicate,
  toolbarEnd,
  emptyState,
  pageSize = 10,
  isLoading = false,
}: DataTableProps<T>) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!query || !searchPredicate) return rows;
    return rows.filter((row) => searchPredicate(row, query));
  }, [rows, query, searchPredicate]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return filtered;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = column.sortValue!(a);
      const bv = column.sortValue!(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  function toggleSort(key: string) {
    setSort((prev) => {
      if (prev?.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
    setPage(0);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {searchPredicate && (
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder={searchPlaceholder ?? 'Search…'}
            className="sm:max-w-xs"
            aria-label={searchPlaceholder ?? 'Search'}
          />
        )}
        {toolbarEnd && <div className="flex items-center gap-2">{toolbarEnd}</div>}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.className}>
                {column.sortValue ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    className="inline-flex items-center gap-1 font-medium"
                  >
                    {column.header}
                    {sort?.key === column.key ? (
                      sort.direction === 'asc' ? (
                        <ArrowUp className="size-3.5" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="size-3.5" aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  column.header
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-sm text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : pageRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-sm text-muted-foreground">
                {emptyState ?? 'No results.'}
              </TableCell>
            </TableRow>
          ) : (
            pageRows.map((row) => (
              <TableRow key={getRowId(row)}>
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.className}>
                    {column.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {sorted.length > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {clampedPage + 1} of {pageCount} ({sorted.length} total)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={clampedPage >= pageCount - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
