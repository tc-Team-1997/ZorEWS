// web/src/modules/ai/AiInsightsPage.tsx
//
// AI Workbench — T7 Module 9: AI Insight Panels.
//
// A unified, cross-domain AI-insight feed rendered through a single REUSABLE
// <InsightPanel> container (exported so other surfaces can embed a panel
// directly). Each insight is a ranked, model-powered card answering "what
// should I look at?" — top risky borrowers, fraud anomaly highlights, lapse
// insights, persistency risk, claim-fraud highlights, unusual trends. Backed
// by /v1/ai/insights/*; MSW-backed in dev. Enterprise + operational.

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import {
  api,
  type InsightFeedShape,
  type AiInsightShape,
  type InsightItemShape,
  type InsightSeverityShape,
  type InsightCategoryShape,
  type InsightDomainShape,
} from '@/lib/api';
import { Badge, MetricCard, Modal, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const SEV_TONE: Record<InsightSeverityShape, BadgeTone> = {
  critical: 'danger',
  high: 'warning',
  medium: 'blue',
  info: 'neutral',
};
const CATEGORIES: InsightCategoryShape[] = ['risk', 'fraud', 'retention', 'trend'];
const DOMAINS: InsightDomainShape[] = ['banking', 'insurance', 'cross'];

function TrendIcon({ trend }: { trend: InsightItemShape['trend'] }) {
  if (trend === 'up') return <ArrowUpRight className="size-3.5 text-danger" />;
  if (trend === 'down') return <ArrowDownRight className="size-3.5 text-success" />;
  return <Minus className="size-3.5 text-ink-subtle" />;
}

/**
 * Reusable AI-insight container. Render anywhere with a fetched AiInsight.
 * `compact` shows only the top 3 items (for embedding on a dashboard);
 * full mode shows up to `maxItems`.
 */
export function InsightPanel({
  insight,
  onOpen,
  maxItems = 5,
  compact = false,
}: {
  insight: AiInsightShape;
  onOpen?: () => void;
  maxItems?: number;
  compact?: boolean;
}) {
  const items = insight.items.slice(0, compact ? 3 : maxItems);
  return (
    <Panel
      title={insight.title}
      action={<Badge tone={SEV_TONE[insight.severity]}>{insight.severity}</Badge>}
    >
      <div data-testid={`insight-panel-${insight.insight_id}`}>
        <p className="mb-1 text-sm text-ink">{insight.headline}</p>
        <p className="mb-3 text-[11px] text-ink-subtle">
          powered by <span className="font-mono">{insight.model_ref}</span> · confidence {(insight.confidence * 100).toFixed(0)}% · {insight.domain}
        </p>
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li key={it.entity_id} className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0 flex-1">
                <span className="font-mono text-xs">{it.entity_id}</span>
                <span className="ml-2 text-xs text-ink-subtle">{it.reason}</span>
              </div>
              <span className="flex items-center gap-1 whitespace-nowrap tabular-nums">
                <TrendIcon trend={it.trend} />
                {it.score_label}
              </span>
            </li>
          ))}
        </ul>
        {onOpen && (
          <button onClick={onOpen} data-testid={`insight-open-${insight.insight_id}`} className="mt-3 text-xs font-medium text-action hover:underline">
            View all {insight.item_count} →
          </button>
        )}
      </div>
    </Panel>
  );
}

