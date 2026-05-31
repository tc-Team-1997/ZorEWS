// web/src/modules/admin/governance/OrganizationGovernancePage.tsx
//
// Governance Center → Organization Governance.
//
// Composes 4 org-chart surfaces (Countries / Regions / Branches /
// Departments) into one landing. Every link points at the existing
// Master Setup CRUD page OR the existing /admin/governance/branches.

import { Link, Navigate } from 'react-router-dom';
import { Globe, MapPin, Building2, Users, ArrowRight } from 'lucide-react';
import { Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

interface OrgCard {
  id: 'countries' | 'regions' | 'branches' | 'departments';
  label: string;
  description: string;
  to: string;
  icon: LucideIcon;
}

const ORG_CARDS: readonly OrgCard[] = [
  {
    id: 'countries',
    label: 'Countries',
    description: 'ISO country codes, currency, timezone, date format, regulatory authority, compliance rules.',
    to: '/admin/masters/countries',
    icon: Globe,
  },
  {
    id: 'regions',
    label: 'Regions',
    description: 'Regional grouping per country (India · North / South / East / West). Joins branches to country-level rollups.',
    to: '/admin/masters/regions',
    icon: MapPin,
  },
  {
    id: 'branches',
    label: 'Branches',
    description: 'Tenant-scoped branch registry. Branch code, name, region, parent tenant.',
    to: '/admin/governance/branches',
    icon: Building2,
  },
  {
    id: 'departments',
    label: 'Departments',
    description: 'Department code, name, domain mapping (banking / insurance / shared).',
    to: '/admin/masters/departments',
    icon: Users,
  },
];

export function OrganizationGovernancePage() {
  const me = useAuth((s) => s.user);
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }
  return (
    <div data-testid="org-governance-page">
      <PageHeader
        title="Organization Governance"
        subtitle="The org-chart substrate every other section joins to — countries / regions / branches / departments."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="org-governance-cards">
        {ORG_CARDS.map((c) => {
          const Icon = c.icon;
          return (
            <Link key={c.id} to={c.to} className="block group" data-testid={`org-governance-card-${c.id}`}>
              <Panel className="hover:border-action transition-colors h-full">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                    <Icon size={18} className="text-aurora-indigo" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-display text-[15px] font-semibold text-ink flex items-center gap-2">
                      {c.label}
                      <ArrowRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-action" />
                    </h3>
                    <p className="text-[11.5px] text-muted mt-0.5 leading-snug">{c.description}</p>
                  </div>
                </div>
              </Panel>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export { ORG_CARDS };
