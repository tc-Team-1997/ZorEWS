// services/bff/src/investigation_note_daily_volume.ts
//
// T6 M9.18 — Investigation note daily volume timeline.
//
// M9.14 ships per-actor authorship rollup (who wrote how many notes
// across which investigations). M9.18 is the time-axis companion:
// for each UTC day in the trailing-N-day window, count notes added.
//
// Mirror of M15.11 / M10.15 / M12.13 / M1.9 / M3.17 / M8.15 daily-
// volume pattern for the investigation-notes surface. Drives
// "are operators documenting more this quarter? when did the
// note-velocity dip?" trends in the SPA.
//
// Pure resolver — accepts the note list directly. Route handler
// drains investigations + notes via the existing store.

import type {
  CaseInvestigationStore,
  InvestigationNote,
} from './case_investigation';

// ─── Constants ───────────────────────────────────────────────────────

export const DEFAULT_NOTE_DAILY_WINDOW = 30;
export const MIN_NOTE_DAILY_WINDOW = 1;
export const MAX_NOTE_DAILY_WINDOW = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Errors ──────────────────────────────────────────────────────────

export class InvestigationNoteDailyVolumeError extends Error {
  override name = 'InvestigationNoteDailyVolumeError';
  constructor(public code: 'invalid_input', message: string) {
    super(message);
  }
}

// ─── Output shapes ───────────────────────────────────────────────────

export interface NoteDailyVolumeBucket {
  /** UTC calendar day YYYY-MM-DD. */
  date: string;
  total: number;
  /** Set-of-investigations touched on this day. */
  distinct_investigations: number;
  /** Set-of-authors who wrote a note on this day. */
  distinct_authors: number;
}

export interface InvestigationNoteDailyVolumeReport {
  tenant_id: string;
  generated_at: string;
  days: number;
  /** ISO UTC day of the oldest bucket — window_start. */
  window_start: string;
  /** ISO UTC day of the newest bucket — window_end (today UTC). */
  window_end: string;
  total_notes_in_window: number;
  /** Notes observed in the input that fell OUTSIDE the window — surfaces
   *  "are there older notes off-chart?" gap. */
  total_notes_observed: number;
  by_day: NoteDailyVolumeBucket[];
  peak_day: string | null;
  peak_count: number;
  mean_per_day: number;
  /** (second-half-mean - first-half-mean) / first-half-mean. Null when
   *  first-half=0 OR days<2 (no halves to compare). Positive = growth. */
  growth_rate: number | null;
  /** Top author by total notes within window. Canonical username asc
   *  tie-break. Null when window is empty. */
  busiest_author: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function isoUtcDay(ts: string): string | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ─── Builder ─────────────────────────────────────────────────────────

export interface NoteWithInvestigation extends InvestigationNote {
  investigation_id: string;
}

export function summarizeInvestigationNoteDailyVolume(
  tenant_id: string,
  notes: readonly NoteWithInvestigation[],
  days: number,
  now: Date,
): InvestigationNoteDailyVolumeReport {
  if (!Number.isInteger(days) || days < MIN_NOTE_DAILY_WINDOW || days > MAX_NOTE_DAILY_WINDOW) {
    throw new InvestigationNoteDailyVolumeError(
      'invalid_input',
      `days must be an integer in [${MIN_NOTE_DAILY_WINDOW}, ${MAX_NOTE_DAILY_WINDOW}]`,
    );
  }

  const endIso = now.toISOString().slice(0, 10);
  const endDate = new Date(`${endIso}T00:00:00.000Z`);
  const startDate = new Date(endDate.getTime() - (days - 1) * MS_PER_DAY);
  const startIso = startDate.toISOString().slice(0, 10);

  // Initialise buckets — every day present at 0.
  const bucketMap = new Map<
    string,
    { investigations: Set<string>; authors: Set<string>; total: number }
  >();
  for (let i = 0; i < days; i += 1) {
    const day = new Date(startDate.getTime() + i * MS_PER_DAY)
      .toISOString()
      .slice(0, 10);
    bucketMap.set(day, { investigations: new Set(), authors: new Set(), total: 0 });
  }

  let total_notes_observed = 0;
  const authorTotals = new Map<string, number>();

  for (const note of notes) {
    total_notes_observed += 1;
    const day = isoUtcDay(note.ts);
    if (day === null) continue;
    const bucket = bucketMap.get(day);
    if (!bucket) continue; // outside window
    bucket.total += 1;
    bucket.investigations.add(note.investigation_id);
    if (typeof note.author === 'string' && note.author.length > 0) {
      bucket.authors.add(note.author);
      authorTotals.set(note.author, (authorTotals.get(note.author) ?? 0) + 1);
    }
  }

  const by_day: NoteDailyVolumeBucket[] = [];
  let total_notes_in_window = 0;
  for (const [day, b] of bucketMap.entries()) {
    by_day.push({
      date: day,
      total: b.total,
      distinct_investigations: b.investigations.size,
      distinct_authors: b.authors.size,
    });
    total_notes_in_window += b.total;
  }
  by_day.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // peak_day — earliest-day-wins tie-break (`> peak_count` strict).
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const b of by_day) {
    if (b.total > peak_count) {
      peak_day = b.date;
      peak_count = b.total;
    }
  }
  if (peak_count === 0) peak_day = null;

