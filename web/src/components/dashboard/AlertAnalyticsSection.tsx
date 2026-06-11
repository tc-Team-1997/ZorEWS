// web/src/components/dashboard/AlertAnalyticsSection.tsx
//
// Composes the new analytics workbench: dimension-toggle bar chart +
// timeline + drill-down panel. Lives on the Dashboard between the
// existing severity drill-downs and the SLA matrix.
//
// State + data flow:
//   - alerts fetched via React Query on the same queryKey as
//     TrendWeekDrilldown — single cached call, no extra network
//   - dimension toggle is local React state (not URL-synced, fits the
//     UX better — switching axis is a quick toggle, not a navigation)
//   - drill-down is URL-synced via ?adrill=<dim>:<value> so it
//     survives deep-link / refresh / share

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import {
  ALERT_DIMENSIONS,
  type AlertDimension,
} from '@/lib/alertDimensions';
import { AlertBarChart } from './charts/AlertBarChart';
import { AlertTrendChart } from './charts/AlertTrendChart';
import { AlertDeepDrilldown, type DrillFilter } from './AlertDeepDrilldown';
import {
  RiskTrendConfigDrawer,
} from '@/modules/dashboard/riskTrend/RiskTrendConfigDrawer';
import {
  buildDefaultConfig,
  type RiskTrendConfig,
} from '@/modules/dashboard/riskTrend/riskTrendConfigurationEngine';

const HUMAN: Record<AlertDimension, string> = {
  severity: 'Severity',
  status: 'Status',
  risk_band: 'Risk band',
  category: 'Category',
  module: 'Module',
  source: 'Source',
};

function isAlertDimension(v: string | null): v is AlertDimension {
  return !!v && (ALERT_DIMENSIONS as readonly string[]).includes(v);
}

function parseAdrill(raw: string | null): DrillFilter | null {
  if (!raw) return null;
  const [dim, ...rest] = raw.split(':');
  const value = rest.join(':');
  if (!isAlertDimension(dim) || !value) return null;
  return { dimension: dim, value };
}

function serialiseAdrill(d: DrillFilter): string {
  return `${d.dimension}:${d.value}`;
}

