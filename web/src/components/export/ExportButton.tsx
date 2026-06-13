// web/src/components/export/ExportButton.tsx — RBAC-gated export trigger.
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui';
import { ExportModal } from './ExportModal';
import type { ReportAdapter, ReportType } from '@/lib/export/types';

// reports:export → admin, supervisor, risk_analyst (matches infra/rbac/matrix.json).
const EXPORT_ROLES = new Set(['admin', 'supervisor', 'risk_analyst']);

function canExport(): boolean {
  try {
    const raw = localStorage.getItem('apex.ews.user');
    if (!raw) return false;
    const roles: string[] = JSON.parse(raw)?.roles ?? [];
    return roles.some((r) => EXPORT_ROLES.has(r));
  } catch {
    return false;
  }
}

export interface ExportButtonProps {
  adapter: ReportAdapter;
  module: string;
  reportType: ReportType;
  label?: string;
}

export function ExportButton({ adapter, module, reportType, label = 'Export' }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  if (!canExport()) return null;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} data-testid="export-button">
        <Download className="w-4 h-4 mr-1" /> {label}
      </Button>
      <ExportModal open={open} onClose={() => setOpen(false)} adapter={adapter} module={module} defaultReportType={reportType} />
    </>
  );
}
