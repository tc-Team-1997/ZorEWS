import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  width?: number;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
}

export function DataTable<T extends { id: number | string }>({
  columns,
  data,
  onRowClick,
  empty = 'No rows',
}: {
  columns: Column<T>[];
  data: readonly T[];
  onRowClick?: (row: T) => void;
  empty?: string;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-divider bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="table-header">
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={cn(
                  'px-3 py-2 text-[11px] font-semibold text-ink-sub',
                  col.align === 'right' && 'text-right',
                  col.align === 'center' && 'text-center',
                  !col.align && 'text-left',
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-t border-divider',
                  i % 2 === 1 && 'bg-page',
                  onRowClick && 'cursor-pointer hover:bg-brand-skyLight/60',
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      'px-3 py-2 text-ink',
                      col.align === 'right' && 'text-right',
                      col.align === 'center' && 'text-center',
                    )}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
