// dashboardSharing.ts
//
// ZorEWS Dashboard Builder — Sharing & Export Engine
// Handles layout sharing, publishing, team layouts, and exports.
//
// Additive — no existing logic changed.

import type { DashboardLayout } from './dashboardBuilderEngine';

// ─── Share types ──────────────────────────────────────────────────────────

export interface ShareLink {
  layout_id:   string;
  share_token: string;
  expires_at:  string;   // ISO
  access:      'view' | 'clone';
  created_by:  string;
  created_at:  string;
  views:       number;
}

export interface TeamLayout {
  layout_id:    string;
  team_name:    string;
  published_by: string;
  published_at: string;
  pinned:       boolean;
}

export interface ExportOptions {
  format:     'pdf' | 'excel' | 'png';
  title?:     string;
  includeKPIs?: boolean;
  includeCharts?: boolean;
  landscape?: boolean;
  watermark?: string;
}

// ─── Share link management ────────────────────────────────────────────────

const SHARE_KEY = 'zorews.dashboard.share_links';

export function generateShareToken(layoutId: string, creator: string, access: 'view' | 'clone' = 'view'): ShareLink {
  const token = `shr-${layoutId.slice(0, 8)}-${Math.random().toString(36).slice(2, 10)}`;
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
  const link: ShareLink = {
    layout_id:   layoutId,
    share_token: token,
    expires_at:  expires,
    access,
    created_by:  creator,
    created_at:  new Date().toISOString(),
    views:       0,
  };
  persistShareLink(link);
  return link;
}

function persistShareLink(link: ShareLink): void {
  try {
    const raw = localStorage.getItem(SHARE_KEY);
    const links: ShareLink[] = raw ? JSON.parse(raw) : [];
    const updated = [...links.filter(l => l.layout_id !== link.layout_id), link];
    localStorage.setItem(SHARE_KEY, JSON.stringify(updated));
  } catch { /* quota */ }
}

export function getShareLinks(layoutId: string): ShareLink[] {
  try {
    const raw = localStorage.getItem(SHARE_KEY);
    const links: ShareLink[] = raw ? JSON.parse(raw) : [];
    return links.filter(l => l.layout_id === layoutId);
  } catch { return []; }
}

export function revokeShareLink(token: string): void {
  try {
    const raw = localStorage.getItem(SHARE_KEY);
    const links: ShareLink[] = raw ? JSON.parse(raw) : [];
    localStorage.setItem(SHARE_KEY, JSON.stringify(links.filter(l => l.share_token !== token)));
  } catch { /* ignore */ }
}

/** Build the shareable URL for copying to clipboard */
export function buildShareUrl(token: string): string {
  const base = window.location.origin;
  return `${base}/dashboards/shared/${token}`;
}

// ─── Team layouts ─────────────────────────────────────────────────────────

const TEAM_KEY = 'zorews.dashboard.team_layouts';

export function publishToTeam(layout: DashboardLayout, teamName: string, publisher: string): TeamLayout {
  const tl: TeamLayout = {
    layout_id:    layout.id,
    team_name:    teamName,
    published_by: publisher,
    published_at: new Date().toISOString(),
    pinned:       false,
  };
  try {
    const raw = localStorage.getItem(TEAM_KEY);
    const existing: TeamLayout[] = raw ? JSON.parse(raw) : [];
    const updated = [...existing.filter(t => t.layout_id !== layout.id), tl];
    localStorage.setItem(TEAM_KEY, JSON.stringify(updated));
  } catch { /* quota */ }
  return tl;
}

export function getTeamLayouts(): TeamLayout[] {
  try {
    const raw = localStorage.getItem(TEAM_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function pinTeamLayout(layoutId: string, pinned: boolean): void {
  try {
    const raw = localStorage.getItem(TEAM_KEY);
    const existing: TeamLayout[] = raw ? JSON.parse(raw) : [];
    const updated = existing.map(t => t.layout_id === layoutId ? { ...t, pinned } : t);
    localStorage.setItem(TEAM_KEY, JSON.stringify(updated));
  } catch { /* ignore */ }
}

export function removeFromTeam(layoutId: string): void {
  try {
    const raw = localStorage.getItem(TEAM_KEY);
    const existing: TeamLayout[] = raw ? JSON.parse(raw) : [];
    localStorage.setItem(TEAM_KEY, JSON.stringify(existing.filter(t => t.layout_id !== layoutId)));
  } catch { /* ignore */ }
}

// ─── Export helpers ───────────────────────────────────────────────────────

/**
 * Export dashboard as PNG snapshot using html-to-canvas pattern.
 * In production this would call a server-side renderer. For the prototype
 * we use a deterministic placeholder + trigger browser print.
 */
export function exportDashboardPng(_layoutName: string): void {
  const a = document.createElement('a');
  // In production: call /v1/dashboards/export/png with layout JSON
  // Prototype: trigger window.print() with a print-friendly class
  document.body.classList.add('dashboard-print-mode');
  window.print();
  setTimeout(() => document.body.classList.remove('dashboard-print-mode'), 500);
  void a;  // prevent unused warning
}

/**
 * Export dashboard as PDF using browser print dialog.
 * CSS @media print rules control the layout.
 */
export function exportDashboardPdf(layoutName: string): void {
  const title = document.title;
  document.title = `ZorEWS — ${layoutName}`;
  window.print();
  setTimeout(() => { document.title = title; }, 500);
}

/**
 * Export KPI data as Excel (CSV for prototype, XLSX in production).
 * Generates a CSV from the layout's widget configs.
 */
export function exportDashboardExcel(layout: DashboardLayout): void {
  const rows = [
    ['Dashboard Export', layout.name],
    ['Generated', new Date().toLocaleString()],
    ['Status', layout.status],
    ['Widgets', String(layout.widgets.length)],
    [],
    ['Widget ID', 'Config - Domain', 'Config - Time Range', 'Config - Severity'],
    ...layout.widgets.map(w => [
      w.widget_id,
      w.config.domain ?? 'both',
      w.config.timeRange ?? '30d',
      w.config.severity ?? 'all',
    ]),
  ];
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${layout.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Clipboard copy ───────────────────────────────────────────────────────

export async function copyShareUrlToClipboard(token: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(buildShareUrl(token));
    return true;
  } catch { return false; }
}
