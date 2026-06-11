// services/bff/src/audit_chain_completeness.ts
//
// T6 M15.23 — Audit chain completeness check.
//
// Pure function that inspects a tenant's AuditEvent[] for structural
// issues: out-of-order timestamps, prev_hash linkage gaps, and
// computes a completeness_score (0-100; 100 = perfect chain).

import type { AuditEvent } from './audit_trail';

// ─── Public types ──────────────────────────────────────────────────────

export type ChainIssueType = 'gap' | 'out_of_order' | 'broken_hash';

export interface ChainIssue {
  type: ChainIssueType;
  event_id: string;
  description: string;
}

export interface AuditChainCompleteness {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  has_gaps: boolean;
  gap_count: number;
  out_of_order_count: number;
  broken_hash_links: number;
  completeness_score: number;
  issues: ChainIssue[];
  is_complete: boolean;
}

// ─── Pure function ─────────────────────────────────────────────────────

export function buildAuditChainCompleteness(
  tenant_id: string,
  events: AuditEvent[],
  now: Date,
): AuditChainCompleteness {
  const generated_at = now.toISOString();
  const total_events = events.length;
  const issues: ChainIssue[] = [];

  if (total_events === 0) {
    return {
      tenant_id,
      generated_at,
      total_events: 0,
      has_gaps: false,
      gap_count: 0,
      out_of_order_count: 0,
      broken_hash_links: 0,
      completeness_score: 100,
      issues: [],
      is_complete: true,
    };
  }

  // Sort by ts ascending for analysis
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.ts).getTime();
    const tb = new Date(b.ts).getTime();
    return ta - tb;
  });

  let gap_count = 0;
  let out_of_order_count = 0;
  let broken_hash_links = 0;

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (!ev) continue;

    // Check out-of-order: if timestamp is before previous
    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev) {
        const tCur = new Date(ev.ts).getTime();
        const tPrev = new Date(prev.ts).getTime();
        if (tCur < tPrev) {
          out_of_order_count++;
          issues.push({
            type: 'out_of_order',
            event_id: ev.event_id,
            description: `Event timestamp ${ev.ts} is before previous event ${prev.ts}`,
          });
        }

        // Check prev_hash linkage
        if (
          ev.prev_hash &&
          prev.hash &&
          ev.prev_hash !== 'GENESIS' &&
          prev.hash !== '' &&
          ev.prev_hash !== prev.hash
        ) {
          broken_hash_links++;
          issues.push({
            type: 'broken_hash',
            event_id: ev.event_id,
            description: `prev_hash ${ev.prev_hash.slice(0, 8)}… does not match previous event hash ${prev.hash.slice(0, 8)}…`,
          });
        }

        // Check gap: if event_ids look sequential (e.g. contain numeric suffix)
        // and there's a jump > 1, flag as gap. Only flag when both IDs have
        // a numeric suffix pattern for deterministic detection.
        const prevNum = extractSeqNum(prev.event_id);
        const curNum = extractSeqNum(ev.event_id);
        if (prevNum !== null && curNum !== null && curNum - prevNum > 1) {
          gap_count++;
          issues.push({
            type: 'gap',
            event_id: ev.event_id,
            description: `Sequence gap detected: previous sequence ${prevNum}, current ${curNum}`,
          });
        }
      }
    } else {
      // First event: check it has GENESIS as prev_hash
      if (ev.prev_hash && ev.prev_hash !== 'GENESIS' && ev.prev_hash !== '') {
        broken_hash_links++;
        issues.push({
          type: 'broken_hash',
          event_id: ev.event_id,
          description: `First event should have prev_hash=GENESIS but has ${ev.prev_hash.slice(0, 16)}`,
        });
      }
    }
  }

  const issue_count = gap_count + out_of_order_count + broken_hash_links;
  // Score: 100 - (issues / total * 100), clamped 0..100
  const penalty = total_events > 0 ? (issue_count / total_events) * 100 : 0;
  const completeness_score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  return {
    tenant_id,
    generated_at,
    total_events,
    has_gaps: gap_count > 0,
    gap_count,
    out_of_order_count,
    broken_hash_links,
    completeness_score,
    issues,
    is_complete: completeness_score >= 95,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function extractSeqNum(event_id: string): number | null {
  // Matches trailing numeric portion, e.g. "ev-12345" → 12345
  const m = event_id.match(/[-_](\d+)$/);
  if (m && m[1]) return parseInt(m[1], 10);
  return null;
}
