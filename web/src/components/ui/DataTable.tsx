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
  focusRowId,
}: {
  columns: Column<T>[];
  data: readonly T[];
  onRowClick?: (row: T) => void;
  empty?: string;
  /**
   * When set, the matching row gets `data-focus-row="true"` + a 2s
   * yellow flash so callers can `?focus=<id>` deep-link into a row.
   * The caller is responsible for scrollIntoView (typical pattern:
   * useEffect → document.querySelector('[data-focus-row]')).
   */
  focusRowId?: number | string | null;
}) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-aurora-line bg-white shadow-sm">
      {/* Inner layer scrolls horizontally below the table's natural min-width so
          wide tables stay reachable on narrow viewports instead of being clipped
          by the rounded border container. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="bg-aurora-canvas border-b border-aurora-line">
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={cn(
                  'px-3 py-2.5 text-[11px] font-semibold text-aurora-ink-sub uppercase tracking-wide',
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
            data.map((row) => {
              const isFocus = focusRowId !== undefined && focusRowId !== null && row.id === focusRowId;
              return (
              <tr
                key={row.id}
                data-row-id={row.id}
                {...(isFocus ? { 'data-focus-row': 'true' } : {})}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-t border-aurora-line/60 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-aurora-tint/50',
                  isFocus && 'bg-amber-100 ring-1 ring-amber-300',
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
              );
            })
          )}
        </tbody>
        </table>
      </div>
    </div>
  );
}
