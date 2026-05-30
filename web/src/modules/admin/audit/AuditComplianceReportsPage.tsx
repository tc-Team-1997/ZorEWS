// web/src/modules/admin/audit/AuditComplianceReportsPage.tsx
//
// Audit Center → Compliance Reports.
//
// Pre-templated regulator packs (RBI Cyber Resilience access review,
// IRDAI Form-K, SOC 2 evidence dump, etc). Every pack reuses the M15.1
// audit chain + the existing M12.1 reports catalog where possible, and
// links out to the Audit Export page (with the right filter preset) when
// the regulator's question maps onto a filtered slice of the audit chain.
//
// Zero new BFF routes — the M15.1 audit surface + the existing M12.1
// reports + scheduled-report machinery covers every pack listed here.
// This page is a curated index over those primitives.

import { Link, Navigate } from 'react-router-dom';
import {
  Shield,
  FileBadge,
  Banknote,
  Building2,
  KeyRound,
  ScrollText,
  Download,
  ExternalLink,
} from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';

type CompliancePackTone = 'blue' | 'success' | 'warning' | 'neutral';

interface CompliancePack {
  id:
    | 'rbi-cyber-resilience-access-review'
    | 'rbi-bac-a-audit-evidence'
    | 'irdai-form-k-claims'
    | 'irdai-info-sec-access'
    | 'soc2-quarterly-evidence'
    | 'dpa-2019-data-access-log';
  label: string;
  regulator: 'RBI' | 'IRDAI' | 'SOC 2' | 'DPA 2019';
  cadence: 'quarterly' | 'monthly' | 'annual' | 'on-demand';
  description: string;
  primarySource: string;
  /** Deep-link into Export Reports with the right filter preset. */
  exportTo: string;
  /** Deep-link to the existing /v1/reports surface where applicable. */
  reportsTo: string | null;
  icon: LucideIcon;
  tone: CompliancePackTone;
}

const COMPLIANCE_PACKS: readonly CompliancePack[] = [
  {
    id: 'rbi-cyber-resilience-access-review',
    label: 'RBI Cyber Resilience — Quarterly Access Review',
    regulator: 'RBI',
    cadence: 'quarterly',
    description: 'Sign-off pack covering RBI Master Direction §4.1 (Access management). RBAC matrix snapshot + user roster + dormant-account flags + role-mismatch + termination cross-check.',
    primarySource: 'M15.1 audit chain (actor + role + outcome filtered to user/session resource types) + RBAC matrix SHA-256.',
    exportTo: '/audit-center/export',
    reportsTo: null,
    icon: Shield,
    tone: 'blue',
  },
  {
    id: 'rbi-bac-a-audit-evidence',
    label: 'RBI BAC-A — Audit Evidence Bundle',
    regulator: 'RBI',
    cadence: 'on-demand',
    description: 'Per-incident evidence ladder for RBI BAC-A §4.2 reporting. Filtered audit chain + WORM-anchored hash + every sensitive action with maker–checker correlation.',
    primarySource: 'M15.1 audit chain + M9.3 maker-checker decisions correlated by case_id.',
    exportTo: '/audit-center/export',
    reportsTo: null,
    icon: FileBadge,
    tone: 'warning',
  },
  {
    id: 'irdai-form-k-claims',
    label: 'IRDAI Form-K — Claims Investigation Pack',
    regulator: 'IRDAI',
    cadence: 'quarterly',
    description: 'Insurance claims investigation evidence per IRDAI Form-K: every BIL §17 8-step checklist with reviewer, decision, attachments, and approval ladder.',
    primarySource: 'M9.1 investigations + M9.3 maker-checker + linked DMS attachments.',
    exportTo: '/audit-center/export',
    reportsTo: '/reports',
    icon: Banknote,
    tone: 'success',
  },
  {
    id: 'irdai-info-sec-access',
    label: 'IRDAI Info-Sec — Access Provisioning Report',
    regulator: 'IRDAI',
    cadence: 'monthly',
    description: 'Per-tenant user provisioning + de-provisioning + role-change history. Source for IRDAI Info-Sec §6.2 user-provisioning attestation.',
    primarySource: 'M15.1 audit chain filtered to action ∈ {user.create, user.update, user.delete}.',
    exportTo: '/audit-center/export',
    reportsTo: null,
    icon: Building2,
    tone: 'neutral',
  },
  {
    id: 'soc2-quarterly-evidence',
    label: 'SOC 2 — Quarterly Evidence Dump',
    regulator: 'SOC 2',
    cadence: 'quarterly',
    description: 'SOC 2 Type II observation-window evidence: every security-relevant action across the quarter, grouped by trust-services-criteria (CC6.1 access, CC7.2 anomaly, CC8.1 change).',
    primarySource: 'M15.1 audit chain + M13.1 config change history + M7.2 promotion ledger.',
    exportTo: '/audit-center/export',
    reportsTo: null,
    icon: ScrollText,
    tone: 'blue',
  },
  {
    id: 'dpa-2019-data-access-log',
    label: 'DPA 2019 — Data Access Audit (Right-to-be-forgotten)',
    regulator: 'DPA 2019',
    cadence: 'on-demand',
    description: 'Per-data-subject access log: every read/write on the requested customer_id across mart + app_* schemas. Anchors the DPA 2019 §33 accountability obligation.',
    primarySource: 'M15.1 audit chain filtered to resource_id = subject customer_id.',
    exportTo: '/audit-center/export',
    reportsTo: null,
    icon: KeyRound,
    tone: 'warning',
  },
] as const;

