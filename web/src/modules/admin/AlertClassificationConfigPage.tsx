// web/src/modules/admin/AlertClassificationConfigPage.tsx
//
// Master Setup — Alert Classification Setup (MASTER SETUP spec screen #12).
//
// Operator-editable RAG (Red / Amber / Green) score bands. The page edits TWO
// boundaries (green→amber, amber→red) that derive a contiguous 3-band
// partition — gaps/overlaps are structurally impossible. Per-band "action
// required" text is independently editable. A "test a score" box shows which
// band any score lands in (calls the same classifier the runtime uses).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  api,
  type RagBandShape,
  type RagClassificationBandShape,
  type ScoreClassificationShape,
} from '@/lib/api';

export function AlertClassificationConfigPage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const canEdit = user?.roles.includes('admin') ?? false;

  const cfgQ = useQuery({
    queryKey: ['acc-config'],
    queryFn: () => api.alertClassificationConfig(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['acc-config'] });

  const cfg = cfgQ.data;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Alert Classification Setup"
        subtitle="RAG score bands — Green / Amber / Red thresholds + actions"
        actions={
          <Button variant="ghost" onClick={invalidate} data-testid="acc-refresh">
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      {cfgQ.isLoading || !cfg ? (
        <p className="text-sm text-muted">Loading classification config…</p>
      ) : (
        <>
          <BandCards bands={cfg.bands} canEdit={canEdit} onSaved={invalidate} />
          {canEdit && (
            <BoundaryEditor amberMin={cfg.amber_min} redMin={cfg.red_min} onSaved={invalidate} />
          )}
          <TestScorePanel />
          {canEdit && (
            <div className="text-right">
              <ResetButton onReset={invalidate} />
            </div>
          )}
          <p className="text-xs text-muted">
            Last updated {new Date(cfg.updated_at).toLocaleString()} by {cfg.updated_by}.
          </p>
        </>
      )}
    </div>
  );
}

const BAND_BG: Record<RagBandShape, string> = {
  green: 'border-emerald-300 bg-emerald-50',
  amber: 'border-amber-300 bg-amber-50',
  red: 'border-rose-300 bg-rose-50',
};
const BAND_DOT: Record<RagBandShape, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
};

function BandCards({
  bands,
  canEdit,
  onSaved,
}: {
  bands: RagClassificationBandShape[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="acc-band-cards">
      {bands.map((b) => (
        <BandCard key={b.band} b={b} canEdit={canEdit} onSaved={onSaved} />
      ))}
    </div>
  );
}

function BandCard({
  b,
  canEdit,
  onSaved,
}: {
  b: RagClassificationBandShape;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [action, setAction] = useState(b.action_required);
  const [lastServer, setLastServer] = useState(b.action_required);
  if (b.action_required !== lastServer) {
    setLastServer(b.action_required);
    setAction(b.action_required);
  }
  const [err, setErr] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: () => api.alertClassificationSetAction(b.band, action.trim()),
    onSuccess: onSaved,
    onError: (e: unknown) => {
      const x = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setErr(x.response?.data?.error?.message ?? x.message ?? 'Save failed');
    },
  });

  const dirty = action.trim() !== b.action_required && action.trim().length > 0;

  return (
    <div className={`rounded-lg border p-4 ${BAND_BG[b.band]}`} data-testid={`acc-band-${b.band}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-block h-3 w-3 rounded-full ${BAND_DOT[b.band]}`} />
        <span className="font-semibold">{b.label}</span>
        <span className="ml-auto font-mono text-sm" data-testid={`acc-range-${b.band}`}>
          {b.range_label}
        </span>
      </div>
      <label className="block text-xs font-semibold uppercase text-muted mb-1">Action required</label>
      {canEdit ? (
        <div className="flex gap-2">
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="flex-1 rounded border border-divider px-2 py-1 text-sm"
            data-testid={`acc-action-${b.band}`}
          />
          <Button
            variant="ghost"
            onClick={() => saveMut.mutate()}
            disabled={!dirty || saveMut.isPending}
            data-testid={`acc-action-save-${b.band}`}
            aria-label={`Save ${b.label} action`}
          >
            <Save size={14} />
          </Button>
        </div>
      ) : (
        <p className="text-sm">{b.action_required}</p>
      )}
      {err && <p className="mt-1 text-xs text-rose-700">{err}</p>}
    </div>
  );
}

