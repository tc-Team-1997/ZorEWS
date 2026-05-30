// web/src/modules/admin/masters/MasterMenuPage.tsx
//
// Phase 9 T11 — Master Setup landing menu.
//
// Distinct from the existing /admin/master-setup page (which is a
// hand-curated static-card hub). This NEW menu is data-driven — it
// fetches /v1/admin/masters + renders one card per registered entity,
// each linking to /admin/masters/:entity.
//
// Adding a 4th entity = zero frontend changes; the BFF registry drives
// the menu.

import { Navigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Database, Globe, Loader2, ShieldAlert } from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api } from '@/lib/api';

export function MasterMenuPage() {
  const me = useAuth((s) => s.user);
  const q = useQuery({
    queryKey: ['master-menu'],
    queryFn: () => api.mastersFwCatalog(),
    enabled: me?.roles.includes('admin') ?? false,
  });

  if (me && !me.roles.includes('admin')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="master-menu-page">
      <PageHeader
        title="Master data"
        subtitle={
          q.isLoading
            ? 'Loading registry…'
            : q.isError
              ? 'Failed to load.'
              : `${q.data?.total ?? 0} reusable entit${(q.data?.total ?? 0) === 1 ? 'y' : 'ies'} · CRUD with versioning`
        }
      />

      {q.isLoading && (
        <Panel>
          <Loader2 className="animate-spin" />
        </Panel>
      )}

      {q.isError && (
        <Panel>
          <p className="text-danger text-sm">
            <ShieldAlert size={14} className="inline mr-1" />
            Failed to load master entity registry.
          </p>
        </Panel>
      )}

      {q.data && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.entities.map((e) => (
            <Link
              key={e.entity}
              to={`/admin/masters/${encodeURIComponent(e.entity)}`}
              className="block group"
              data-testid={`master-menu-link-${e.entity}`}
            >
              <Panel className="hover:border-action transition-colors">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                    {e.tenant_scoped ? (
                      <Database size={18} className="text-aurora-indigo" />
                    ) : (
                      <Globe size={18} className="text-aurora-indigo" />
                    )}
                  </div>
                  <div className="flex-1">
                    <h3 className="font-display text-[15px] font-semibold text-ink">
                      {e.label_plural}
                    </h3>
                    <p className="text-[11.5px] text-muted mt-0.5">
                      {e.field_count} field{e.field_count === 1 ? '' : 's'}
                    </p>
                    <div className="mt-2">
                      <Badge tone={e.tenant_scoped ? 'blue' : 'neutral'}>
                        {e.tenant_scoped ? 'Tenant-scoped' : 'Platform-static'}
                      </Badge>
                    </div>
                  </div>
                </div>
              </Panel>
            </Link>
          ))}
        </div>
      )}

      <Panel className="mt-4">
        <p className="caption">
          Each master entity uses the same reusable framework
          (<code>createMasterStore</code> + <code>createMasterRoutes</code>
          {' '}on the BFF + <code>&lt;MasterEntityPage&gt;</code> on the SPA). Adding a new
          entity is a 10-line schema declaration + a nav entry — the rest is free.
          The full Phase 9 design ships 25 entities; this initial slice
          covers Countries, Departments, and Risk Categories as
          representative examples.
        </p>
      </Panel>
    </div>
  );
}