export function AlertAnalyticsSection() {
  const [dim, setDim] = useState<AlertDimension>('severity');
  const [searchParams, setSearchParams] = useSearchParams();

  // Enterprise Risk Trend Intelligence Configuration state
  const [configOpen, setConfigOpen] = useState(false);
  const [riskTrendConfig, setRiskTrendConfig] = useState<RiskTrendConfig>(() => buildDefaultConfig());

  // Reuse the EXACT same queryKey as TrendWeekDrilldown so React Query
  // dedupes across components — zero extra network on this section.
  const q = useQuery({
    queryKey: ['alerts', { dedup: false }],
    queryFn: () => api.alerts({ dedup: false }),
  });

  const alerts = useMemo(() => q.data?.items ?? [], [q.data]);
  const drill = parseAdrill(searchParams.get('adrill'));

  // Filter alerts based on active severity config
  const filteredAlerts = useMemo(() => {
    const enabledLevels = riskTrendConfig.severities
      .filter((s) => s.enabled)
      .map((s) => s.level);
    if (enabledLevels.length === 4) return alerts; // all enabled = no filter
    return alerts.filter((a) => {
      const sev = (a.severity ?? '').toLowerCase();
      return enabledLevels.some((l) => sev.includes(l));
    });
  }, [alerts, riskTrendConfig.severities]);

  const handleSaveConfig = (cfg: RiskTrendConfig, _asDefault?: boolean) => {
    setRiskTrendConfig(cfg);
    setConfigOpen(false);
    // Fire-and-forget audit trail — best effort, never blocks UI
    fetch('/v1/audit/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'BIL',
        'X-Channel': 'API',
      },
      body: JSON.stringify({
        actor_username: 'current_user',
        actor_role: 'admin',
        action: 'risk_trend_config.update',
        resource_type: 'config',
        resource_id: 'risk_trend_chart',
        outcome: 'success',
        metadata: { new_config: cfg },
      }),
    }).catch(() => {});
  };

  const setDrill = (next: DrillFilter | null) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('adrill', serialiseAdrill(next));
    else sp.delete('adrill');
    setSearchParams(sp, { replace: false });
  };

  const configureButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setConfigOpen(true)}
      data-testid="alert-analytics-configure-btn"
      className="flex items-center gap-1.5 text-xs"
    >
      <Settings2 className="h-3.5 w-3.5" />
      Configure
    </Button>
  );

  if (q.isLoading) {
    return (
      <Panel
        title={
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted" aria-hidden />
            Alert analytics
          </span>
        }
        action={configureButton}
        data-testid="alert-analytics-section"
      >
        <div className="py-12 text-center text-[12px] text-muted">Loading…</div>
      </Panel>
    );
  }

  if (q.isError) {
    return (
      <Panel
        title={
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted" aria-hidden />
            Alert analytics
          </span>
        }
        action={configureButton}
        data-testid="alert-analytics-section"
      >
        <div className="py-12 text-center text-[12px] text-danger">
          Failed to load alerts. Retry the page.
        </div>
      </Panel>
    );
  }

  if (alerts.length === 0) {
    return (
      <>
        <Panel
          title={
            <span className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted" aria-hidden />
              Alert analytics
            </span>
          }
          action={configureButton}
          data-testid="alert-analytics-section"
        >
          <div className="py-12 text-center text-[12px] text-muted">
            No alerts in the queue — the analytics section will populate as
            rules fire.
          </div>
        </Panel>
        <RiskTrendConfigDrawer
          open={configOpen}
          onClose={() => setConfigOpen(false)}
          config={riskTrendConfig}
          onChange={setRiskTrendConfig}
          onSave={handleSaveConfig}
          onReset={() => setRiskTrendConfig(buildDefaultConfig())}
        />
      </>
    );
  }

  return (
    <div className="mt-4 space-y-4" data-testid="alert-analytics-section">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted" aria-hidden />
            Alert analytics
            <span className="text-muted text-[11px] font-normal">
              · {filteredAlerts.length.toLocaleString()}/{alerts.length.toLocaleString()} alerts
            </span>
          </span>
        }
        action={
          <div className="flex items-center gap-2">
            <DimensionToggle value={dim} onChange={setDim} testId="alert-analytics-dim-toggle" />
            {configureButton}
          </div>
        }
      >
        <p className="caption mb-2" data-testid="alert-analytics-hint">
          Choose a dimension above to slice the bar chart. Click any bar
          or timeline point to drill into the 6-axis breakdown for that
          subset.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <h4 className="text-[12px] font-semibold text-ink mb-1 uppercase tracking-wide">
              By {HUMAN[dim].toLowerCase()}
            </h4>
            <AlertBarChart
              alerts={filteredAlerts}
              dimension={dim}
              selected={drill?.dimension === dim ? drill.value : null}
              onSelect={(value) => setDrill(value ? { dimension: dim, value } : null)}
              testId="alert-analytics-bar"
            />
          </div>
          <div>
            <h4 className="text-[12px] font-semibold text-ink mb-1 uppercase tracking-wide">
              Timeline (daily volume)
            </h4>
            <AlertTrendChart
              alerts={filteredAlerts}
              testId="alert-analytics-trend"
            />
          </div>
        </div>
      </Panel>

      {drill && (
        <AlertDeepDrilldown
          alerts={filteredAlerts}
          filter={drill}
          onClose={() => setDrill(null)}
          onSubDrill={(next) => {
            setDim(next.dimension);
            setDrill(next);
          }}
        />
      )}

      {/* Enterprise Risk Trend Intelligence Configuration Drawer */}
      <RiskTrendConfigDrawer
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        config={riskTrendConfig}
        onChange={setRiskTrendConfig}
        onSave={handleSaveConfig}
        onReset={() => setRiskTrendConfig(buildDefaultConfig())}
      />
    </div>
  );
}

interface DimensionToggleProps {
  value: AlertDimension;
  onChange: (v: AlertDimension) => void;
  testId?: string;
}

function DimensionToggle({ value, onChange, testId }: DimensionToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Alert dimension"
      className="flex flex-wrap items-center gap-1"
      data-testid={testId}
    >
      {ALERT_DIMENSIONS.map((d) => {
        const active = d === value;
        return (
          <button
            key={d}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(d)}
            className={`px-2 py-0.5 rounded text-[11px] capitalize transition-colors ${
              active
                ? 'bg-action text-white'
                : 'bg-divider/40 text-muted hover:text-ink hover:bg-divider'
            }`}
            data-testid={`${testId}-opt-${d}`}
          >
            {HUMAN[d]}
          </button>
        );
      })}
    </div>
  );
}