function BoundaryEditor({
  amberMin,
  redMin,
  onSaved,
}: {
  amberMin: number;
  redMin: number;
  onSaved: () => void;
}) {
  const [amber, setAmber] = useState(String(amberMin));
  const [red, setRed] = useState(String(redMin));
  const [lastA, setLastA] = useState(amberMin);
  const [lastR, setLastR] = useState(redMin);
  if (amberMin !== lastA) {
    setLastA(amberMin);
    setAmber(String(amberMin));
  }
  if (redMin !== lastR) {
    setLastR(redMin);
    setRed(String(redMin));
  }
  const [err, setErr] = useState<string | null>(null);

  const a = Number(amber);
  const r = Number(red);
  const valid = Number.isFinite(a) && Number.isFinite(r) && a > 0 && r > a;

  const saveMut = useMutation({
    mutationFn: () => api.alertClassificationSetBoundaries(a, r),
    onSuccess: () => {
      setErr(null);
      onSaved();
    },
    onError: (e: unknown) => {
      const x = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setErr(x.response?.data?.error?.message ?? x.message ?? 'Save failed');
    },
  });

  return (
    <Panel title="Band boundaries">
      <p className="text-xs text-muted mb-3">
        Green is below the amber boundary; Amber spans the two boundaries; Red is at or above the red
        boundary. Bands are contiguous by construction — no gaps possible.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-semibold uppercase text-muted mb-1">Green → Amber (amber_min)</label>
          <Input
            type="number"
            value={amber}
            onChange={(e) => setAmber(e.target.value)}
            className="w-32"
            data-testid="acc-amber-min"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase text-muted mb-1">Amber → Red (red_min)</label>
          <Input
            type="number"
            value={red}
            onChange={(e) => setRed(e.target.value)}
            className="w-32"
            data-testid="acc-red-min"
          />
        </div>
        <Button variant="primary" onClick={() => saveMut.mutate()} disabled={!valid || saveMut.isPending} data-testid="acc-boundaries-save">
          <Save size={14} /> {saveMut.isPending ? 'Saving…' : 'Save boundaries'}
        </Button>
      </div>
      {!valid && (
        <p className="mt-2 text-xs text-amber-700" data-testid="acc-boundaries-invalid">
          <AlertTriangle size={12} className="inline mr-1" />
          amber_min must be &gt; 0 and red_min must be &gt; amber_min.
        </p>
      )}
      {err && (
        <p className="mt-2 text-xs text-rose-700" data-testid="acc-boundaries-error">
          {err}
        </p>
      )}
    </Panel>
  );
}

function TestScorePanel() {
  const [score, setScore] = useState('75');
  const [result, setResult] = useState<ScoreClassificationShape | null>(null);

  const runMut = useMutation({
    mutationFn: () => api.alertClassificationClassify(Number(score)),
    onSuccess: (r) => setResult(r),
  });

  const numeric = Number.isFinite(Number(score));

  return (
    <Panel title="Test a score">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-semibold uppercase text-muted mb-1">Composite risk score</label>
          <Input type="number" value={score} onChange={(e) => setScore(e.target.value)} className="w-32" data-testid="acc-test-score" />
        </div>
        <Button variant="primary" onClick={() => runMut.mutate()} disabled={!numeric || runMut.isPending} data-testid="acc-test-run">
          <FlaskConical size={14} /> Classify
        </Button>
      </div>
      {result && (
        <div className="mt-3 flex items-center gap-3 rounded border p-3" data-testid="acc-test-result" style={{ borderColor: result.color_hex }}>
          <span className="inline-block h-4 w-4 rounded-full" style={{ backgroundColor: result.color_hex }} />
          <span className="font-semibold" data-testid="acc-test-band">
            {result.label}
          </span>
          <span className="text-sm text-muted">→ {result.action_required}</span>
        </div>
      )}
    </Panel>
  );
}

function ResetButton({ onReset }: { onReset: () => void }) {
  const m = useMutation({
    mutationFn: () => api.alertClassificationReset(),
    onSuccess: onReset,
  });
  return (
    <Button
      variant="ghost"
      onClick={() => {
        if (window.confirm('Reset RAG bands to defaults (60 / 100)? This overwrites your boundaries + actions.')) {
          m.mutate();
        }
      }}
      disabled={m.isPending}
      data-testid="acc-reset"
    >
      <RotateCcw size={14} /> Reset to defaults
    </Button>
  );
}
