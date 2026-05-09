// Placeholder route — `/cms/cases/:id/cap` (Corrective Action Plan).
// Same pattern as CaseCausalAnalysisPage — exists so the Tracking
// timeline's CAP_UPDATE click target is reachable. Real content lands
// when the regulatory-svc CAP feed is wired into the BFF.

import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, FileText } from 'lucide-react';
import { Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

export function CaseCapPage() {
  const { id = '' } = useParams<{ id: string }>();
  return (
    <div className="space-y-4" data-testid="cap-placeholder-page">
      <div>
        <Link to={`/cms/cases/${id}`}>
          <Button variant="ghost">
            <ChevronLeft size={14} /> Back to case
          </Button>
        </Link>
      </div>
      <PageHeader
        title="Corrective Action Plan"
        subtitle={`Case ${id} · BAC §3.1.5 (CAP)`}
      />
      <Panel>
        <div className="flex items-start gap-3 rounded-md border border-violet-200 bg-violet-50 p-4 text-sm text-violet-900">
          <FileText size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Pending integration</p>
            <p className="mt-1">
              CAP records live in <code>services/regulatory-svc/cases</code>.
              Once <code>case.cap_proposed</code> /
              <code>case.cap_approved</code> / <code>case.cap_closed</code>{' '}
              events fan into the BFF tracking feed, this page will render
              the proposal + approval chain.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
