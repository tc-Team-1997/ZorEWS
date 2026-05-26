// web/src/modules/help/GlossaryPage.tsx
//
// M6.4 — Glossary page.
//
// Purpose: searchable glossary of domain terms referenced by every "?" tooltip
// in the SPA (see GlossaryTooltip). Admin can add/edit/delete tenant overrides;
// platform terms are read-only (DELETE writes a tombstone, not a mutation).
//
// Routes consumed:
//   - GET    /v1/glossary/categories
//   - GET    /v1/glossary/terms[?q=&category=]
//   - GET    /v1/glossary/terms/:term_id
//   - POST   /v1/glossary/terms        (admin)
//   - PUT    /v1/glossary/terms/:id    (admin)
//   - DELETE /v1/glossary/terms/:id    (admin)

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Pencil, Trash2, BookOpen, X } from 'lucide-react';
import { Badge, Button, Input, MetricCard, Panel } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api } from '@/lib/api';
import type { GlossaryTerm, GlossaryCategory, GlossaryTermCreateInput } from '@/lib/api';
import { ALL_GLOSSARY_CATEGORIES } from '@/lib/api';

type EditMode = 'create' | 'edit';

interface FormState {
  term_id: string;
  term: string;
  category: GlossaryCategory;
  definition: string;
  source_doc: string;
  related_term_ids: string;
}

const EMPTY_FORM: FormState = {
  term_id: '',
  term: '',
  category: 'banking',
  definition: '',
  source_doc: '',
  related_term_ids: '',
};

function formFromTerm(t: GlossaryTerm): FormState {
  return {
    term_id: t.term_id,
    term: t.term,
    category: t.category,
    definition: t.definition,
    source_doc: t.source_doc ?? '',
    related_term_ids: (t.related_term_ids ?? []).join(', '),
  };
}

function formToInput(f: FormState): GlossaryTermCreateInput {
  const related = f.related_term_ids
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: GlossaryTermCreateInput = {
    term_id: f.term_id.trim(),
    term: f.term.trim(),
    category: f.category,
    definition: f.definition.trim(),
  };
  if (f.source_doc.trim()) out.source_doc = f.source_doc.trim();
  if (related.length > 0) out.related_term_ids = related;
  return out;
}

