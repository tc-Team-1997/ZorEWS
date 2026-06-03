// web/src/modules/eventStreaming/EventStreamingCenterPage.tsx
//
// Real-Time Event Streaming Center — Phase 22 IA overlay.
//
// 10 sections: Event Hub, Bus Dashboard, Topics, Publishers,
//   Subscribers, Stream Processing, Replay Center, DLQ Management,
//   AI Insights, Executive Stream View.
//
// Additive — every existing module untouched.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, Award, BarChart3,
  Brain, ChevronRight, Database,
  GitBranch, LucideIcon, Network, Play, RefreshCw,
  Target, TrendingUp, Zap,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  EVENT_CATEGORIES,
  buildDlqEntries, buildEventBusDashboard, buildEventHub,
  buildEventInsights, buildEventTopics, buildExecutiveStreamView,
  buildPublishers, buildReplayJobs, buildStreamProcessors,
  buildStreamingKpis, buildSubscribers, canAccessEventStreamingCenter,
  type DeliveryStatus, type DlqStatus, type EventCategory,
  type ReplayStatus,
} from './eventStreamingEngine';

const ACTIVE_TENANT = 'BANK_DEMO';
const AS_OF = new Date('2026-06-01T12:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtInt(n: number): string { return n.toLocaleString('en-IN'); }
function fmtPct(n: number): string { return (Math.round(n * 10) / 10) + '%'; }
function fmtMs(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }
function fmtBytes(b: number): string { return b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(1)}MB`; }
function timeSince(iso: string, asOf: Date): string {
  const ms = asOf.getTime() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

function titleWithIcon(label: string, icon: LucideIcon, sub?: string): ReactNode {
  const Icon = icon;
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-indigo-400" aria-hidden />
      <span>{label}</span>
      {sub && <span className="text-xs font-normal text-slate-400 ml-2">{sub}</span>}
    </span>
  );
}

function StatusPulse({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-400', running: 'bg-green-400', healthy: 'bg-green-400', processed: 'bg-green-400',
    degraded: 'bg-amber-400', lagging: 'bg-amber-400', processing: 'bg-blue-400',
    failed: 'bg-red-400', error: 'bg-red-400', offline: 'bg-gray-400',
    paused: 'bg-purple-400', deprecated: 'bg-slate-400',
  };
  const color = colors[status] ?? 'bg-slate-400';
  return (
    <span className="relative inline-flex">
      <span className={`absolute inline-flex h-2 w-2 rounded-full ${color} opacity-75 ${status === 'active' || status === 'running' ? 'animate-ping' : ''}`} />
      <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
    </span>
  );
}

function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  const cls: Record<DeliveryStatus, string> = {
    healthy: 'bg-green-50 text-green-700', degraded: 'bg-amber-50 text-amber-700',
    failed: 'bg-red-50 text-red-700', lagging: 'bg-orange-50 text-orange-700',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[status]}`}>{status}</span>;
}

function DlqBadge({ status }: { status: DlqStatus }) {
  const cls: Record<DlqStatus, string> = {
    pending: 'bg-amber-50 text-amber-700', retrying: 'bg-blue-50 text-blue-700',
    resolved: 'bg-green-50 text-green-700', abandoned: 'bg-red-50 text-red-700',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[status]}`}>{status}</span>;
}

function ReplayBadge({ status }: { status: ReplayStatus }) {
  const cls: Record<ReplayStatus, string> = {
    queued: 'bg-slate-100 text-slate-600', in_progress: 'bg-blue-50 text-blue-700',
    completed: 'bg-green-50 text-green-700', failed: 'bg-red-50 text-red-700',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[status]}`}>{status.replace('_', ' ')}</span>;
}