  const mean_per_day = Math.round(total_notes_in_window / days);

  // growth_rate — second-half-mean vs first-half-mean.
  let growth_rate: number | null = null;
  if (days >= 2) {
    const mid = Math.floor(days / 2);
    const firstHalf = by_day.slice(0, mid);
    const secondHalf = by_day.slice(mid);
    const firstMean =
      firstHalf.reduce((a, b) => a + b.total, 0) / firstHalf.length;
    const secondMean =
      secondHalf.reduce((a, b) => a + b.total, 0) / secondHalf.length;
    if (firstMean > 0) {
      growth_rate = (secondMean - firstMean) / firstMean;
    }
  }

  // busiest_author — within-window only (re-walk authorTotals filtered
  // by `note ∈ window`). Build a separate window-scoped author tally.
  const windowAuthorTotals = new Map<string, number>();
  for (const note of notes) {
    const day = isoUtcDay(note.ts);
    if (day === null) continue;
    if (!bucketMap.has(day)) continue;
    if (typeof note.author !== 'string' || note.author.length === 0) continue;
    windowAuthorTotals.set(
      note.author,
      (windowAuthorTotals.get(note.author) ?? 0) + 1,
    );
  }
  let busiest_author: string | null = null;
  let busiest_count = 0;
  const sortedAuthors = [...windowAuthorTotals.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  if (sortedAuthors.length > 0) {
    busiest_author = sortedAuthors[0][0];
    busiest_count = sortedAuthors[0][1];
  }
  if (busiest_count === 0) busiest_author = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start: startIso,
    window_end: endIso,
    total_notes_in_window,
    total_notes_observed,
    by_day,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    busiest_author,
  };
}

/** Drain helper — walks every investigation in the tenant and pulls
 *  the per-investigation note list, returning a flat
 *  NoteWithInvestigation[]. Used by the route handler. Page through
 *  the M9.1 investigation store with a generous page_size; per-tenant
 *  investigation count is bounded. */
export function drainTenantNotes(
  store: CaseInvestigationStore,
  tenant_id: string,
): NoteWithInvestigation[] {
  const out: NoteWithInvestigation[] = [];
  const page = store.list(tenant_id, { page: 1, page_size: 1000 });
  for (const inv of page.items) {
    const notes = store.listNotes(tenant_id, inv.investigation_id);
    for (const n of notes) {
      out.push({ ...n, investigation_id: inv.investigation_id });
    }
  }
  return out;
}