export function AuditComplianceReportsPage() {
  const me = useAuth((s) => s.user);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="audit-compliance-reports-page">
      <PageHeader
        title="Compliance Reports"
        subtitle="Pre-templated regulator-facing evidence packs assembled from the existing audit chain + reports catalog."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <FileBadge size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">Curated index — zero duplicate machinery.</div>
            <p className="text-muted text-xs mt-0.5">
              Each pack composes the M15.1 audit chain, M12.1 reports catalog, M9.3 maker-checker
              ledger, and M13.1 config history. Click a pack → land in Export Reports with the
              right filter pre-applied, or open the matching /reports entry if one exists.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="audit-compliance-packs">
        {COMPLIANCE_PACKS.map((pack) => {
          const Icon = pack.icon;
          return (
            <Panel
              key={pack.id}
              className="h-full"
              data-testid={`audit-compliance-pack-${pack.id}`}
            >
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                  <Icon size={18} className="text-aurora-indigo" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-display text-[15px] font-semibold text-ink">{pack.label}</h3>
                  <div className="mt-1 flex items-center gap-2 text-[11px]">
                    <Badge tone={pack.tone}>{pack.regulator}</Badge>
                    <Badge tone="neutral">{pack.cadence}</Badge>
                  </div>
                  <p className="text-[12px] text-muted mt-2 leading-snug">{pack.description}</p>
                  <p className="text-[11px] text-muted mt-2 italic">
                    <span className="font-medium text-ink">Source:</span> {pack.primarySource}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link to={pack.exportTo} data-testid={`audit-compliance-export-${pack.id}`}>
                      <Button size="sm" variant="secondary">
                        <Download size={14} className="mr-1" /> Open in Export
                      </Button>
                    </Link>
                    {pack.reportsTo && (
                      <Link to={pack.reportsTo} data-testid={`audit-compliance-reports-${pack.id}`}>
                        <Button size="sm" variant="ghost">
                          <ExternalLink size={14} className="mr-1" /> Reports catalog
                        </Button>
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel className="mt-4" title="Adding a new compliance pack">
        <p className="caption">
          New regulator templates ship as additive entries in
          {' '}<code>COMPLIANCE_PACKS</code> — no schema migration, no new BFF route, no SPA
          rebuild beyond importing the new icon. The pack composes existing M15 / M12 / M9 / M13
          primitives; if a pack genuinely needs new aggregation, add a pure resolver under
          {' '}<code>services/bff/src/audit/</code> following the M15.x naming pattern.
        </p>
      </Panel>
    </div>
  );
}

export { COMPLIANCE_PACKS };
