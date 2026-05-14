// services/bff/src/investigation_note_search.ts
//
// T6 M9.10 — Investigation note search.
//
// M9.1 ships a per-investigation notes thread (`addNote` + `listNotes`).
// M9.10 is the cross-investigation full-text search: walk every
// investigation's notes in the tenant, find substring matches, and
// emit results with context snippets. Lets an investigator ask
// "did we ever document this in any case?" without grepping
// per-case manually.
//
// Pure — no I/O. Caller assembles the investigation + note tuples
// from the M9.1 store.

import type {
  CaseInvestigation,
  InvestigationNote,
} from './case_investigation';

// ─── Public types ─────────────────────────────────────────────────────

export interface InvestigationNotesBundle {
  investigation: CaseInvestigation;
  notes: InvestigationNote[];
}

export interface NoteMatch {
  note_id: string;
  investigation_id: string;
  case_id: string;
  ts: string;
  author: string;
  /** Up to 200 chars of context around the first match. */
  snippet: string;
  /** Total occurrence count of the query in the note body. */
  match_count_in_note: number;
}

export interface NoteSearchResult {
  query: string;
  total_matches: number;
  total_notes_searched: number;
  total_investigations_searched: number;
  matches: NoteMatch[];
}

export class NoteSearchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NoteSearchError';
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SNIPPET_WINDOW = 200;
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 200;

// ─── Pure searcher ────────────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function makeSnippet(body: string, queryLower: string, queryLen: number): string {
  const bodyLower = body.toLowerCase();
  const firstIdx = bodyLower.indexOf(queryLower);
  if (firstIdx === -1) return body.slice(0, SNIPPET_WINDOW);
  const halfWindow = Math.max(0, Math.floor((SNIPPET_WINDOW - queryLen) / 2));
  const start = Math.max(0, firstIdx - halfWindow);
  const end = Math.min(body.length, start + SNIPPET_WINDOW);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end) + suffix;
}

export function searchInvestigationNotes(
  bundles: readonly InvestigationNotesBundle[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): NoteSearchResult {
  if (typeof query !== 'string') {
    throw new NoteSearchError('invalid_input', 'query must be a string');
  }
  const q = query.trim();
  if (q.length < MIN_QUERY_LEN) {
    throw new NoteSearchError(
      'invalid_input',
      `query must be ≥ ${MIN_QUERY_LEN} chars after trim`,
    );
  }
  if (q.length > MAX_QUERY_LEN) {
    throw new NoteSearchError(
      'invalid_input',
      `query must be ≤ ${MAX_QUERY_LEN} chars`,
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new NoteSearchError(
      'invalid_input',
      `limit must be an integer in 1..${MAX_LIMIT}`,
    );
  }
  const qLower = q.toLowerCase();
  const matches: NoteMatch[] = [];
  let total_notes_searched = 0;
  for (const bundle of bundles) {
    for (const note of bundle.notes) {
      total_notes_searched += 1;
      const occurrences = countOccurrences(note.body.toLowerCase(), qLower);
      if (occurrences === 0) continue;
      matches.push({
        note_id: note.note_id,
        investigation_id: bundle.investigation.investigation_id,
        case_id: bundle.investigation.case_id,
        ts: note.ts,
        author: note.author,
        snippet: makeSnippet(note.body, qLower, q.length),
        match_count_in_note: occurrences,
      });
    }
  }
  matches.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1; // newest first
    return a.note_id < b.note_id ? -1 : a.note_id > b.note_id ? 1 : 0;
  });
  const total_matches = matches.length;
  return {
    query: q,
    total_matches,
    total_notes_searched,
    total_investigations_searched: bundles.length,
    matches: matches.slice(0, limit),
  };
}