export function GlossaryPage() {
  const [params, setParams] = useSearchParams();
  const focusId = params.get('focus') ?? null;
  const initialQ = params.get('q') ?? '';
  const initialCategory = (params.get('category') as GlossaryCategory | null) ?? null;

  const [q, setQ] = useState(initialQ);
  const [category, setCategory] = useState<GlossaryCategory | null>(initialCategory);
  const [activeId, setActiveId] = useState<string | null>(focusId);

  const [modalOpen, setModalOpen] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>('create');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const isAdmin = user?.roles?.includes('admin') ?? false;

  // Debounce q → URL (acceptance: search returns results in <500ms; we keep
  // the input controlled locally + reflect into URL on Enter / focus-loss so
  // deep-linkable, but UI updates immediately).
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (q) next.set('q', q);
    else next.delete('q');
    if (category) next.set('category', category);
    else next.delete('category');
    if (activeId) next.set('focus', activeId);
    else next.delete('focus');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, activeId]);

  const catsQuery = useQuery({
    queryKey: ['glossary-categories'],
    queryFn: () => api.glossaryCategories(),
    staleTime: 10 * 60 * 1000,
  });

  const listQuery = useQuery({
    queryKey: ['glossary-list', q, category ?? 'ALL'],
    queryFn: () => api.glossaryList({ q: q || undefined, category: category ?? undefined }),
  });

  const terms = useMemo(() => listQuery.data?.terms ?? [], [listQuery.data]);

  const active = useMemo(() => terms.find((t) => t.term_id === activeId) ?? terms[0] ?? null, [terms, activeId]);

  // Auto-select first match when active falls out of the filtered list.
  useEffect(() => {
    if (terms.length > 0 && !terms.find((t) => t.term_id === activeId)) {
      setActiveId(terms[0]!.term_id);
    }
    if (terms.length === 0) setActiveId(null);
  }, [terms, activeId]);

  const createMutation = useMutation({
    mutationFn: (input: GlossaryTermCreateInput) => api.glossaryCreate(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['glossary-list'] });
      qc.invalidateQueries({ queryKey: ['glossary-term'] });
      setModalOpen(false);
      setError(null);
    },
    onError: (e: unknown) => {
      const message = (e as { response?: { data?: { error?: { code?: string; message?: string } } } })
        ?.response?.data?.error?.message ?? (e instanceof Error ? e.message : 'Save failed');
      setError(message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ term_id, patch }: { term_id: string; patch: Partial<GlossaryTermCreateInput> }) =>
      api.glossaryUpdate(term_id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['glossary-list'] });
      qc.invalidateQueries({ queryKey: ['glossary-term'] });
      setModalOpen(false);
      setError(null);
    },
    onError: (e: unknown) => {
      const message = (e as { response?: { data?: { error?: { code?: string; message?: string } } } })
        ?.response?.data?.error?.message ?? (e instanceof Error ? e.message : 'Save failed');
      setError(message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (term_id: string) => api.glossaryDelete(term_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['glossary-list'] });
      qc.invalidateQueries({ queryKey: ['glossary-term'] });
      setActiveId(null);
    },
  });

  function openCreate() {
    setEditMode('create');
    setForm(EMPTY_FORM);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(t: GlossaryTerm) {
    setEditMode('edit');
    setForm(formFromTerm(t));
    setError(null);
    setModalOpen(true);
  }

  function submit() {
    const input = formToInput(form);
    if (editMode === 'create') createMutation.mutate(input);
    else {
      const { term_id: _omit, ...patch } = input;
      updateMutation.mutate({ term_id: form.term_id, patch });
    }
  }

  const total = terms.length;
  const platformCount = terms.filter((t) => (t.source ?? 'platform') === 'platform').length;
  const tenantCount = terms.length - platformCount;

  // Latency benchmark — surface tiny instrumentation on the page so an operator
  // can see the spec acceptance ("<500ms") live in dev.
  const startedAt = useRef<number | null>(null);
  if (listQuery.isFetching && startedAt.current === null) {
    startedAt.current = performance.now();
  }
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  useEffect(() => {
    if (!listQuery.isFetching && startedAt.current !== null) {
      const elapsed = performance.now() - startedAt.current;
      startedAt.current = null;
      setLastLatencyMs(elapsed);
    }
  }, [listQuery.isFetching]);

  return (
    <div className="page-pad" data-testid="glossary-page">
      <PageHeader
        title="Glossary"
        subtitle="Single source of truth for every term referenced in the SPA"
        actions={
          isAdmin ? (
            <Button onClick={openCreate} data-testid="gl-new-btn">
              <Plus className="mr-1 h-4 w-4" /> Add term
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard
          testId="gl-kpi-total"
          label="Terms"
          value={String(total)}
          sub={`${platformCount} platform, ${tenantCount} tenant`}
        />
        <MetricCard
          testId="gl-kpi-categories"
          label="Categories"
          value={String(catsQuery.data?.categories?.length ?? ALL_GLOSSARY_CATEGORIES.length)}
          sub="Banking, regulatory, AI…"
        />
        <MetricCard
          testId="gl-kpi-latency"
          label="Last search"
          value={lastLatencyMs === null ? '—' : `${Math.round(lastLatencyMs)}ms`}
          sub="Spec: <500ms"
          tone={lastLatencyMs !== null && lastLatencyMs > 500 ? 'warning' : 'neutral'}
        />
        <MetricCard
          testId="gl-kpi-tenant"
          label="Tenant overrides"
          value={String(tenantCount)}
          sub="Copy-on-write of platform"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left: search + filter + list */}
        <div className="lg:col-span-5">
          <Panel
            title="Browse"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQ('');
                  setCategory(null);
                }}
                data-testid="gl-clear-btn"
              >
                <X className="mr-1 h-3 w-3" /> Clear
              </Button>
            }
          >
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-ink-muted" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search by term, id, or definition"
                  className="pl-7"
                  data-testid="gl-search-input"
                  aria-label="Search glossary"
                />
              </div>
              <select
                value={category ?? ''}
                onChange={(e) => setCategory((e.target.value || null) as GlossaryCategory | null)}
                className="rounded border border-divider bg-surface px-2 py-1.5 text-sm"
                data-testid="gl-category-select"
                aria-label="Filter by category"
              >
                <option value="">All</option>
                {(catsQuery.data?.categories ?? ALL_GLOSSARY_CATEGORIES).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-3 max-h-[60vh] overflow-y-auto" data-testid="gl-list">
              {listQuery.isLoading && <div className="caption">Loading…</div>}
              {listQuery.isError && <div className="caption text-danger">Failed to load.</div>}
              {!listQuery.isLoading && terms.length === 0 && (
                <div className="caption text-ink-muted">
                  No terms match. {q || category ? <button onClick={() => { setQ(''); setCategory(null); }} className="text-action underline">Reset filters</button> : null}
                </div>
              )}
              <ul className="divide-y divide-divider">
                {terms.map((t) => {
                  const isActive = active?.term_id === t.term_id;
                  return (
                    <li key={t.term_id}>
                      <button
                        type="button"
                        onClick={() => setActiveId(t.term_id)}
                        aria-pressed={isActive}
                        className={`w-full text-left px-2 py-2 hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2 ${isActive ? 'bg-surface-2' : ''}`}
                        data-testid={`gl-list-item-${t.term_id}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-ink text-sm">{t.term}</span>
                          <Badge tone={t.source === 'tenant' ? 'blue' : 'neutral'}>
                            {t.source ?? 'platform'}
                          </Badge>
                        </div>
                        <div className="text-xs text-ink-muted">{t.category} · {t.term_id}</div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </Panel>
        </div>

        {/* Right: detail */}
        <div className="lg:col-span-7">
          <Panel
            title={active ? active.term : 'Select a term'}
            action={
              active && isAdmin ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(active)}
                    data-testid="gl-edit-btn"
                  >
                    <Pencil className="mr-1 h-3 w-3" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(`Delete "${active.term}"?`)) {
                        deleteMutation.mutate(active.term_id);
                      }
                    }}
                    data-testid="gl-delete-btn"
                  >
                    <Trash2 className="mr-1 h-3 w-3" /> Delete
                  </Button>
                </div>
              ) : undefined
            }
          >
            {!active ? (
              <div className="caption text-ink-muted flex items-center gap-2">
                <BookOpen className="h-4 w-4" /> Pick a term on the left.
              </div>
            ) : (
              <div className="space-y-3" data-testid={`gl-detail-${active.term_id}`}>
                <div className="flex items-center gap-2">
                  <Badge tone="neutral">{active.category}</Badge>
                  <Badge tone={active.source === 'tenant' ? 'blue' : 'neutral'}>
                    {active.source ?? 'platform'}
                  </Badge>
                  <span className="text-xs text-ink-muted">{active.term_id}</span>
                </div>
                <div className="text-sm text-ink whitespace-pre-wrap">{active.definition}</div>
                {active.source_doc && (
                  <div className="text-xs text-ink-muted">
                    <span className="uppercase tracking-wide">Source:</span> {active.source_doc}
                  </div>
                )}
                {active.related_term_ids && active.related_term_ids.length > 0 && (
                  <div className="text-xs">
                    <span className="text-ink-muted uppercase tracking-wide mr-1">Related:</span>
                    {active.related_term_ids.map((rid, idx) => (
                      <Link
                        key={rid}
                        to={`/glossary?focus=${encodeURIComponent(rid)}`}
                        onClick={() => setActiveId(rid)}
                        className="text-action hover:underline mr-2"
                      >
                        {rid}
                        {idx < active.related_term_ids!.length - 1 ? ',' : ''}
                      </Link>
                    ))}
                  </div>
                )}
                {active.updated_at && (
                  <div className="text-[10px] text-ink-muted">
                    Updated {new Date(active.updated_at).toLocaleString()}
                    {active.updated_by ? ` by ${active.updated_by}` : ''}
                  </div>
                )}
              </div>
            )}
          </Panel>
        </div>
      </div>

      {/* Admin add/edit modal */}
      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setError(null);
        }}
        ariaLabel={editMode === 'create' ? 'Add glossary term' : 'Edit glossary term'}
        size="2xl"
        testId="gl-form-modal"
      >
        <h2 className="text-lg font-semibold text-ink mb-3">
          {editMode === 'create' ? 'Add term' : `Edit ${form.term_id}`}
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-ink-muted">term_id (slug)</span>
              <Input
                value={form.term_id}
                onChange={(e) => setForm({ ...form, term_id: e.target.value })}
                disabled={editMode === 'edit'}
                placeholder="e.g. npa"
                data-testid="gl-form-term-id"
              />
            </label>
            <label className="block">
              <span className="text-xs text-ink-muted">Display name</span>
              <Input
                value={form.term}
                onChange={(e) => setForm({ ...form, term: e.target.value })}
                placeholder="e.g. NPA — Non-Performing Asset"
                data-testid="gl-form-term"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-ink-muted">Category</span>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as GlossaryCategory })}
              className="block w-full mt-1 rounded border border-divider bg-surface px-2 py-1.5 text-sm"
              data-testid="gl-form-category"
            >
              {ALL_GLOSSARY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-ink-muted">Definition</span>
            <textarea
              value={form.definition}
              onChange={(e) => setForm({ ...form, definition: e.target.value })}
              rows={5}
              className="block w-full mt-1 rounded border border-divider bg-surface px-2 py-1.5 text-sm"
              placeholder="10..4000 chars"
              data-testid="gl-form-definition"
            />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-ink-muted">Source doc (optional)</span>
              <Input
                value={form.source_doc}
                onChange={(e) => setForm({ ...form, source_doc: e.target.value })}
                placeholder="e.g. RBI Master Direction…"
                data-testid="gl-form-source-doc"
              />
            </label>
            <label className="block">
              <span className="text-xs text-ink-muted">Related term ids (comma-sep)</span>
              <Input
                value={form.related_term_ids}
                onChange={(e) => setForm({ ...form, related_term_ids: e.target.value })}
                placeholder="e.g. npa, dpd"
                data-testid="gl-form-related"
              />
            </label>
          </div>
          {error && (
            <div className="text-xs text-danger" data-testid="gl-form-error">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setModalOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="gl-form-submit"
            >
              {editMode === 'create' ? 'Add term' : 'Save'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
