// services/bff/src/investigation_note_authorship.ts
//
// T6 M9.14 — Investigation note authoring activity rollup.
//
// M9.10 ships cross-investigation note SEARCH; M9.14 ships the
// AUTHOR-pivoted rollup: for every distinct note author, count their
// notes + distinct investigations touched + per-investigation-status
// breakdown of where those notes live.
//
// Surfaces "who's documenting investigations most?" — useful for
// recognising thorough investigators and spotting under-documented
// hot spots ("only one author has touched 12 of our 15 open
// investigations").
//
// Pure rollup. Walks `caseInvestigationStore.list` + per-investigation
// `listNotes` then groups by author. Mirror of M15.8 (audit per-actor
// activity) for the investigation notes surface.

import {
  type CaseInvestigation,
  type CaseInvestigationStore,
  type InvestigationNote,
  type InvestigationStatus,
  INVESTIGATION_STATUSES,
} from './case_investigation';

// ─── Public types ─────────────────────────────────────────────────────

export interface NoteAuthorRow {
  author_username: string;
  total_notes: number;
  /** Distinct investigation_ids this author has noted on. */
  distinct_investigations: number;
  /** Oldest note ts across this author's notes. */
  first_note_at: string | null;
  /** Newest note ts across this author's notes. */
  last_note_at: string | null;
  /** Per-investigation-status breakdown of WHERE this author's notes
   *  live. Every InvestigationStatus key present at 0 when absent. */
  notes_per_investigation_status: Record<InvestigationStatus, number>;
}

export interface InvestigationNoteAuthorshipSummary {
  tenant_id: string;
  generated_at: string;
  total_notes: number;
  total_distinct_authors: number;
  /** Authors sorted by total_notes desc with author_username asc
   *  tie-break. */
  authors: NoteAuthorRow[];
  /** Top author by total_notes. null when zero notes observed. */
  most_active_author: {
    author_username: string;
    total_notes: number;
  } | null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────

function emptyStatusCounts(): Record<InvestigationStatus, number> {
  const r: Record<string, number> = {};
  for (const s of INVESTIGATION_STATUSES) r[s] = 0;
  return r as Record<InvestigationStatus, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeInvestigationNoteAuthorship(
  tenant_id: string,
  store: CaseInvestigationStore,
  now: Date,
): InvestigationNoteAuthorshipSummary {
  // Drain investigations + their notes.
  const page = store.list(tenant_id, { page_size: 100000 });
  const investigations: CaseInvestigation[] = page.items;

  // Per-investigation: load notes once + carry the status forward.
  const notesByInv: Array<{ inv: CaseInvestigation; notes: InvestigationNote[] }> = [];
  for (const inv of investigations) {
    const notes = store.listNotes(tenant_id, inv.investigation_id);
    if (notes.length > 0) notesByInv.push({ inv, notes });
  }

  // Bucket by author.
  const byAuthor = new Map<string, NoteAuthorRow>();
  const investigationsByAuthor = new Map<string, Set<string>>();
  let total_notes = 0;

  for (const { inv, notes } of notesByInv) {
    for (const note of notes) {
      total_notes++;
      let row = byAuthor.get(note.author);
      if (!row) {
        row = {
          author_username: note.author,
          total_notes: 0,
          distinct_investigations: 0,
          first_note_at: null,
          last_note_at: null,
          notes_per_investigation_status: emptyStatusCounts(),
        };
        byAuthor.set(note.author, row);
        investigationsByAuthor.set(note.author, new Set());
      }
      row.total_notes++;
      row.notes_per_investigation_status[inv.status]++;
      if (!row.first_note_at || note.ts < row.first_note_at) row.first_note_at = note.ts;
      if (!row.last_note_at || note.ts > row.last_note_at) row.last_note_at = note.ts;
      investigationsByAuthor.get(note.author)!.add(inv.investigation_id);
    }
  }

  for (const [author, row] of byAuthor.entries()) {
    row.distinct_investigations = investigationsByAuthor.get(author)!.size;
  }

  const authors = [...byAuthor.values()].sort((a, b) => {
    if (b.total_notes !== a.total_notes) return b.total_notes - a.total_notes;
    return a.author_username.localeCompare(b.author_username);
  });

  const most_active_author = authors.length > 0
    ? { author_username: authors[0]!.author_username, total_notes: authors[0]!.total_notes }
    : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_notes,
    total_distinct_authors: authors.length,
    authors,
    most_active_author,
  };
}
