// Placeholder route — `/cms/cases/:id/causal-analysis`.
//
// The CAS workflow lives in `services/regulatory-svc/cases` and is not
// yet joined into the BFF feed. This page exists so the Tracking
// timeline's CAUSAL_ANALYSIS_UPDATE click target is reachable; the
// content will fill in once the cross-service integration lands.

import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Sparkles } from 'lucide-react';
import { Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

export function CaseCausalAnalysisPage() {
  const { id = '' } = useParams<{ id: string }>();
  return (
    <div className="space-y-4" data-testid="cas-placeholder-page">
      <div>
        <Link to={`/cms/cases/${id}`}>
          <Button variant="ghost">
            <ChevronLeft size={14} /> Back to case
          </Button>
        </Link>
      </div>
      <PageHeader
        title="Causal analysis"
        subtitle={`Case ${id} · BAC §3.1.5 (Causal Analysis Stage)`}
      />
      <Panel>
        <div className="flex items-start gap-3 rounded-md border border-violet-200 bg-violet-50 p-4 text-sm text-violet-900">
          <Sparkles size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Pending integration</p>
            <p className="mt-1">
              CAS records live in <code>services/regulatory-svc/cases</code> and
              aren't joined into the BFF feed yet. Once the cross-service
              event bus carries <code>case.cas_submitted</code> /
              <code>case.cas_reviewed</code> events, this page will surface
              the full submission ledger + reviewer trail.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
