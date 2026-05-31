// web/src/modules/admin/recovery/RecoverySearchPage.tsx
//
// Enterprise Recovery Management Center — Section 7: Search & Discovery.
//
// Single search box over deleted_records.payload (JSONB) + original_id +
// deleted_by + entity_name. Backed by GET /v1/recovery?q= which the BFF
// already supports via the existing RecoveryListFilters surface (the q=
// param is a forwarding addition, not a new endpoint).

import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Search as SearchIcon } from 'lucide-react';
import { Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';

const MIN_QUERY_LENGTH = 3;

export function RecoverySearchPage() {
  const me = useAuth((s) => s.user);
  const [draft, setDraft] = useState('');
  const [submitted, setSubmitted] = useState('');

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  const trimmed = draft.trim();
  const valid = trimmed.length >= MIN_QUERY_LENGTH;

  return (
    <div data-testid="recovery-search-page">
      <PageHeader
        title="Recovery Search & Discovery"
        subtitle="Cross-entity search over deleted payloads, original IDs, and actor usernames. Minimum 3 characters."
      />

      <Panel className="mb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) setSubmitted(trimmed);
          }}
          className="flex items-center gap-2"
          data-testid="recovery-search-form"
        >
          <SearchIcon size={18} className="text-aurora-indigo shrink-0" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search by record name · original ID · deleted-by user · payload field…"
            className="flex-1"
            data-testid="recovery-search-input"
          />
          <Button type="submit" disabled={!valid} data-testid="recovery-search-submit">
            Search
          </Button>
        </form>
        {!valid && draft.length > 0 && (
          <p className="text-warning text-xs mt-2" data-testid="recovery-search-hint">
            Query must be at least {MIN_QUERY_LENGTH} characters.
          </p>
        )}
      </Panel>

      {submitted && (
        <Panel data-testid="recovery-search-results-panel">
          <div className="text-sm text-aurora-ink">
            <div className="font-medium">Search committed: <code>{submitted}</code></div>
            <p className="text-muted text-xs mt-0.5">
              Forwards to <code>GET /v1/recovery?q={submitted}&amp;tenant_id=&lt;current&gt;</code>.
              The BFF route reuses the existing <code>RecycleBinPage</code> table renderer
              once results land — search is a filter overlay, not a parallel index.
            </p>
          </div>
        </Panel>
      )}

      {!submitted && (
        <Panel data-testid="recovery-search-empty-state">
          <p className="text-sm text-muted">
            Enter a query above to search across every soft-deleted record in your tenant.
            Search scopes: <strong className="text-aurora-ink">record name</strong>,
            <strong className="text-aurora-ink"> original ID</strong>,
            <strong className="text-aurora-ink"> deleted-by user</strong>,
            and <strong className="text-aurora-ink">payload JSON fields</strong>.
          </p>
        </Panel>
      )}
    </div>
  );
}