export function AiInsightsPage() {
  const [params, setParams] = useSearchParams();
  const category = (params.get('category') ?? '') as InsightCategoryShape | '';
  const domain = (params.get('domain') ?? '') as InsightDomainShape | '';
  const [selected, setSelected] = useState<string | null>(null);

  const setFilter = (key: 'category' | 'domain', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const { data: feed } = useQuery<InsightFeedShape>({
    queryKey: ['ai.insights', category, domain],
    queryFn: () => api.aiInsightFeed({ category: category || undefined, domain: domain || undefined }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Insights"
        subtitle="Unified, model-powered insight feed across banking + insurance — the at-a-glance 'what should I look at?' lens. Each panel is a reusable container ranked worst-first with reasons."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard label="Insight panels" value={feed?.total.toString() ?? '—'} tone="blue" testId="ai-ins-kpi-total" />
        <MetricCard label="Critical" value={feed?.by_severity.critical.toString() ?? '—'} tone="danger" testId="ai-ins-kpi-critical" />
        <MetricCard label="High" value={feed?.by_severity.high.toString() ?? '—'} tone="warning" testId="ai-ins-kpi-high" />
        <MetricCard label="Top insight" value={feed?.top_insight?.title ?? '—'} tone="blue" testId="ai-ins-kpi-top" />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1" data-testid="ai-ins-filter-category">
          <span className="mr-1 text-xs uppercase text-ink-subtle">Category</span>
          <FilterChip label="All" active={category === ''} onClick={() => setFilter('category', '')} testId="ai-ins-cat-all" />
          {CATEGORIES.map((c) => (
            <FilterChip key={c} label={c} active={category === c} onClick={() => setFilter('category', c)} testId={`ai-ins-cat-${c}`} />
          ))}
        </div>
        <div className="flex items-center gap-1" data-testid="ai-ins-filter-domain">
          <span className="mr-1 text-xs uppercase text-ink-subtle">Domain</span>
          <FilterChip label="All" active={domain === ''} onClick={() => setFilter('domain', '')} testId="ai-ins-dom-all" />
          {DOMAINS.map((d) => (
            <FilterChip key={d} label={d} active={domain === d} onClick={() => setFilter('domain', d)} testId={`ai-ins-dom-${d}`} />
          ))}
        </div>
      </div>

      {!feed || feed.insights.length === 0 ? (
        <p className="py-12 text-center text-sm text-ink-subtle" data-testid="ai-ins-empty">No insight panels match the filters.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" data-testid="ai-ins-grid">
          {feed.insights.map((ins) => (
            <InsightPanel key={ins.insight_id} insight={ins} onOpen={() => setSelected(ins.insight_id)} />
          ))}
        </div>
      )}

      {selected && <InsightDetailModal insight_id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function FilterChip({ label, active, onClick, testId }: { label: string; active: boolean; onClick: () => void; testId: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs capitalize transition ${active ? 'bg-action text-white' : 'border border-divider text-ink-subtle hover:border-action hover:text-action'}`}
    >
      {label}
    </button>
  );
}

function InsightDetailModal({ insight_id, onClose }: { insight_id: string; onClose: () => void }) {
  const { data, isLoading } = useQuery<AiInsightShape>({
    queryKey: ['ai.insight', insight_id],
    queryFn: () => api.aiInsightGet(insight_id),
  });
  return (
    <Modal open onClose={onClose} ariaLabel={data ? data.title : 'Insight'} size="3xl" testId="ai-ins-detail-modal">
      {isLoading || !data ? (
        <p className="text-sm text-ink-subtle">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{data.title}</h2>
              <Badge tone={SEV_TONE[data.severity]}>{data.severity}</Badge>
            </div>
            <p className="mt-1 text-sm text-ink-subtle">{data.description}</p>
            <p className="mt-1 text-[11px] text-ink-subtle">
              powered by <span className="font-mono">{data.model_ref}</span> · confidence {(data.confidence * 100).toFixed(0)}% · {data.category} · {data.domain}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="ai-ins-item-table">
              <thead className="text-left text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-3">Entity</th>
                  <th className="pb-2 pr-3 text-right">Score</th>
                  <th className="pb-2 pr-3">Trend</th>
                  <th className="pb-2 pr-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.entity_id} className="border-t border-divider">
                    <td className="py-1.5 pr-3"><span className="font-mono text-xs">{it.entity_id}</span></td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{it.score_label}</td>
                    <td className="py-1.5 pr-3"><span className="flex items-center gap-1"><TrendIcon trend={it.trend} />{it.delta >= 0 ? '+' : ''}{it.delta.toFixed(3)}</span></td>
                    <td className="py-1.5 pr-3 text-xs text-ink-subtle">{it.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
