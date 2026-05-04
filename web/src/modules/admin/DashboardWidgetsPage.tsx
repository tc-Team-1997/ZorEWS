// web/src/modules/admin/DashboardWidgetsPage.tsx
//
// Admin page for per-role dashboard widget visibility (T4.23,
// BAC-A §3.1.9.1.4). Minimal v1 — checkbox grid + sort-order numeric
// inputs, no drag-and-drop. The real DashboardPage doesn't yet honour
// these settings (refactoring it into a widget catalogue is a separate
// task); this page lets admins curate the config so the contract is in
// place when the dashboard does adopt it.
//
// Per-role widget catalogue is hard-coded here — same set the SPA
// dashboard renders today. Add new entries as new dashboard widgets
// land.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useAuth, type Role } from '@/store/auth';
import { Badge, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';

const ROLES: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Administrator' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'risk_analyst', label: 'Risk analyst' },
  { value: 'collection_officer', label: 'Collection officer' },
  { value: 'field_officer', label: 'Field officer' },
];

// The widget catalogue. Mirrors what DashboardPage renders today; if a
// new widget lands on the dashboard, add it here so admins can toggle it.
const WIDGET_CATALOGUE: Array<{ widget_id: string; label: string; default_visible: boolean }> = [
  { widget_id: 'portfolio_risk', label: 'Portfolio risk customers', default_visible: true },
  { widget_id: 'industry_wise_risk', label: 'Industry-wise risk', default_visible: true },
  { widget_id: 'risk_profile', label: 'Risk profile (top triggers)', default_visible: true },
  { widget_id: 'frequently_breached', label: 'Frequently breached', default_visible: true },
  { widget_id: 'task', label: 'Task widget (My Task / Team Task)', default_visible: true },
  { widget_id: 'kpi_cards', label: 'KPI cards (customers / alerts / cases / SLA)', default_visible: true },
  { widget_id: 'trend_analysis', label: 'Trend analysis', default_visible: true },
];

interface RowState {
  widget_id: string;
  label: string;
  sort_order: number;
  is_visible: boolean;
}

function buildRows(
  saved: Array<{ widget_id: string; sort_order: number; is_visible: boolean }>,
): RowState[] {
  // Merge: catalogue is the source of truth for which widgets EXIST; saved
  // config overrides sort_order + is_visible per widget. New catalogue
  // entries that aren't in the saved config get the catalogue defaults.
  const byId = new Map(saved.map((s) => [s.widget_id, s]));
  return WIDGET_CATALOGUE.map((cat, idx) => {
    const found = byId.get(cat.widget_id);
    return {
      widget_id: cat.widget_id,
      label: cat.label,
      sort_order: found?.sort_order ?? idx + 1,
      is_visible: found ? found.is_visible : cat.default_visible,
    };
  }).sort((a, b) => a.sort_order - b.sort_order);
}

export function DashboardWidgetsPage() {
  const queryClient = useQueryClient();
  const me = useAuth((s) => s.user);
  const getDashboardWidgets = useAuth((s) => s.getDashboardWidgets);
  const putDashboardWidgets = useAuth((s) => s.putDashboardWidgets);
  useChatContext({ page: 'unknown' });

  const [selectedRole, setSelectedRole] = useState<Role>('field_officer');
  const [rows, setRows] = useState<RowState[]>(() => buildRows([]));
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const config = useQuery({
    queryKey: ['dashboard-widgets', selectedRole],
    queryFn: () => getDashboardWidgets(selectedRole),
  });

  // Re-merge rows whenever the saved config changes (role switch or save).
  useEffect(() => {
    if (config.data !== undefined) {
      setRows(buildRows(config.data));
    }
  }, [config.data]);

  const save = useMutation({
    mutationFn: () =>
      putDashboardWidgets(
        selectedRole,
        rows.map((r) => ({
          widget_id: r.widget_id,
          sort_order: r.sort_order,
          is_visible: r.is_visible,
        })),
      ),
    onSuccess: () => {
      setSavedNote(`Saved ${selectedRole} layout at ${new Date().toLocaleTimeString()}`);
      void queryClient.invalidateQueries({ queryKey: ['dashboard-widgets', selectedRole] });
    },
  });

  const visibleCount = useMemo(() => rows.filter((r) => r.is_visible).length, [rows]);

  // RBAC — only admin can use this page.
  const isAdmin = me?.roles?.includes('admin') ?? false;

  return (
    <div>
      <PageHeader
        title="Dashboard widgets"
        subtitle="Per-role widget visibility + ordering · admin only · BAC-A §3.1.9.1.4"
      />

      {!isAdmin && (
        <Panel className="mb-4">
          <div className="p-4 text-sm text-muted">
            Only administrators can edit dashboard widget configuration.
          </div>
        </Panel>
      )}

      <Panel className="mb-4">
        <div className="p-4 flex items-center gap-4">
          <label className="text-sm font-medium" htmlFor="dw-role">Role:</label>
          <select
            id="dw-role"
            data-testid="dw-role-select"
            className="border rounded px-2 py-1 text-sm"
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <Badge tone="blue">{visibleCount} of {rows.length} visible</Badge>
          {savedNote && (
            <span className="text-xs text-success" data-testid="dw-saved-note">
              {savedNote}
            </span>
          )}
        </div>
      </Panel>

      <Panel>
        <table className="w-full text-sm" data-testid="dw-table">
          <thead className="bg-surface-muted text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Widget</th>
              <th className="px-4 py-2 font-medium w-28">Sort order</th>
              <th className="px-4 py-2 font-medium w-24">Visible</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={row.widget_id} className="border-t" data-testid={`dw-row-${row.widget_id}`}>
                <td className="px-4 py-2">
                  <div className="font-medium">{row.label}</div>
                  <div className="text-xs text-muted">{row.widget_id}</div>
                </td>
                <td className="px-4 py-2">
                  <Input
                    type="number"
                    value={row.sort_order}
                    disabled={!isAdmin}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setRows((curr) => {
                        const copy = [...curr];
                        copy[idx] = { ...copy[idx], sort_order: Number.isFinite(n) ? n : 0 };
                        return copy;
                      });
                    }}
                    data-testid={`dw-sort-${row.widget_id}`}
                  />
                </td>
                <td className="px-4 py-2">
                  <input
                    type="checkbox"
                    checked={row.is_visible}
                    disabled={!isAdmin}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setRows((curr) => {
                        const copy = [...curr];
                        copy[idx] = { ...copy[idx], is_visible: v };
                        return copy;
                      });
                    }}
                    data-testid={`dw-visible-${row.widget_id}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="border-t px-4 py-3 flex justify-end gap-2">
          <Button
            variant="primary"
            disabled={!isAdmin || save.isPending}
            onClick={() => save.mutate()}
            data-testid="dw-save"
          >
            <Save className="w-4 h-4 mr-1" />
            {save.isPending ? 'Saving…' : 'Save layout'}
          </Button>
        </div>

        {save.isError && (
          <div className="px-4 py-2 text-sm text-danger" data-testid="dw-error">
            Save failed: {(save.error as Error).message}
          </div>
        )}
      </Panel>
    </div>
  );
}