function CategoryBadge({ cat }: { cat: EventCategory }) {
  const cls: Record<EventCategory, string> = {
    risk: 'bg-red-50 text-red-700', case: 'bg-blue-50 text-blue-700',
    investigation: 'bg-indigo-50 text-indigo-700', compliance: 'bg-green-50 text-green-700',
    ai: 'bg-violet-50 text-violet-700', governance: 'bg-slate-100 text-slate-700',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[cat]}`}>{cat}</span>;
}

const SECTION_TABS = [
  { id: 'hub',        label: 'Event Hub',     icon: Activity },
  { id: 'bus',        label: 'Bus Dashboard', icon: BarChart3 },
  { id: 'topics',     label: 'Topics',        icon: Database },
  { id: 'publishers', label: 'Publishers',    icon: Zap },
  { id: 'subscribers',label: 'Subscribers',   icon: Network },
  { id: 'processing', label: 'Processing',    icon: GitBranch },
  { id: 'replay',     label: 'Replay',        icon: Play },
  { id: 'dlq',        label: 'DLQ',           icon: AlertTriangle },
  { id: 'insights',   label: 'AI Insights',   icon: Brain },
  { id: 'executive',  label: 'Exec View',     icon: Award },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function EventStreamingCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessEventStreamingCenter(user.roles)) return <Navigate to="/" replace />;

  const asOf = useMemo(() => AS_OF, []);

  const kpis        = useMemo(() => buildStreamingKpis(ACTIVE_TENANT, asOf), [asOf]);
  const events      = useMemo(() => buildEventHub(ACTIVE_TENANT, asOf, 25), [asOf]);
  const busDash     = useMemo(() => buildEventBusDashboard(ACTIVE_TENANT, asOf), [asOf]);
  const topics      = useMemo(() => buildEventTopics(ACTIVE_TENANT, asOf), [asOf]);
  const publishers  = useMemo(() => buildPublishers(ACTIVE_TENANT, asOf), [asOf]);
  const subscribers = useMemo(() => buildSubscribers(ACTIVE_TENANT, asOf), [asOf]);
  const processors  = useMemo(() => buildStreamProcessors(ACTIVE_TENANT, asOf), [asOf]);
  const replayJobs  = useMemo(() => buildReplayJobs(ACTIVE_TENANT, asOf), [asOf]);
  const dlqEntries  = useMemo(() => buildDlqEntries(ACTIVE_TENANT, asOf), [asOf]);
  const insights    = useMemo(() => buildEventInsights(ACTIVE_TENANT, asOf), [asOf]);
  const execView    = useMemo(() => buildExecutiveStreamView(ACTIVE_TENANT, asOf), [asOf]);

  const [activeSection, setActiveSection] = useState('bus');
  const [catFilter, setCatFilter] = useState<EventCategory | 'all'>('all');

  const filteredEvents = catFilter === 'all' ? events : events.filter(e => e.category === catFilter);

  const categoryVolData = EVENT_CATEGORIES.map(cat => ({
    cat, volume: busDash.events_by_category[cat],
  }));
  const catColors: Record<EventCategory, string> = {
    risk: '#EF4444', case: '#3B82F6', investigation: '#6366F1',
    compliance: '#10B981', ai: '#8B5CF6', governance: '#94A3B8',
  };

  const pubBarData = publishers.map(p => ({
    name: p.module.split(' ')[0],
    Published: p.events_published_24h,
    fill: p.status === 'active' ? '#10B981' : p.status === 'degraded' ? '#F59E0B' : '#EF4444',
  }));

  return (
    <div className="space-y-4" data-testid="event-streaming-center">

      <PageHeader
        title="Real-Time Event Streaming Center"
        subtitle={`Enterprise event backbone · ${fmtInt(kpis.total_events_24h)} events/24h · ${kpis.active_topics} topics · ${kpis.active_publishers} publishers`}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="neutral" className="text-xs">Phase 22</Badge>
            <Badge tone="success" className="text-xs flex items-center gap-1">
              <StatusPulse status="active" />
              <span className="ml-1">Live · {kpis.events_per_minute}/min</span>
            </Badge>
            <Badge tone={kpis.failure_rate_pct > 1 ? 'warning' : 'neutral'} className="text-xs">
              Fail: {fmtPct(kpis.failure_rate_pct)}
            </Badge>
            {kpis.dlq_size > 0 && <Badge tone="warning" className="text-xs">DLQ: {kpis.dlq_size}</Badge>}
          </div>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-10 gap-2">
        <MetricCard label="Events 24h"    value={fmtInt(kpis.total_events_24h)}  tone="neutral"  testId="esc-kpi-total" />
        <MetricCard label="Per Minute"    value={String(kpis.events_per_minute)}  tone="neutral"  testId="esc-kpi-epm" />
        <MetricCard label="Topics"        value={String(kpis.active_topics)}      tone="neutral"  testId="esc-kpi-topics" />
        <MetricCard label="Publishers"    value={String(kpis.active_publishers)}  tone="success"  testId="esc-kpi-pubs" />
        <MetricCard label="Subscribers"   value={String(kpis.active_subscribers)} tone="success"  testId="esc-kpi-subs" />
        <MetricCard label="Fail Rate"     value={fmtPct(kpis.failure_rate_pct)}   tone={kpis.failure_rate_pct > 1 ? 'warning' : 'success'} testId="esc-kpi-fail" />
        <MetricCard label="DLQ Size"      value={String(kpis.dlq_size)}           tone={kpis.dlq_size > 20 ? 'warning' : 'neutral'} testId="esc-kpi-dlq" />
        <MetricCard label="Avg Latency"   value={fmtMs(kpis.avg_latency_ms)}      tone={kpis.avg_latency_ms > 80 ? 'warning' : 'success'} testId="esc-kpi-latency" />
        <MetricCard label="Health Score"  value={`${kpis.event_health_score}/100`} tone={kpis.event_health_score >= 85 ? 'success' : 'warning'} testId="esc-kpi-health" />
        <MetricCard label="Critical"      value={fmtInt(kpis.critical_events_24h)} tone="danger"   testId="esc-kpi-critical" />
      </div>

      {/* Section tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {SECTION_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveSection(id)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${activeSection === id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}
          >
            <Icon className="size-3" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {/* ─── Section 1: Event Hub ─────────────────────────────────────────── */}
      {activeSection === 'hub' && (
        <Panel title={titleWithIcon('Event Hub', Activity, `${events.length} recent events`)} data-testid="esc-section-hub">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-xs text-slate-500 font-medium">Category:</span>
            {(['all', ...EVENT_CATEGORIES] as const).map(c => (
              <button key={c} onClick={() => setCatFilter(c as EventCategory | 'all')} className={`px-2.5 py-0.5 rounded-full text-xs border transition-colors capitalize ${catFilter === c ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>
                {c === 'all' ? `All (${events.length})` : `${c} (${events.filter(e => e.category === c).length})`}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['Event Type', 'Category', 'Topic', 'Publisher', 'Status', 'Latency', 'Priority', 'Age'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredEvents.slice(0, 18).map(evt => (
                  <tr key={evt.event_id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-1.5 pr-3 font-mono text-slate-700">{evt.event_type}</td>
                    <td className="py-1.5 pr-3"><CategoryBadge cat={evt.category} /></td>
                    <td className="py-1.5 pr-3 font-mono text-slate-500 text-xs">{evt.topic}</td>
                    <td className="py-1.5 pr-3 text-slate-500 max-w-28 truncate">{evt.publisher}</td>
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <StatusPulse status={evt.status} />
                        <span className="text-slate-600">{evt.status}</span>
                      </div>
                    </td>
                    <td className={`py-1.5 pr-3 font-medium ${evt.latency_ms > 150 ? 'text-amber-600' : 'text-slate-600'}`}>{fmtMs(evt.latency_ms)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`text-xs px-1 rounded font-medium ${evt.priority === 'critical' ? 'bg-red-50 text-red-700' : evt.priority === 'high' ? 'bg-orange-50 text-orange-700' : 'bg-slate-50 text-slate-600'}`}>{evt.priority}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-400">{timeSince(evt.occurred_at, asOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 2: Bus Dashboard ─────────────────────────────────────── */}
      {activeSection === 'bus' && (
        <Panel title={titleWithIcon('Event Bus Dashboard', BarChart3, 'Real-time throughput & health')} data-testid="esc-section-bus">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Events/min"      value={String(busDash.events_per_minute)}   tone="neutral" testId="esc-bus-epm" />
            <MetricCard label="Throughput/sec"  value={`${busDash.throughput_per_sec}/s`}   tone="neutral" testId="esc-bus-tps" />
            <MetricCard label="P95 Latency"     value={fmtMs(busDash.p95_latency_ms)}       tone={busDash.p95_latency_ms > 200 ? 'warning' : 'success'} testId="esc-bus-p95" />
            <MetricCard label="P99 Latency"     value={fmtMs(busDash.p99_latency_ms)}       tone={busDash.p99_latency_ms > 500 ? 'warning' : 'neutral'} testId="esc-bus-p99" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Throughput Trend (last 15 min)</p>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={busDash.throughput_trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="minute" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="events" stroke="#6366F1" fill="#6366F1" fillOpacity={0.15} name="Events" />
                  <Area type="monotone" dataKey="failures" stroke="#EF4444" fill="#EF4444" fillOpacity={0.2} name="Failures" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Events by Category (24h)</p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={categoryVolData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="cat" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => [fmtInt(v), 'Events']} />
                  <Bar dataKey="volume" name="Volume" radius={[3, 3, 0, 0]}>
                    {categoryVolData.map((d, i) => <Cell key={i} fill={catColors[d.cat as EventCategory]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Retry Queue', value: busDash.retry_queue_size, color: busDash.retry_queue_size > 100 ? 'text-amber-600' : 'text-slate-700' },
              { label: 'DLQ Size', value: busDash.dlq_size, color: busDash.dlq_size > 20 ? 'text-red-600' : 'text-slate-700' },
              { label: 'Active Topics', value: busDash.active_topics, color: 'text-slate-700' },
              { label: 'Active Subscribers', value: busDash.active_subscribers, color: 'text-slate-700' },
            ].map(({ label, value, color }) => (
              <div key={label} className="p-2.5 rounded-lg border border-slate-100 text-center">
                <p className={`text-xl font-bold ${color}`}>{value}</p>
                <p className="text-xs text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 3: Topics ────────────────────────────────────────────── */}
      {activeSection === 'topics' && (
        <Panel title={titleWithIcon('Event Topics', Database, `${topics.length} managed topics`)} data-testid="esc-section-topics">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['Topic', 'Category', 'Publisher', 'Events/Day', 'Subscribers', 'Partitions', 'Retention', 'Compression', 'Status'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topics.map(t => (
                  <tr key={t.topic_name} className="border-b border-slate-50 hover:bg-slate-50" data-testid={`esc-topic-${t.topic_name.replace('.', '-')}`}>
                    <td className="py-1.5 pr-3 font-mono font-medium text-slate-700">{t.topic_name}</td>
                    <td className="py-1.5 pr-3"><CategoryBadge cat={t.category} /></td>
                    <td className="py-1.5 pr-3 text-slate-500 max-w-28 truncate">{t.publisher}</td>
                    <td className="py-1.5 pr-3 text-slate-600">{fmtInt(t.events_per_day)}</td>
                    <td className="py-1.5 pr-3 text-slate-600">{t.subscribers_count}</td>
                    <td className="py-1.5 pr-3 text-slate-600">{t.partition_count}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{t.retention_hours >= 8760 ? `${Math.round(t.retention_hours / 8760)}y` : `${Math.round(t.retention_hours / 24)}d`}</td>
                    <td className="py-1.5 pr-3"><span className="text-xs bg-slate-50 text-slate-600 px-1.5 py-0.5 rounded">{t.compression}</span></td>
                    <td className="py-1.5">
                      <div className="flex items-center gap-1.5"><StatusPulse status={t.status} /><span className="text-slate-600">{t.status}</span></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 4: Publishers ────────────────────────────────────────── */}
      {activeSection === 'publishers' && (
        <Panel title={titleWithIcon('Publishers', Zap, `${publishers.length} publishing modules`)} data-testid="esc-section-publishers">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Events Published 24h</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={pubBarData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 9 }} />
                  <YAxis type="category" dataKey="name" width={72} tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => [fmtInt(v), 'Events']} />
                  <Bar dataKey="Published" radius={[0, 3, 3, 0]}>
                    {pubBarData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2 overflow-y-auto max-h-52">
              {publishers.map(pub => (
                <div key={pub.module} className="p-2.5 rounded-lg border border-slate-100 hover:bg-slate-50">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <StatusPulse status={pub.status} />
                      <span className="text-xs font-semibold text-slate-800">{pub.module}</span>
                    </div>
                    <span className={`text-xs font-medium ${pub.success_rate_pct >= 99 ? 'text-green-600' : 'text-amber-600'}`}>{fmtPct(pub.success_rate_pct)}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span>{fmtInt(pub.events_published_24h)} events</span>
                    <span>·</span>
                    <span>{fmtMs(pub.avg_publish_ms)} avg</span>
                    <span>·</span>
                    <span>{fmtBytes(pub.bytes_published_24h)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {pub.topics_published.map(t => <span key={t} className="text-xs bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded font-mono">{t}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 5: Subscribers ───────────────────────────────────────── */}
      {activeSection === 'subscribers' && (
        <Panel title={titleWithIcon('Subscribers', Network, `${subscribers.length} consumer groups`)} data-testid="esc-section-subscribers">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['Subscriber', 'Status', 'Consumed 24h', 'Lag', 'Avg Processing', 'Retries', 'Success %', 'Last Consumed'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {subscribers.map(sub => (
                  <tr key={sub.subscriber_id} className={`border-b border-slate-50 hover:bg-slate-50 ${sub.delivery_status === 'lagging' ? 'bg-amber-50/20' : sub.delivery_status === 'failed' ? 'bg-red-50/20' : ''}`}>
                    <td className="py-1.5 pr-3 font-medium text-slate-800 max-w-40 truncate">{sub.subscriber_name}</td>
                    <td className="py-1.5 pr-3"><DeliveryBadge status={sub.delivery_status} /></td>
                    <td className="py-1.5 pr-3 text-slate-600">{fmtInt(sub.events_consumed_24h)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={sub.lag_messages > 100 ? 'text-red-600 font-medium' : sub.lag_messages > 20 ? 'text-amber-600' : 'text-slate-500'}>{sub.lag_messages}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-500">{fmtMs(sub.avg_processing_ms)}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{sub.retry_count_24h}</td>
                    <td className="py-1.5 pr-3"><span className={sub.success_rate_pct >= 99 ? 'text-green-600 font-medium' : 'text-amber-600'}>{fmtPct(sub.success_rate_pct)}</span></td>
                    <td className="py-1.5 pr-3 text-slate-400">{timeSince(sub.last_consumed_at, asOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 6: Stream Processing ────────────────────────────────── */}
      {activeSection === 'processing' && (
        <Panel title={titleWithIcon('Stream Processing', GitBranch, `${processors.length} processors`)} data-testid="esc-section-processing">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {processors.map(proc => (
              <div key={proc.processor_id} className={`p-3 rounded-lg border ${proc.status === 'error' ? 'border-red-200 bg-red-50/20' : proc.status === 'paused' ? 'border-amber-200 bg-amber-50/20' : 'border-slate-100 hover:border-indigo-200'} transition-colors`}>
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <StatusPulse status={proc.status} />
                      <span className="text-xs font-semibold text-slate-800">{proc.name}</span>
                    </div>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${proc.type === 'pattern_detection' ? 'bg-red-50 text-red-700' : proc.type === 'correlation' ? 'bg-indigo-50 text-indigo-700' : proc.type === 'aggregation' ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'}`}>
                      {proc.type.replace('_', ' ')}
                    </span>
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${proc.status === 'running' ? 'bg-green-50 text-green-700' : proc.status === 'paused' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{proc.status}</span>
                </div>
                <p className="text-xs text-slate-500 mb-2 line-clamp-2">{proc.description}</p>
                <div className="grid grid-cols-3 gap-1 text-xs text-center">
                  <div className="p-1 bg-slate-50 rounded"><p className="font-bold text-slate-800">{fmtInt(proc.events_processed_24h)}</p><p className="text-slate-500">Processed</p></div>
                  <div className="p-1 bg-violet-50 rounded"><p className="font-bold text-violet-700">{proc.patterns_detected_24h}</p><p className="text-slate-500">Patterns</p></div>
                  <div className="p-1 bg-amber-50 rounded"><p className="font-bold text-amber-700">{proc.alerts_generated_24h}</p><p className="text-slate-500">Alerts</p></div>
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {proc.input_topics.map(t => <span key={t} className="text-xs bg-slate-50 text-slate-600 px-1 py-0.5 rounded font-mono">{t}</span>)}
                  {proc.output_topic && <><span className="text-slate-400">→</span><span className="text-xs bg-indigo-50 text-indigo-700 px-1 py-0.5 rounded font-mono">{proc.output_topic}</span></>}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 7: Replay Center ─────────────────────────────────────── */}
      {activeSection === 'replay' && (
        <Panel title={titleWithIcon('Event Replay Center', Play, `${replayJobs.length} jobs`)} data-testid="esc-section-replay">
          <div className="mb-3 p-2.5 rounded-lg border border-indigo-100 bg-indigo-50/40 flex items-center gap-2">
            <RefreshCw className="size-4 text-indigo-400 shrink-0" aria-hidden />
            <p className="text-xs text-slate-700">Replay allows re-processing events from any topic. All replays are audit-logged. Target consumer groups receive replayed events without affecting production flows.</p>
          </div>
          <div className="space-y-2">
            {replayJobs.map(job => (
              <div key={job.job_id} className="p-3 rounded-lg border border-slate-100 hover:bg-slate-50">
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-1.5 py-0.5 bg-indigo-50 text-indigo-700 rounded font-medium uppercase">{job.type}</span>
                      {job.topic && <span className="text-xs font-mono text-slate-600">{job.topic}</span>}
                      <ReplayBadge status={job.status} />
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">{job.reason}</p>
                  </div>
                  <div className="text-right text-xs text-slate-400 shrink-0">
                    <p>{fmtInt(job.event_count)} events</p>
                    {job.duration_ms && <p className="text-slate-500">{fmtMs(job.duration_ms)}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <span>By: {job.requested_by.split('@')[0]}</span>
                  <span>·</span>
                  <span>{timeSince(job.requested_at, asOf)}</span>
                  <span>·</span>
                  <span>→ {job.target_consumer_group}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 8: DLQ Management ────────────────────────────────────── */}
      {activeSection === 'dlq' && (
        <Panel title={titleWithIcon('Dead Letter Queue', AlertTriangle, `${dlqEntries.length} entries`)} data-testid="esc-section-dlq">
          {dlqEntries.filter(d => d.status === 'pending' || d.status === 'retrying').length > 0 && (
            <div className="mb-3 p-2.5 rounded-lg border border-amber-200 bg-amber-50 flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-500 shrink-0" aria-hidden />
              <p className="text-xs text-amber-700">
                <strong>{dlqEntries.filter(d => d.status === 'pending').length}</strong> messages pending retry ·
                <strong className="ml-1">{dlqEntries.filter(d => d.status === 'retrying').length}</strong> actively retrying
              </p>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['DLQ ID', 'Event Type', 'Topic', 'Error Code', 'Failure Reason', 'Retries', 'Status', 'Recovery'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dlqEntries.map(entry => (
                  <tr key={entry.dlq_id} className={`border-b border-slate-50 hover:bg-slate-50 ${entry.status === 'abandoned' ? 'bg-red-50/20' : ''}`}>
                    <td className="py-1.5 pr-3 font-mono text-slate-600">{entry.dlq_id}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-700">{entry.event_type}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-500">{entry.topic}</td>
                    <td className="py-1.5 pr-3"><span className="text-xs bg-red-50 text-red-700 px-1.5 py-0.5 rounded font-mono">{entry.error_code}</span></td>
                    <td className="py-1.5 pr-3 text-slate-600 max-w-48 truncate">{entry.failure_reason}</td>
                    <td className="py-1.5 pr-3"><span className={`font-medium ${entry.retry_count >= entry.max_retries ? 'text-red-600' : 'text-slate-600'}`}>{entry.retry_count}/{entry.max_retries}</span></td>
                    <td className="py-1.5 pr-3"><DlqBadge status={entry.status} /></td>
                    <td className="py-1.5 pr-3 text-slate-400 max-w-40 truncate">{entry.recovery_action ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 9: AI Event Insights ────────────────────────────────── */}
      {activeSection === 'insights' && (
        <Panel title={titleWithIcon('AI Event Insights', Brain, `${insights.length} insights`)} data-testid="esc-section-insights">
          <div className="space-y-3">
            {insights.map(insight => {
              const sevColors = { critical: 'border-l-red-400 bg-red-50/20', warning: 'border-l-amber-400 bg-amber-50/20', info: 'border-l-blue-400 bg-blue-50/20' };
              const typeIcons: Record<string, LucideIcon> = { anomaly: AlertTriangle, bottleneck: Activity, trend: TrendingUp, forecast: Target };
              const TypeIcon = typeIcons[insight.type] ?? Brain;
              return (
                <div key={insight.insight_id} className={`rounded-lg border border-l-4 p-3 ${sevColors[insight.severity]}`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2">
                      <TypeIcon className="size-4 text-slate-500 shrink-0" aria-hidden />
                      <span className="text-sm font-semibold text-slate-800">{insight.title}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium uppercase ${insight.severity === 'critical' ? 'bg-red-100 text-red-700' : insight.severity === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{insight.severity}</span>
                      <span className="text-xs bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded font-mono">{insight.affected_topic}</span>
                    </div>
                    <span className="text-xs text-indigo-600 font-semibold shrink-0">{Math.round(insight.confidence_score * 100)}%</span>
                  </div>
                  <p className="text-xs text-slate-600 mb-2">{insight.description}</p>
                  <p className="text-xs text-slate-700 flex items-start gap-1.5">
                    <ChevronRight className="size-3 text-green-400 shrink-0 mt-0.5" aria-hidden />
                    <span><strong>Recommendation:</strong> {insight.recommendation}</span>
                  </p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-400">
                    <span>Type: <strong className="text-slate-600">{insight.type}</strong></span>
                    <span>·</span>
                    <span>Metric: <strong className="text-slate-600">{insight.metric_value}</strong></span>
                    <span>·</span>
                    <span>{timeSince(insight.detected_at, asOf)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ─── Section 10: Executive Stream View ────────────────────────────── */}
      {activeSection === 'executive' && (
        <Panel title={titleWithIcon('Executive Stream View', Award, 'Enterprise event intelligence')} data-testid="esc-section-executive">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Enterprise Events 24h" value={fmtInt(execView.enterprise_events_24h)}  tone="neutral" testId="esc-exec-total" />
            <MetricCard label="Critical Events"        value={fmtInt(execView.critical_events_24h)}   tone="danger"  testId="esc-exec-critical" />
            <MetricCard label="Event Health Score"     value={`${execView.event_health_score}/100`}    tone={execView.event_health_score >= 85 ? 'success' : 'warning'} testId="esc-exec-health" />
            <div className="p-3 rounded-lg border border-indigo-100 bg-indigo-50/40">
              <p className="text-xs text-slate-500 font-medium mb-1">Board Summary</p>
              <p className="text-xs text-slate-700 line-clamp-3">{execView.board_summary}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Top Risk Streams</p>
              <div className="space-y-2">
                {execView.top_risk_streams.map(s => (
                  <div key={s.topic} className="flex items-center gap-2 p-2 rounded-lg border border-slate-100">
                    <span className="font-mono text-xs text-slate-700 flex-1">{s.topic}</span>
                    <span className="text-xs text-slate-500">{fmtInt(s.events)}</span>
                    <span className={`text-xs font-medium ${s.trend === 'up' ? 'text-red-600' : s.trend === 'down' ? 'text-green-600' : 'text-slate-400'}`}>{s.trend === 'up' ? '↑' : s.trend === 'down' ? '↓' : '─'}</span>
                    <span className={`text-xs ${parseFloat(s.critical_pct.toString()) > 10 ? 'text-red-600 font-medium' : 'text-slate-500'}`}>{s.critical_pct}% critical</span>
                  </div>
                ))}
              </div>

              <p className="text-xs font-semibold text-slate-700 mt-3 mb-2">AI Decision Streams</p>
              <div className="space-y-1.5">
                {execView.ai_decision_streams.map(s => (
                  <div key={s.metric} className="flex justify-between items-center text-xs py-1 border-b border-slate-50">
                    <span className="text-slate-500">{s.metric}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-slate-800">{s.value}</span>
                      <span className={s.trend === 'up' ? 'text-green-500' : s.trend === 'down' ? 'text-red-500' : 'text-slate-400'}>{s.trend === 'up' ? '↑' : s.trend === 'down' ? '↓' : '─'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Compliance Streams</p>
              <div className="space-y-2">
                {execView.compliance_stream_status.map(s => (
                  <div key={s.topic} className="p-2 rounded-lg border border-slate-100">
                    <p className="text-xs font-mono text-slate-700 mb-1">{s.topic}</p>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">{fmtInt(s.events)} events</span>
                      <span className={`font-medium ${s.sla_met_pct >= 99 ? 'text-green-600' : 'text-amber-600'}`}>SLA: {fmtPct(s.sla_met_pct)}</span>
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-xs font-semibold text-slate-700 mt-3 mb-2">Top Insights</p>
              {execView.top_3_insights.map((ins, i) => (
                <p key={i} className="text-xs text-slate-600 flex items-start gap-1.5 mb-1.5">
                  <ArrowRight className="size-3 text-indigo-400 shrink-0 mt-0.5" aria-hidden />
                  {ins}
                </p>
              ))}
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Hourly Volume (last 12h)</p>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={execView.event_volume_by_hour} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="hour" tick={{ fontSize: 8 }} />
                  <YAxis tick={{ fontSize: 8 }} />
                  <Tooltip contentStyle={{ fontSize: 10 }} formatter={(v: number) => [fmtInt(v), '']} />
                  <Area type="monotone" dataKey="total" stroke="#6366F1" fill="#6366F1" fillOpacity={0.15} name="Total" />
                  <Area type="monotone" dataKey="critical" stroke="#EF4444" fill="#EF4444" fillOpacity={0.2} name="Critical" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Cross-IA footer ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1 border-t border-slate-100">
        <span className="font-medium text-slate-500">Event Streaming Center · Phase 22</span>
        <span>·</span>
        {[
          ['/board-reporting-center', 'Board Reporting'],
          ['/ai-decisioning-center', 'AI Decisioning'],
          ['/autonomous-risk-center', 'AI Agents'],
          ['/integration-marketplace', 'Integrations'],
          ['/audit-center', 'Audit Center'],
          ['/regulatory-compliance-center', 'Compliance'],
          ['/data-fabric-center', 'Data Fabric'],
        ].map(([path, label]) => (
          <Link key={path} to={path} className="hover:text-indigo-600 transition-colors">{label}</Link>
        ))}
        <span className="ml-auto text-slate-300">All 22 IA overlays active</span>
      </div>

    </div>
  );
}
