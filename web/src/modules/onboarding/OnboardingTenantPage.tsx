// STEP 3 — Organisation / Region / Branch selection.
//
// Cascading selectors keyed off the chosen country (STEP 1) and domain
// (STEP 2). The user picks a concrete organisation → region → branch
// tuple; the resulting `TenantContext` is stored in localStorage so
// every subsequent BFF call can stamp `X-Tenant-ID` correctly.

import { useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  Building2,
  ChevronRight,
  Compass,
  Globe2,
  MapPin,
  CheckCircle2,
} from 'lucide-react';
import { useAuth } from '@/store/auth';
import {
  useCountry,
  useDomain,
  useTenantContext,
} from '@/lib/useOnboardingContext';
import { EnterpriseShell } from '../auth/EnterpriseShell';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { COUNTRIES, getCountry } from '@/lib/countries';
import {
  ORGANIZATIONS,
  organizationsFor,
  getOrganization,
  type OrganizationDef,
  type TenantContext,
} from '@/lib/organizations';

export function OnboardingTenantPage() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const [country] = useCountry();
  const [domain] = useDomain();
  const [tenantCtx, setTenantCtx] = useTenantContext();

  // Local selection state — committed to the store only on confirm.
  const [orgId, setOrgId] = useState<string | null>(tenantCtx?.organization_id ?? null);
  const [region, setRegion] = useState<string | null>(tenantCtx?.region ?? null);
  const [branch, setBranch] = useState<string | null>(tenantCtx?.branch ?? null);

  if (!user) return <Navigate to="/login" replace />;
  if (!country) return <Navigate to="/login" replace />;
  if (!domain) return <Navigate to="/onboarding/domain" replace />;

  const countryDef = getCountry(country)!;
  const orgsForContext = useMemo(
    () => organizationsFor(country, domain),
    [country, domain],
  );

  // Cross-country fallback — if the country has no orgs in our catalog
  // for this domain we still want the page to be usable, so we surface
  // ALL orgs in the domain and badge them with their country.
  const orgs = orgsForContext.length > 0
    ? orgsForContext
    : ORGANIZATIONS.filter((o) => o.domain === domain);

  const chosenOrg = getOrganization(orgId);
  const regions = chosenOrg ? chosenOrg.regions : [];
  const branches = chosenOrg && region ? chosenOrg.branches[region] ?? [] : [];

  // Reset cascading state when a higher level changes.
  function pickOrg(id: string) {
    if (id === orgId) return;
    setOrgId(id);
    setRegion(null);
    setBranch(null);
  }
  function pickRegion(r: string) {
    if (r === region) return;
    setRegion(r);
    setBranch(null);
  }

  const canConfirm = !!(orgId && region && branch);

  function onConfirm() {
    // The early-return guards above already enforce that country and
    // domain are non-null when we get here — narrow for TS via the
    // non-null assertion since the typesystem can't carry the
    // post-Navigate guarantee across the closure boundary.
    if (!canConfirm || !chosenOrg || !country || !domain) return;
    const next: TenantContext = {
      country,
      domain,
      organization_id: chosenOrg.id,
      region: region!,
      branch: branch!,
      tenant_id: chosenOrg.tenant_id,
    };
    setTenantCtx(next);
    navigate('/', { replace: true });
  }

  return (
    <EnterpriseShell
      step={{ current: 3, total: 4, label: 'Onboarding' }}
      tagline="Select your organisation"
    >
      <div>
        <div className="mb-7">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-ews-orange mb-2">
            Step 3 of 4
          </p>
          <h2 className="font-display text-[28px] font-semibold text-ews-warmWhite tracking-tight leading-[1.1]">
            Choose your organisation
          </h2>
          <p className="text-[13px] text-ews-warmWhite/70 mt-2 leading-relaxed">
            Pick the tenant, region and branch you operate out of. ZorEWS isolates every tenant
            end-to-end — data, audit, and scoring.
          </p>

          {/* Locked context summary */}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <ContextChip
              icon={<Globe2 size={11} />}
              label="Country"
              value={`${countryDef.flag} ${countryDef.name}`}
            />
            <ContextChip
              icon={<Compass size={11} />}
              label="Domain"
              value={domain[0].toUpperCase() + domain.slice(1)}
            />
          </div>
        </div>

        {/* Stepper */}
        <ol className="mb-5 grid grid-cols-3 gap-2 text-[10.5px] font-mono">
          <StepperPill index={1} label="Organisation" active={!orgId} done={!!orgId} />
          <StepperPill
            index={2}
            label="Region"
            active={!!orgId && !region}
            done={!!region}
            disabled={!orgId}
          />
          <StepperPill
            index={3}
            label="Branch"
            active={!!region && !branch}
            done={!!branch}
            disabled={!region}
          />
        </ol>

        {/* Organisation */}
        <Section
          label="Organisation"
          icon={<Building2 size={12} />}
          hint={
            orgsForContext.length === 0
              ? `No ${domain} tenant configured for ${countryDef.name} — pick from the global catalogue.`
              : `${orgs.length} ${domain} tenant${orgs.length === 1 ? '' : 's'} configured for ${countryDef.name}.`
          }
        >
          <div className="grid grid-cols-1 gap-1.5 max-h-[200px] overflow-y-auto pr-1">
            {orgs.map((o) => (
              <OrgRow
                key={o.id}
                org={o}
                selected={orgId === o.id}
                showCountry={orgsForContext.length === 0}
                onClick={() => pickOrg(o.id)}
              />
            ))}
          </div>
        </Section>

        {/* Region */}
        {chosenOrg && (
          <Section label="Region" icon={<Compass size={12} />}>
            <div className="grid grid-cols-2 gap-1.5">
              {regions.map((r) => (
                <PillButton
                  key={r}
                  selected={region === r}
                  onClick={() => pickRegion(r)}
                  testId={`region-${r}`}
                >
                  {r}
                </PillButton>
              ))}
            </div>
          </Section>
        )}

        {/* Branch */}
        {chosenOrg && region && (
          <Section label="Branch / Division" icon={<MapPin size={12} />}>
            <div className="grid grid-cols-2 gap-1.5">
              {branches.map((b) => (
                <PillButton
                  key={b}
                  selected={branch === b}
                  onClick={() => setBranch(b)}
                  testId={`branch-${b}`}
                >
                  {b}
                </PillButton>
              ))}
            </div>
          </Section>
        )}

        <div className="mt-7 flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate('/onboarding/domain')}
            className="text-[12.5px] text-ews-warmWhite/55 hover:text-ews-warmWhite underline underline-offset-2"
          >
            ← Back
          </button>
          <Button
            type="button"
            data-testid="onboarding-tenant-confirm"
            disabled={!canConfirm}
            onClick={onConfirm}
            className={cn(
              'min-w-[180px] font-semibold tracking-wide',
              '!bg-ews-orange hover:!bg-ews-orangeDeep !text-white !border-ews-orangeDeep',
              !canConfirm && '!opacity-50 cursor-not-allowed',
            )}
          >
            Enter ZorEWS
            <ChevronRight size={16} className="ml-1 -mr-1" />
          </Button>
        </div>
      </div>
    </EnterpriseShell>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────

function ContextChip({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded border border-white/12 bg-white/[0.04] px-2.5 py-1.5">
      <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-ews-warmWhite/55 flex items-center gap-1">
        <span className="text-ews-orange">{icon}</span>
        {label}
      </p>
      <p className="text-[12px] font-medium text-ews-warmWhite mt-0.5 truncate">{value}</p>
    </div>
  );
}

function StepperPill({
  index,
  label,
  active,
  done,
  disabled,
}: {
  index: number;
  label: string;
  active?: boolean;
  done?: boolean;
  disabled?: boolean;
}) {
  return (
    <li
      data-testid={`stepper-${index}`}
      className={cn(
        'rounded border px-2 py-1.5 flex items-center gap-1.5',
        disabled
          ? 'border-white/8 bg-white/[0.02] text-ews-warmWhite/40'
          : done
            ? 'border-ews-orange/30 bg-white/[0.06] text-ews-warmWhite'
            : active
              ? 'border-ews-orange bg-ews-orange/[0.06] text-ews-orange'
              : 'border-white/12 bg-white/[0.04] text-ews-warmWhite/80',
      )}
    >
      <span
        className={cn(
          'h-4 w-4 rounded-full flex items-center justify-center font-mono text-[8.5px] font-semibold',
          done ? 'bg-ews-orange text-white' : 'bg-white/15 text-ews-warmWhite',
        )}
      >
        {done ? '✓' : index}
      </span>
      <span className="uppercase tracking-[0.16em]">{label}</span>
    </li>
  );
}

function Section({
  label,
  icon,
  hint,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ews-warmWhite/55 mb-1.5 flex items-center gap-1.5">
        <span className="text-ews-orange">{icon}</span>
        {label}
      </p>
      {hint && <p className="text-[10.5px] text-ews-warmWhite/55 mb-2">{hint}</p>}
      {children}
    </div>
  );
}

function OrgRow({
  org,
  selected,
  showCountry,
  onClick,
}: {
  org: OrganizationDef;
  selected: boolean;
  showCountry: boolean;
  onClick: () => void;
}) {
  const countryDef = COUNTRIES.find((c) => c.code === org.country)!;
  return (
    <button
      type="button"
      data-testid={`org-${org.id}`}
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 rounded border px-3 py-2 text-left transition-all',
        'focus:outline-none focus:ring-2 focus:ring-ews-orange/40',
        selected
          ? 'border-ews-orange bg-white/[0.08] shadow-[0_4px_18px_-8px_rgba(255,107,53,0.45)]'
          : 'border-white/12 bg-white/[0.04] hover:border-ews-orange/50 hover:bg-white/[0.08]',
      )}
    >
      <div
        className={cn(
          'h-7 w-7 shrink-0 rounded text-[10.5px] font-mono font-semibold flex items-center justify-center',
          selected ? 'bg-ews-orange text-white' : 'bg-ews-orange/10 text-ews-orange border border-white/15',
        )}
      >
        {org.short_name.slice(0, 3)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-ews-warmWhite leading-tight truncate">{org.name}</p>
        <p className="text-[10.5px] text-ews-warmWhite/55 font-mono mt-0.5">
          {showCountry && (
            <>
              {countryDef.flag} {countryDef.name} ·{' '}
            </>
          )}
          {org.regions.length} region{org.regions.length === 1 ? '' : 's'} · tenant{' '}
          <span className="text-ews-warmWhite/70">{org.tenant_id}</span>
        </p>
      </div>
      {selected && <CheckCircle2 size={16} className="text-ews-orange shrink-0" strokeWidth={2} />}
    </button>
  );
}

function PillButton({
  selected,
  onClick,
  children,
  testId,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'rounded border px-2.5 py-1.5 text-left text-[12px] transition-all',
        'focus:outline-none focus:ring-2 focus:ring-ews-orange/40',
        selected
          ? 'border-ews-orange bg-ews-orange/[0.06] text-ews-warmWhite font-medium'
          : 'border-white/12 bg-white/[0.04] text-ews-warmWhite/85 hover:border-ews-orange/50 hover:bg-ews-orange/[0.08]',
      )}
    >
      {children}
    </button>
  );
}
