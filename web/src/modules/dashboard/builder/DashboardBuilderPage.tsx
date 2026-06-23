// DashboardBuilderPage.tsx
//
// ZorEWS — Enterprise Dashboard Builder
// Drag-and-drop dashboard composition with widget marketplace,
// role templates, personalization, sharing, and export.
//
// Route: /dashboards/builder  (additive — no existing routes changed)
// RBAC: analyst+ (same gate as /reports/builder)

import { useState, useMemo, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, RotateCcw, Copy, Share2, Download,
  LayoutDashboard, Grip, X, Settings2, Star, StarOff,
  Globe, Users, Lock, ChevronDown,
  Search, Grid3x3, ArrowUpRight, Zap,
  FileText, FileSpreadsheet, Image, Send,
  AlertOctagon, Bell, FolderOpen, Shield, Database,
  Gauge, Cpu, Banknote, Heart, Landmark, BarChart2,
  CheckCircle2, BookOpen,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui';
import { useAuth } from '@/store/auth';

// Engine imports
import {
  WIDGET_MARKETPLACE, getWidgetsByCategory, searchWidgets,
  CATEGORY_LABELS, SIZE_LABELS,
  type MarketplaceCategory, type MarketplaceWidget,
} from './widgetMarketplace';
import {
  loadLayouts, saveLayouts, createLayout, addWidget, removeWidget,
  updateWidgetConfig, duplicateLayout, toggleFavorite,
  publishLayout, resetToTemplate, nextAvailableRow,
  ROLE_TEMPLATES,
  type DashboardLayout, type PlacedWidget, type RoleTemplateId,
  type DashboardAccess,
} from './dashboardBuilderEngine';
import {
  generateShareToken, buildShareUrl, copyShareUrlToClipboard,
  exportDashboardPdf, exportDashboardExcel, publishToTeam,
  getTeamLayouts,
} from './dashboardSharing';

// ─── Icon map ─────────────────────────────────────────────────────────────

const LUCIDE_MAP: Record<string, React.ElementType> = {
  'alert-octagon': AlertOctagon, 'bell': Bell, 'folder-open': FolderOpen,
  'shield': Shield, 'database': Database, 'gauge': Gauge, 'cpu': Cpu,
  'banknote': Banknote, 'heart': Heart, 'landmark': Landmark,
  'bar-chart-2': BarChart2, 'trending-up': ArrowUpRight, 'grid': Grid3x3,
  'clock': AlertOctagon, 'shield-check': CheckCircle2, 'book-open': BookOpen,
  'zap': Zap, 'sparkles': Star, 'pie-chart': BarChart2, 'activity': BarChart2,
  'users': Users, 'percent': BarChart2, 'map-pin': Globe, 'map': Globe,
  'calendar': AlertOctagon, 'user-check': Users, 'alert-triangle': AlertOctagon,
  'file-text': FileText, 'filter': Settings2, 'git-branch': BarChart2,
  'rotate-ccw': RotateCcw, 'search': Search, 'layers': Database,
  'brain-circuit': Cpu, 'clipboard-list': FileText, 'dollar-sign': BarChart2,
  'briefcase': FolderOpen, 'shield-alert': Shield, 'bar-chart': BarChart2,
};

function WidgetIcon({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  const Icon = LUCIDE_MAP[name] ?? BarChart2;
  return <Icon size={size} className={className} strokeWidth={1.75} />;
}

// ─── Category icon component ──────────────────────────────────────────────

const CAT_ICON_MAP: Record<MarketplaceCategory, React.ElementType> = {
  kpi: BarChart2, alerts: Bell, investigations: Search,
  compliance: Shield, data_fabric: Database, executive: Gauge,
  ai_insights: Cpu, collections: Banknote, insurance: Heart, banking: Landmark,
};

// ─── Placed widget card ───────────────────────────────────────────────────

function PlacedWidgetCard({
  placed, widget, onRemove, onConfigure, isSelected, onSelect,
}: {
  placed: PlacedWidget;
  widget: MarketplaceWidget | undefined;
  onRemove: () => void;
  onConfigure: () => void;
  isSelected: boolean;
  onSelect: () => void;
}) {
  if (!widget) return null;
  const Icon = LUCIDE_MAP[widget.icon] ?? BarChart2;
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group relative rounded-[10px] border transition-all cursor-pointer h-full bg-white',
        isSelected
          ? 'border-[#4F46E5] shadow-[0_0_0_2px_rgba(79,70,229,0.15)]'
          : 'border-[#E5E7EB] hover:border-[#4F46E5]/40 hover:shadow-sm',
      )}
    >
      {/* Drag handle */}
      <div className="absolute top-2 left-2 opacity-0 group-hover:opacity-60 transition-opacity cursor-grab">
        <Grip size={12} className="text-[#9CA3AF]" />
      </div>
      {/* Controls */}
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={e => { e.stopPropagation(); onConfigure(); }}
          className="w-5 h-5 rounded bg-white border border-[#E5E7EB] flex items-center justify-center hover:bg-[#F3F4F6]"
          title="Configure widget"
        >
          <Settings2 size={9} className="text-[#6B7280]" />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className="w-5 h-5 rounded bg-white border border-[#E5E7EB] flex items-center justify-center hover:bg-red-50 hover:border-red-200"
          title="Remove widget"
        >
          <X size={9} className="text-[#6B7280] hover:text-red-500" />
        </button>
      </div>
      {/* Content */}
      <div className="p-3 flex flex-col h-full min-h-[80px]">
        <div className="flex items-center gap-1.5 mb-1.5">
          <div className="w-6 h-6 rounded-[6px] bg-[#EEF2FF] flex items-center justify-center shrink-0">
            <Icon size={12} className="text-[#4F46E5]" strokeWidth={2} />
          </div>
          <p className="text-[11px] font-semibold text-[#111827] leading-tight truncate">
            {placed.title ?? widget.name}
          </p>
        </div>
        <p className="text-[9.5px] text-[#9CA3AF] leading-snug line-clamp-2 flex-1">
          {widget.description}
        </p>
        <div className="mt-1.5 flex items-center gap-1">
          <span className="text-[8.5px] bg-[#F3F4F6] text-[#6B7280] px-1.5 py-[1px] rounded-full">
            {widget.category.replace('_', ' ')}
          </span>
          <span className="text-[8.5px] text-[#9CA3AF]">
            {SIZE_LABELS[widget.size]}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Widget Config Panel ──────────────────────────────────────────────────

function WidgetConfigPanel({
  placed, widget, onUpdate, onClose,
}: {
  placed: PlacedWidget;
  widget: MarketplaceWidget;
  onUpdate: (config: Partial<typeof placed.config>, title?: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(placed.title ?? '');
  const [domain, setDomain] = useState(placed.config.domain ?? 'both');
  const [timeRange, setTimeRange] = useState(placed.config.timeRange ?? '30d');
  const [severity, setSeverity] = useState(placed.config.severity ?? 'all');
  const [threshold, setThreshold] = useState(String(placed.config.threshold ?? ''));
  const [showTrend, setShowTrend] = useState(placed.config.showTrend ?? true);
  const [limit, setLimit] = useState(String(placed.config.limit ?? ''));

  const apply = () => {
    onUpdate({
      domain: domain as typeof placed.config.domain,
      timeRange: timeRange as typeof placed.config.timeRange,
      severity: severity as typeof placed.config.severity,
      threshold: threshold ? Number(threshold) : undefined,
      showTrend,
      limit: limit ? Number(limit) : undefined,
    }, title || undefined);
    onClose();
  };

  return (
    <div className="absolute right-0 top-0 w-[260px] bg-white border border-[#E5E7EB] rounded-[12px] shadow-xl z-50 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12px] font-bold text-[#111827]">Configure Widget</p>
        <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#374151]"><X size={14} /></button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-wide">Title Override</label>
          <input value={title} onChange={e => setTitle(e.target.value)}
            placeholder={widget.name}
            className="mt-1 w-full text-[11px] border border-[#E5E7EB] rounded-[6px] px-2 py-1.5 focus:outline-none focus:border-[#4F46E5]" />
        </div>
        {widget.configKeys.includes('domain') && (
          <div>
            <label className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-wide">Domain</label>
            <select value={domain} onChange={e => setDomain(e.target.value as typeof domain)}
              className="mt-1 w-full text-[11px] border border-[#E5E7EB] rounded-[6px] px-2 py-1.5 focus:outline-none">
              <option value="both">Both</option>
              <option value="banking">Banking</option>
              <option value="insurance">Insurance</option>
            </select>
          </div>
        )}
        {widget.configKeys.includes('timeRange') && (
          <div>
            <label className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-wide">Time Range</label>
            <select value={timeRange} onChange={e => setTimeRange(e.target.value as typeof timeRange)}
              className="mt-1 w-full text-[11px] border border-[#E5E7EB] rounded-[6px] px-2 py-1.5 focus:outline-none">
              {[['1d','Today'],['7d','7 Days'],['30d','30 Days'],['90d','90 Days'],['1y','1 Year'],['all','All Time']].map(([v,l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
        )}
        {widget.configKeys.includes('severity') && (
          <div>
            <label className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-wide">Severity Filter</label>
            <select value={severity} onChange={e => setSeverity(e.target.value as typeof severity)}
              className="mt-1 w-full text-[11px] border border-[#E5E7EB] rounded-[6px] px-2 py-1.5 focus:outline-none">
              {[['all','All'],['critical','Critical'],['high','High'],['medium','Medium'],['low','Low']].map(([v,l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
        )}
        {widget.configKeys.includes('threshold') && (
          <div>
            <label className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-wide">Alert Threshold</label>
            <input type="number" value={threshold} onChange={e => setThreshold(e.target.value)}
              placeholder="e.g. 0.60"
              className="mt-1 w-full text-[11px] border border-[#E5E7EB] rounded-[6px] px-2 py-1.5 focus:outline-none" />
          </div>
        )}
        {widget.configKeys.includes('limit') && (
          <div>
            <label className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-wide">Max Items</label>
            <input type="number" value={limit} onChange={e => setLimit(e.target.value)}
              placeholder="e.g. 10"
              className="mt-1 w-full text-[11px] border border-[#E5E7EB] rounded-[6px] px-2 py-1.5 focus:outline-none" />
          </div>
        )}
        {widget.configKeys.includes('showTrend') && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={showTrend} onChange={e => setShowTrend(e.target.checked)}
              className="rounded border-[#E5E7EB] text-[#4F46E5]" />
            <span className="text-[11px] text-[#374151]">Show trend indicator</span>
          </label>
        )}
        <button onClick={apply}
          className="w-full bg-[#4F46E5] text-white text-[11px] font-semibold py-1.5 rounded-[6px] hover:bg-[#4338CA] transition-colors">
          Apply Changes
        </button>
      </div>
    </div>
  );
}

// ─── Share Modal ──────────────────────────────────────────────────────────

function ShareModal({ layout, onClose }: { layout: DashboardLayout; onClose: () => void }) {
  const user = useAuth(s => s.user);
  const [copied, setCopied] = useState(false);
  const [access, setAccess] = useState<'view' | 'clone'>('view');
  const [teamName, setTeamName] = useState('Risk Team');
  const shareLink = generateShareToken(layout.id, user?.username ?? 'admin', access);
  const shareUrl  = buildShareUrl(shareLink.share_token);

  const copy = async () => {
    const ok = await copyShareUrlToClipboard(shareLink.share_token);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const publishTeam = () => {
    publishToTeam(layout, teamName, user?.username ?? 'admin');
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
      <div className="bg-white rounded-[14px] shadow-2xl w-[420px] p-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[14px] font-bold text-[#111827]">Share Dashboard</p>
          <button onClick={onClose}><X size={16} className="text-[#9CA3AF]" /></button>
        </div>
        {/* Share link */}
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-wide mb-2">Share Link</p>
          <div className="flex items-center gap-1.5 mb-2">
            {(['view','clone'] as const).map(a => (
              <button key={a} onClick={() => setAccess(a)}
                className={cn('px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-colors',
                  access === a ? 'bg-[#4F46E5] text-white' : 'bg-[#F3F4F6] text-[#6B7280] hover:bg-[#E5E7EB]')}>
                {a === 'view' ? '👁 View Only' : '📋 Allow Clone'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input readOnly value={shareUrl}
              className="flex-1 text-[10.5px] bg-[#F9FAFB] border border-[#E5E7EB] rounded-[6px] px-2.5 py-1.5 truncate text-[#6B7280]" />
            <button onClick={copy}
              className={cn('px-3 py-1.5 rounded-[6px] text-[11px] font-semibold transition-colors',
                copied ? 'bg-green-600 text-white' : 'bg-[#4F46E5] text-white hover:bg-[#4338CA]')}>
              {copied ? '✓ Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-[9.5px] text-[#9CA3AF] mt-1">Link expires in 7 days</p>
        </div>
        {/* Team publish */}
        <div className="border-t border-[#F3F4F6] pt-4 mb-4">
          <p className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-wide mb-2">Publish to Team</p>
          <div className="flex items-center gap-2">
            <select value={teamName} onChange={e => setTeamName(e.target.value)}
              className="flex-1 text-[11px] border border-[#E5E7EB] rounded-[6px] px-2 py-1.5 focus:outline-none">
              {['Risk Team', 'Compliance Team', 'Executive Team', 'Collections Team', 'Fraud Team'].map(t => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <button onClick={publishTeam}
              className="flex items-center gap-1.5 bg-[#059669] text-white px-3 py-1.5 rounded-[6px] text-[11px] font-semibold hover:bg-[#047857]">
              <Send size={11} /> Publish
            </button>
          </div>
        </div>
        {/* Access levels */}
        <div className="border-t border-[#F3F4F6] pt-4">
          <p className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-wide mb-2">Layout Visibility</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {([['private','Private','Lock',],[['team','Team','Users',],['org','Organisation','Globe',]]] as const).flat().map(([val, label, icon]) => {
              const Icon = icon === 'Lock' ? Lock : icon === 'Users' ? Users : Globe;
              return (
                <div key={val}
                  className={cn('flex flex-col items-center gap-1 p-2 rounded-[8px] border text-center cursor-default',
                    layout.access === val ? 'border-[#4F46E5] bg-[#EEF2FF]' : 'border-[#E5E7EB]')}>
                  <Icon size={14} className={layout.access === val ? 'text-[#4F46E5]' : 'text-[#9CA3AF]'} />
                  <p className={cn('text-[9.5px] font-medium', layout.access === val ? 'text-[#4F46E5]' : 'text-[#6B7280]')}>{label}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────

export function DashboardBuilderPage() {
  const user = useAuth(s => s.user);
  const username = user?.username ?? 'admin';

  const [layouts, setLayouts]           = useState<DashboardLayout[]>(() => loadLayouts());
  const [activeId, setActiveId]         = useState<string | null>(null);
  const [catFilter, setCatFilter]       = useState<MarketplaceCategory | 'all'>('all');
  const [widgetSearch, setWidgetSearch] = useState('');
  const [selectedPlacement, setSelectedPlacement] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [showShare, setShowShare]       = useState(false);
  const [showExport, setShowExport]     = useState(false);
  const [nameInput, setNameInput]       = useState('');
  const [sidebarMode, setSidebarMode]   = useState<'marketplace' | 'layouts'>('marketplace');
  const [shareLink, setShareLink]       = useState('');

  const active = useMemo(() => layouts.find(l => l.id === activeId) ?? null, [layouts, activeId]);

  // Persist on every change
  useEffect(() => { saveLayouts(layouts); }, [layouts]);

  const mutate = useCallback((fn: (l: DashboardLayout) => DashboardLayout) => {
    if (!activeId) return;
    setLayouts(prev => prev.map(l => l.id === activeId ? fn(l) : l));
    setSelectedPlacement(null);
    setConfiguringId(null);
  }, [activeId]);

  // ── Create new layout ──
  const createNew = (templateId?: RoleTemplateId) => {
    const name = nameInput.trim() || 'My Dashboard';
    const layout = createLayout(name, username, templateId);
    setLayouts(prev => [...prev, layout]);
    setActiveId(layout.id);
    setNameInput('');
  };

  // ── Add widget from marketplace ──
  const dropWidget = (widget: MarketplaceWidget) => {
    if (!active) return;
    const row = nextAvailableRow(active);
    mutate(l => addWidget(l, widget, 1, row));
  };

  // ── Filtered marketplace widgets ──
  const filteredWidgets = useMemo(() => {
    let list = catFilter === 'all' ? WIDGET_MARKETPLACE : getWidgetsByCategory(catFilter as MarketplaceCategory);
    if (widgetSearch) list = searchWidgets(widgetSearch);
    return list;
  }, [catFilter, widgetSearch]);

  // ── Publish helpers ──
  const handlePublish = (access: DashboardAccess) => {
    mutate(l => publishLayout(l, access));
  };

  const handleShare = () => {
    if (!active) return;
    const token = generateShareToken(active.id, username);
    setShareLink(buildShareUrl(token.share_token));
    setShowShare(true);
  };

  void shareLink; // used in ShareModal via generateShareToken

  return (
    <div className="flex flex-col h-full min-h-screen bg-[#F5F7FA]">
      {/* ── Top Header ────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-[#E5E7EB] px-4 py-3 flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <LayoutDashboard size={16} className="text-[#4F46E5]" strokeWidth={2} />
          <p className="text-[14px] font-bold text-[#111827]">Dashboard Builder</p>
          <Badge tone="blue">Beta</Badge>
        </div>

        {active && (
          <>
            <div className="h-5 w-px bg-[#E5E7EB]" />
            <input
              value={active.name}
              onChange={e => mutate(l => ({ ...l, name: e.target.value, updated_at: new Date().toISOString() }))}
              className="text-[13px] font-medium text-[#111827] bg-transparent border-none outline-none min-w-0 max-w-[200px]"
              placeholder="Dashboard name…"
            />
            <div className="flex items-center gap-1 ml-auto">
              {/* Favorite */}
              <button onClick={() => mutate(l => toggleFavorite(l))}
                className="w-8 h-8 rounded-[6px] flex items-center justify-center hover:bg-[#F3F4F6] transition-colors"
                title={active.is_favorite ? 'Remove favorite' : 'Add favorite'}>
                {active.is_favorite
                  ? <Star size={14} className="text-amber-500 fill-amber-500" />
                  : <StarOff size={14} className="text-[#9CA3AF]" />}
              </button>
              {/* Reset */}
              {active.template_id && (
                <button onClick={() => mutate(l => resetToTemplate(l))}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] text-[11px] text-[#6B7280] hover:bg-[#F3F4F6] transition-colors"
                  title="Reset to template">
                  <RotateCcw size={11} /> Reset
                </button>
              )}
              {/* Duplicate */}
              <button
                onClick={() => {
                  const clone = duplicateLayout(active, username);
                  setLayouts(prev => [...prev, clone]);
                  setActiveId(clone.id);
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] text-[11px] text-[#6B7280] hover:bg-[#F3F4F6] transition-colors">
                <Copy size={11} /> Duplicate
              </button>
              {/* Share */}
              <button onClick={handleShare}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] text-[11px] text-[#4F46E5] hover:bg-[#EEF2FF] transition-colors">
                <Share2 size={11} /> Share
              </button>
              {/* Export */}
              <div className="relative">
                <button onClick={() => setShowExport(v => !v)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-[6px] text-[11px] text-[#6B7280] hover:bg-[#F3F4F6] transition-colors">
                  <Download size={11} /> Export <ChevronDown size={9} />
                </button>
                {showExport && (
                  <div className="absolute right-0 top-full mt-1 w-[150px] bg-white border border-[#E5E7EB] rounded-[8px] shadow-lg z-50 py-1">
                    <button onClick={() => { exportDashboardPdf(active.name); setShowExport(false); }}
                      className="flex items-center gap-2 px-3 py-1.5 hover:bg-[#F3F4F6] w-full text-left text-[11px] text-[#374151]">
                      <FileText size={11} /> PDF
                    </button>
                    <button onClick={() => { exportDashboardExcel(active); setShowExport(false); }}
                      className="flex items-center gap-2 px-3 py-1.5 hover:bg-[#F3F4F6] w-full text-left text-[11px] text-[#374151]">
                      <FileSpreadsheet size={11} /> Excel / CSV
                    </button>
                    <button onClick={() => { window.print(); setShowExport(false); }}
                      className="flex items-center gap-2 px-3 py-1.5 hover:bg-[#F3F4F6] w-full text-left text-[11px] text-[#374151]">
                      <Image size={11} /> PNG Snapshot
                    </button>
                  </div>
                )}
              </div>
              {/* Publish */}
              <div className="relative">
                <button
                  onClick={() => handlePublish('org')}
                  className={cn(
                    'flex items-center gap-1 px-3 py-1.5 rounded-[6px] text-[11px] font-semibold transition-colors',
                    active.status === 'published'
                      ? 'bg-green-600 text-white'
                      : 'bg-[#4F46E5] text-white hover:bg-[#4338CA]',
                  )}>
                  {active.status === 'published' ? <><CheckCircle2 size={11} /> Published</> : <><Globe size={11} /> Publish</>}
                </button>
              </div>
            </div>
          </>
        )}

        {!active && (
          <div className="ml-auto flex items-center gap-2">
            <Link to="/dashboards/role-based"
              className="flex items-center gap-1 text-[11px] text-[#4F46E5] hover:underline">
              ← Role-Based Dashboard <ArrowUpRight size={10} />
            </Link>
          </div>
        )}
      </div>

      {/* ── Main 3-pane layout ────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT: Widget marketplace + saved layouts ──────────────── */}
        <aside className="w-[240px] shrink-0 bg-white border-r border-[#E5E7EB] flex flex-col overflow-hidden">
          {/* Tab switcher */}
          <div className="flex border-b border-[#F3F4F6]">
            {(['marketplace', 'layouts'] as const).map(mode => (
              <button key={mode} onClick={() => setSidebarMode(mode)}
                className={cn(
                  'flex-1 py-2 text-[10.5px] font-semibold transition-colors',
                  sidebarMode === mode
                    ? 'text-[#4F46E5] border-b-2 border-[#4F46E5]'
                    : 'text-[#9CA3AF] hover:text-[#374151]',
                )}>
                {mode === 'marketplace' ? '🧩 Widgets' : '📂 Layouts'}
              </button>
            ))}
          </div>

          {sidebarMode === 'marketplace' ? (
            <>
              {/* Search */}
              <div className="px-2.5 py-2 border-b border-[#F3F4F6]">
                <div className="flex items-center gap-1.5 bg-[#F9FAFB] border border-[#E5E7EB] rounded-[6px] px-2 py-1">
                  <Search size={10} className="text-[#9CA3AF] shrink-0" />
                  <input
                    value={widgetSearch}
                    onChange={e => setWidgetSearch(e.target.value)}
                    placeholder="Search widgets…"
                    className="bg-transparent text-[10.5px] outline-none flex-1 min-w-0 text-[#374151]"
                  />
                </div>
              </div>
              {/* Category filter */}
              <div className="px-2.5 py-1.5 border-b border-[#F3F4F6]">
                <div className="flex flex-wrap gap-1">
                  <button onClick={() => setCatFilter('all')}
                    className={cn('px-1.5 py-0.5 rounded-full text-[9px] font-medium transition-colors',
                      catFilter === 'all' ? 'bg-[#4F46E5] text-white' : 'bg-[#F3F4F6] text-[#6B7280] hover:bg-[#E5E7EB]')}>
                    All
                  </button>
                  {(Object.keys(CATEGORY_LABELS) as MarketplaceCategory[]).map(cat => {
                    const CatIcon = CAT_ICON_MAP[cat];
                    return (
                      <button key={cat} onClick={() => setCatFilter(cat)}
                        className={cn('flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium transition-colors',
                          catFilter === cat ? 'bg-[#4F46E5] text-white' : 'bg-[#F3F4F6] text-[#6B7280] hover:bg-[#E5E7EB]')}>
                        <CatIcon size={8} />
                        {cat.replace('_', ' ')}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Widget list */}
              <div className="overflow-y-auto flex-1 px-2.5 py-2 space-y-1.5">
                {filteredWidgets.length === 0 && (
                  <p className="text-[10.5px] text-[#9CA3AF] text-center py-4">No widgets match</p>
                )}
                {filteredWidgets.map(w => {
                  const Icon = LUCIDE_MAP[w.icon] ?? BarChart2;
                  return (
                    <button key={w.id}
                      onClick={() => dropWidget(w)}
                      disabled={!active}
                      title={active ? `Add "${w.name}" to dashboard` : 'Create or select a dashboard first'}
                      className={cn(
                        'w-full flex items-start gap-2 p-2 rounded-[8px] border text-left transition-all group',
                        active
                          ? 'border-[#E5E7EB] hover:border-[#4F46E5]/40 hover:bg-[#EEF2FF]/30 cursor-pointer'
                          : 'border-[#F3F4F6] opacity-40 cursor-not-allowed',
                      )}>
                      <div className="w-6 h-6 rounded-[6px] bg-[#EEF2FF] flex items-center justify-center shrink-0 mt-0.5">
                        <Icon size={12} className="text-[#4F46E5]" strokeWidth={2} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[10.5px] font-semibold text-[#111827] leading-tight truncate">{w.name}</p>
                        <p className="text-[9px] text-[#9CA3AF] leading-snug line-clamp-2 mt-0.5">{w.description}</p>
                        <p className="text-[8.5px] text-[#4F46E5] mt-0.5">{SIZE_LABELS[w.size]}</p>
                      </div>
                      <Plus size={12} className="text-[#4F46E5] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5" />
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            /* ── Saved layouts panel ── */
            <div className="overflow-y-auto flex-1 px-2.5 py-2 space-y-1.5">
              {/* Team layouts */}
              {getTeamLayouts().length > 0 && (
                <div className="mb-2">
                  <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-widest mb-1 px-0.5">Team Layouts</p>
                  {getTeamLayouts().map(tl => {
                    const layout = layouts.find(l => l.id === tl.layout_id);
                    if (!layout) return null;
                    return (
                      <button key={tl.layout_id}
                        onClick={() => setActiveId(tl.layout_id)}
                        className={cn('w-full flex items-center gap-2 p-2 rounded-[8px] border text-left transition-all',
                          activeId === tl.layout_id ? 'border-[#4F46E5] bg-[#EEF2FF]' : 'border-[#E5E7EB] hover:bg-[#F9FAFB]')}>
                        <Users size={10} className="text-[#4F46E5] shrink-0" />
                        <span className="text-[10.5px] font-medium text-[#374151] truncate">{layout.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-widest mb-1 px-0.5">My Layouts</p>
              {layouts.length === 0 && (
                <p className="text-[10.5px] text-[#9CA3AF] text-center py-4">No saved layouts yet</p>
              )}
              {[...layouts].sort((a, b) => {
                if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
                return b.updated_at.localeCompare(a.updated_at);
              }).map(l => (
                <div key={l.id}
                  className={cn('rounded-[8px] border transition-all',
                    activeId === l.id ? 'border-[#4F46E5] bg-[#EEF2FF]' : 'border-[#E5E7EB] hover:bg-[#F9FAFB]')}>
                  <button onClick={() => setActiveId(l.id)} className="w-full flex items-start gap-2 p-2 text-left">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        {l.is_favorite && <Star size={9} className="text-amber-500 fill-amber-500 shrink-0" />}
                        <p className="text-[10.5px] font-semibold text-[#111827] truncate">{l.name}</p>
                      </div>
                      <p className="text-[9px] text-[#9CA3AF]">{l.widgets.length} widgets · {l.status}</p>
                    </div>
                    <span className={cn('text-[8px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
                      l.access === 'org' ? 'bg-green-100 text-green-700' : l.access === 'team' ? 'bg-blue-100 text-blue-700' : 'bg-[#F3F4F6] text-[#6B7280]')}>
                      {l.access === 'org' ? 'Org' : l.access === 'team' ? 'Team' : 'Private'}
                    </span>
                  </button>
                  <div className="flex border-t border-[#F3F4F6] divide-x divide-[#F3F4F6]">
                    <button onClick={() => { const c = duplicateLayout(l, username); setLayouts(p => [...p, c]); setActiveId(c.id); }}
                      className="flex-1 py-1 text-[9px] text-[#6B7280] hover:bg-[#F3F4F6] flex items-center justify-center gap-0.5">
                      <Copy size={8} /> Clone
                    </button>
                    <button onClick={() => { setLayouts(p => p.filter(x => x.id !== l.id)); if (activeId === l.id) setActiveId(null); }}
                      className="flex-1 py-1 text-[9px] text-red-400 hover:bg-red-50 flex items-center justify-center gap-0.5">
                      <X size={8} /> Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ── CENTER: Canvas ────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto p-4 relative">
          {!active ? (
            /* ── Empty state ── */
            <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
              <div className="w-16 h-16 rounded-2xl bg-[#EEF2FF] flex items-center justify-center mb-4">
                <LayoutDashboard size={28} className="text-[#4F46E5]" strokeWidth={1.5} />
              </div>
              <p className="text-[16px] font-bold text-[#111827] mb-1">Build Your Dashboard</p>
              <p className="text-[12px] text-[#6B7280] mb-6 max-w-[340px]">
                Start from a role template or create a blank canvas. Drag widgets from the left panel to compose your layout.
              </p>
              {/* Create form */}
              <div className="flex items-center gap-2 mb-4">
                <input value={nameInput} onChange={e => setNameInput(e.target.value)}
                  placeholder="Dashboard name…"
                  className="text-[12px] border border-[#E5E7EB] rounded-[8px] px-3 py-2 w-[220px] focus:outline-none focus:border-[#4F46E5]" />
                <button onClick={() => createNew()}
                  className="flex items-center gap-1.5 bg-[#4F46E5] text-white px-4 py-2 rounded-[8px] text-[12px] font-semibold hover:bg-[#4338CA] transition-colors">
                  <Plus size={13} /> Blank Canvas
                </button>
              </div>
              {/* Template grid */}
              <p className="text-[11px] text-[#9CA3AF] mb-3">Or start from a role template:</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 max-w-[600px]">
                {ROLE_TEMPLATES.map(t => (
                  <button key={t.id} onClick={() => { createNew(t.id as RoleTemplateId); }}
                    className="flex flex-col items-center gap-1.5 p-3 rounded-[10px] border border-[#E5E7EB] hover:border-[#4F46E5] hover:bg-[#EEF2FF]/30 transition-all text-center">
                    <WidgetIcon name={t.icon} size={18} className="text-[#4F46E5]" />
                    <p className="text-[10px] font-semibold text-[#374151] leading-tight">{t.name}</p>
                    <p className="text-[8.5px] text-[#9CA3AF]">{t.widgets.length} widgets</p>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* ── Dashboard canvas ── */
            <div className="relative">
              {/* Canvas header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <p className="text-[12px] font-bold text-[#111827]">{active.name}</p>
                  <span className={cn('text-[9px] px-2 py-0.5 rounded-full font-medium',
                    active.status === 'published' ? 'bg-green-100 text-green-700' : 'bg-[#F3F4F6] text-[#6B7280]')}>
                    {active.status}
                  </span>
                  {active.widgets.length > 0 && (
                    <span className="text-[9px] text-[#9CA3AF]">{active.widgets.length} widgets</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {active.template_id && (
                    <span className="text-[9px] text-[#4F46E5] bg-[#EEF2FF] px-2 py-0.5 rounded-full">
                      {ROLE_TEMPLATES.find(t => t.id === active.template_id)?.name ?? 'Template'}
                    </span>
                  )}
                  <button onClick={() => { const c = duplicateLayout(active, username); setLayouts(p => [...p, c]); setActiveId(c.id); }}
                    className="flex items-center gap-1 text-[10px] text-[#6B7280] hover:text-[#374151] px-2 py-1 rounded hover:bg-[#F3F4F6]">
                    <Copy size={10} /> Duplicate
                  </button>
                </div>
              </div>

              {/* Empty canvas hint */}
              {active.widgets.length === 0 && (
                <div className="flex flex-col items-center justify-center h-[300px] border-2 border-dashed border-[#E5E7EB] rounded-[12px] text-center">
                  <Zap size={28} className="text-[#E5E7EB] mb-3" strokeWidth={1.5} />
                  <p className="text-[12px] font-medium text-[#9CA3AF]">Canvas is empty</p>
                  <p className="text-[10.5px] text-[#9CA3AF] mt-1">Click any widget in the left panel to add it here</p>
                </div>
              )}

              {/* Widget grid */}
              {active.widgets.length > 0 && (
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: 'repeat(12, 1fr)', gridAutoRows: '80px' }}
                >
                  {active.widgets.map(placed => {
                    const widget = WIDGET_MARKETPLACE.find(w => w.id === placed.widget_id);
                    const isConfiguring = configuringId === placed.placement_id;
                    return (
                      <div
                        key={placed.placement_id}
                        className="relative"
                        style={{
                          gridColumn: `${placed.col} / span ${placed.col_span}`,
                          gridRow: `${placed.row} / span ${placed.row_span}`,
                        }}
                      >
                        <PlacedWidgetCard
                          placed={placed}
                          widget={widget}
                          onRemove={() => mutate(l => removeWidget(l, placed.placement_id))}
                          onConfigure={() => setConfiguringId(isConfiguring ? null : placed.placement_id)}
                          isSelected={selectedPlacement === placed.placement_id}
                          onSelect={() => setSelectedPlacement(placed.placement_id)}
                        />
                        {/* Config panel */}
                        {isConfiguring && widget && (
                          <WidgetConfigPanel
                            placed={placed}
                            widget={widget}
                            onUpdate={(config, title) =>
                              mutate(l => updateWidgetConfig(l, placed.placement_id, config, title))
                            }
                            onClose={() => setConfiguringId(null)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </main>

        {/* ── RIGHT: Context panel ──────────────────────────────────── */}
        <aside className="w-[200px] shrink-0 bg-white border-l border-[#E5E7EB] overflow-y-auto p-3 space-y-4">
          {/* Templates quick-access */}
          <div>
            <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-widest mb-2">Role Templates</p>
            <div className="space-y-1">
              {ROLE_TEMPLATES.map(t => (
                <button key={t.id}
                  onClick={() => { if (active) mutate(l => resetToTemplate({ ...l, template_id: t.id as RoleTemplateId })); else { createNew(t.id as RoleTemplateId); } }}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[6px] hover:bg-[#F3F4F6] text-left transition-colors">
                  <WidgetIcon name={t.icon} size={11} className="text-[#4F46E5] shrink-0" />
                  <span className="text-[10px] text-[#374151] truncate">{t.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Dashboard favorites */}
          {layouts.filter(l => l.is_favorite).length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-widest mb-2">Favorites</p>
              {layouts.filter(l => l.is_favorite).map(l => (
                <button key={l.id} onClick={() => setActiveId(l.id)}
                  className={cn('flex items-center gap-1.5 w-full px-2 py-1.5 rounded-[6px] text-left transition-colors',
                    activeId === l.id ? 'bg-[#EEF2FF]' : 'hover:bg-[#F3F4F6]')}>
                  <Star size={10} className="text-amber-500 fill-amber-500 shrink-0" />
                  <span className="text-[10px] text-[#374151] truncate">{l.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Selected widget info */}
          {selectedPlacement && active && (() => {
            const placed = active.widgets.find(w => w.placement_id === selectedPlacement);
            const widget = placed ? WIDGET_MARKETPLACE.find(w => w.id === placed.widget_id) : null;
            if (!widget || !placed) return null;
            return (
              <div>
                <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-widest mb-2">Selected Widget</p>
                <div className="rounded-[8px] border border-[#E5E7EB] p-2">
                  <p className="text-[10.5px] font-semibold text-[#111827] mb-1">{widget.name}</p>
                  <p className="text-[9px] text-[#9CA3AF] mb-2">{widget.preview}</p>
                  <button onClick={() => setConfiguringId(selectedPlacement)}
                    className="flex items-center gap-1 text-[9.5px] text-[#4F46E5] hover:underline">
                    <Settings2 size={9} /> Configure
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Navigation links */}
          <div>
            <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-widest mb-2">Quick Links</p>
            <div className="space-y-1">
              {[
                ['/dashboards/role-based', 'Role Dashboard', LayoutDashboard],
                ['/', 'Main Dashboard', Grid3x3],
                ['/executive-cockpit', 'Executive Cockpit', Gauge],
              ].map(([href, label, Icon]) => (
                <Link key={href as string} to={href as string}
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded-[6px] hover:bg-[#F3F4F6] text-[10px] text-[#6B7280] hover:text-[#374151]">
                  {/* @ts-ignore */}
                  <Icon size={10} className="shrink-0" />
                  {label as string}
                </Link>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {/* ── Share Modal ───────────────────────────────────────────────── */}
      {showShare && active && (
        <ShareModal layout={active} onClose={() => setShowShare(false)} />
      )}
    </div>
  );
}
