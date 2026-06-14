# Enterprise Dialog Standardization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Standardize all 54 dialogs in the ZorEWS web SPA on a single `EnterpriseDialog` (thin wrapper over the existing `Modal`): one close icon, sticky header + fixed footer, standard sizes/spacing, no overflow, responsive, accessible.

**Architecture:** `EnterpriseDialog` wraps `Modal` (reusing its esc/focus/scroll-lock/aria). Additive only. Spec: `docs/superpowers/specs/2026-06-14-enterprise-dialog-standardization-design.md`.

**Tech:** React + TS + vitest. All web cmds from `/Users/chuadhary_taniya/ZorEWS/web`. Test: `npx vitest run <path>`. Types: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -vc "mocks/handlers.ts"` must be `0`.

---

## SLICE A — Framework

### Task A1: `Modal.widthClass` additive prop
**File:** `web/src/components/ui/Modal.tsx` + `web/src/__tests__/Modal.test.tsx` (or wherever Modal's test is — check `src/components/ui/__tests__/` too)
- [ ] **Test:** add a case — `render(<Modal open onClose={()=>{}} ariaLabel="x" widthClass="max-w-[720px]" testId="m">body</Modal>)` → the `m-content` element's className contains `max-w-[720px]` and NOT `max-w-2xl`. And without `widthClass`, it still contains the size default `max-w-2xl`.
- [ ] **Run → fail.**
- [ ] **Implement:** add `widthClass?: string;` to `ModalProps`. In the content `<div>` className, use `${widthClass ?? MAX_W_BY_SIZE[size]}` instead of `${MAX_W_BY_SIZE[size]}`. Nothing else changes.
- [ ] **Run → pass** + run the full existing Modal test file → all green (default path unchanged).
- [ ] **Commit:** `feat(ui): Modal optional widthClass override (additive)`

### Task A2: `EnterpriseDialog` + `DialogGrid` + `DialogFooter`
**Files:** create `web/src/components/ui/EnterpriseDialog.tsx`, `web/src/components/ui/DialogGrid.tsx`, `web/src/components/ui/DialogFooter.tsx`; export from `web/src/components/ui/index.ts`; test `web/src/__tests__/EnterpriseDialog.test.tsx`
- [ ] **Test (write first):**
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { EnterpriseDialog, DialogFooter } from '@/components/ui';
import { Button } from '@/components/ui';

test('renders title + description + single close, calls onClose', () => {
  const onClose = vi.fn();
  render(<EnterpriseDialog open onClose={onClose} title="Add factor" description="Configure a KRI" testId="ed">body</EnterpriseDialog>);
  expect(screen.getByText('Add factor')).toBeTruthy();
  expect(screen.getByText('Configure a KRI')).toBeTruthy();
  const closers = screen.getAllByTestId('ed-close');
  expect(closers.length).toBe(1);            // exactly ONE close icon
  fireEvent.click(closers[0]);
  expect(onClose).toHaveBeenCalled();
});
test('Modal built-in X is suppressed (no duplicate)', () => {
  render(<EnterpriseDialog open onClose={()=>{}} title="t" testId="ed">b</EnterpriseDialog>);
  // Modal would emit `${testId}-content`; the only close testid is ed-close (count 1, asserted above).
  expect(screen.getByTestId('ed-content')).toBeTruthy();
});
test('renders footer when provided', () => {
  render(<EnterpriseDialog open onClose={()=>{}} title="t" footer={<DialogFooter onCancel={()=>{}} primary={<Button>Save</Button>} />}>b</EnterpriseDialog>);
  expect(screen.getByText('Cancel')).toBeTruthy();
  expect(screen.getByText('Save')).toBeTruthy();
});
test('closed → renders nothing', () => {
  const { container } = render(<EnterpriseDialog open={false} onClose={()=>{}} title="t">b</EnterpriseDialog>);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
test('size maps to pixel width', () => {
  render(<EnterpriseDialog open onClose={()=>{}} title="t" size="xl" testId="ed">b</EnterpriseDialog>);
  expect(screen.getByTestId('ed-content').className).toContain('max-w-[1200px]');
});
```
- [ ] **Run → fail.**
- [ ] **Implement `EnterpriseDialog.tsx`:**
```tsx
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Modal } from './Modal';

export type EnterpriseDialogSize = 'sm' | 'md' | 'lg' | 'xl';
const WIDTH: Record<EnterpriseDialogSize, string> = {
  sm: 'max-w-[480px]', md: 'max-w-[720px]', lg: 'max-w-[960px]', xl: 'max-w-[1200px]',
};

export interface EnterpriseDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: EnterpriseDialogSize;
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  testId?: string;
  children: ReactNode;
}

export function EnterpriseDialog({
  open, onClose, title, description, size = 'md', footer,
  closeOnBackdrop, closeOnEsc, testId, children,
}: EnterpriseDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={title}
      widthClass={WIDTH[size]}
      showCloseButton={false}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEsc={closeOnEsc}
      testId={testId}
    >
      <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-aurora-line bg-white px-6 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-aurora-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid={testId ? `${testId}-close` : 'dialog-close'}
          aria-label="Close dialog"
          className="shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <X size={18} aria-hidden />
        </button>
      </header>
      <div className="px-6 py-6">{children}</div>
      {footer && (
        <footer className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-aurora-line bg-white px-6 py-3">
          {footer}
        </footer>
      )}
    </Modal>
  );
}
```
- [ ] **Implement `DialogGrid.tsx`:**
```tsx
import type { ReactNode } from 'react';
export function DialogGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 ${className}`}>{children}</div>;
}
DialogGrid.FullWidth = function FullWidth({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`md:col-span-2 ${className}`}>{children}</div>;
};
```
- [ ] **Implement `DialogFooter.tsx`:**
```tsx
import type { ReactNode } from 'react';
import { Button } from './Button';
export function DialogFooter({
  onCancel, cancelLabel = 'Cancel', secondary, primary,
}: { onCancel?: () => void; cancelLabel?: string; secondary?: ReactNode; primary?: ReactNode }) {
  return (
    <>
      {onCancel && <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>}
      {secondary}
      {primary}
    </>
  );
}
```
(Confirm `Button`'s real `variant` values from `web/src/components/ui/Button.tsx` — use the actual ghost/secondary variant names; adjust if they differ.)
- [ ] **Export** all three from `web/src/components/ui/index.ts` (+ the `EnterpriseDialogSize` type).
- [ ] **Run → pass.** `npx vitest run src/__tests__/EnterpriseDialog.test.tsx`.
- [ ] **Commit:** `feat(ui): EnterpriseDialog + DialogGrid + DialogFooter framework`

---

## SLICE B — Duplicate-close fix (14 files)
**Pattern per file:** the file uses `<Modal ...>` AND renders its own custom close `<X>`/`<button>` inside a header. **Fix = delete the custom close element** (keep Modal's built-in X). Do NOT migrate to EnterpriseDialog in this slice — minimal-diff defect fix only. After removing the custom X, if the header now has a dangling flex/justify-between with one child, leave layout intact (cosmetic only).

> Per file: Read it → find the custom `<X>`/close button inside the Modal body (NOT Modal's own) → remove just that element (+ now-unused `X` import if no longer used) → run that page's test suite + `tsc`. Commit per file OR per small batch.

Files (line hints from inventory — re-confirm by reading):
- [ ] `src/modules/admin/CaseTypeSetupPage.tsx` (custom X ~L263)
- [ ] `src/modules/admin/RiskScoreConfigPage.tsx` (~L586)
- [ ] `src/modules/admin/JobSchedulerConfigPage.tsx` (~L266)
- [ ] `src/modules/admin/MasterSetupPage.tsx` (×3 ~L335/444/550)
- [ ] `src/modules/admin/ThresholdsLimitsPage.tsx` (×2 ~L393/481)
- [ ] `src/modules/ai/ModelRegistryPage.tsx` (×3 ~L351/516/602)
- [ ] `src/modules/cms/CaseTrackingTimeline.tsx` (~L330)
- [ ] `src/modules/insurance/ChannelRiskPage.tsx` (~L297)
- [ ] `src/modules/insurance/ClaimsAnomalyPage.tsx` (~L293)
- [ ] `src/modules/insurance/FraudDetectionPage.tsx` (~L327)
- [ ] `src/modules/insurance/PolicyLapsePage.tsx` (~L308)
- [ ] `src/modules/insurance/PersistencyWatchPage.tsx` (~L243)
- [ ] `src/modules/insurance/SolvencyWatchPage.tsx` (~L258)
- [ ] `src/modules/insurance/UnderwritingDeviationPage.tsx` (~L282)
- [ ] **Verify slice:** `npx vitest run` (full) green; `tsc` clean. **Commit:** `fix(ui): remove duplicate close buttons from 14 dialogs (slice B)`

---

## SLICE C — ModalShell consolidation (5 files / 9 instances)
Replace each local `ModalShell` definition + usages with `EnterpriseDialog`. `ModalShell(title, onClose, children, testId, width)` maps directly: `<EnterpriseDialog open onClose title size={width==='wide'?'lg':'md'} testId>children</EnterpriseDialog>` (these are content/detail panels — usually no footer). Delete the local `ModalShell` function after migrating its consumers.
- [ ] `src/modules/insurance/ClaimInvestigationPage.tsx` (1 consumer)
- [ ] `src/modules/cms/CaseWorkflowPage.tsx` (3 consumers — these have submit/cancel actions → use EnterpriseDialog `footer` with DialogFooter)
- [ ] `src/modules/banking/CollectionsRiskPage.tsx` (1)
- [ ] `src/modules/banking/SectorWatchPage.tsx` (2)
- [ ] `src/modules/banking/BranchHeatmapPage.tsx` (2)
- [ ] **Verify + commit per file** (each: page test suite + tsc green). Slice commit: `refactor(ui): consolidate ModalShell → EnterpriseDialog (slice C)`

---

## SLICE D — Bespoke overlay migration (20 files → EnterpriseDialog)
Each bespoke `role="dialog"` overlay (custom backdrop + custom X + custom Esc handler) → `EnterpriseDialog`. Map: backdrop+container → EnterpriseDialog; title → `title`; form body → `children` (wrap multi-field forms in `DialogGrid`); action buttons → `footer={<DialogFooter .../>}`; delete the file's own backdrop/Esc/focus boilerplate (EnterpriseDialog/Modal provides it). For `closeOnBackdrop={false}` cases (in-progress forms), pass it through.

Batch D1 — admin forms:
- [ ] `slaConfig/CreateSlaConfigModal.tsx`, `slaConfig/SlaConfigEditModal.tsx`, `slaConfig/SlaConfigPage.tsx` (inline)
- [ ] `escalationMatrix/EscalationMatrixFormModal.tsx`
- [ ] `caseScenarios/CaseScenarioFormModal.tsx`, `caseScenarios/CaseScenarioHistoryModal.tsx`
- [ ] `notificationTemplates/NotificationTemplateFormModal.tsx`, `…PreviewModal.tsx`, `…TestFireModal.tsx`
- [ ] `userAccessOverride/OverrideFormModal.tsx`, `OverrideDetailPanel.tsx`, `EffectiveAccessPage.tsx` (inline)
- [ ] `AdminServiceClientsPage.tsx` (inline), `WebhooksPage.tsx` SecretRevealDialog (special: keep its copy-before-close UX — `closeOnBackdrop={false}`, footer with Copy + Done)

Batch D2 — ai/cms/misc:
- [ ] `ai/AiWorkbenchPage.tsx` (inline), `ai/HybridRulesPanel.tsx` (×2)
- [ ] `cms/CmsCaseListPage.tsx` (inline), `cms/SetCategoryModal.tsx`
- [ ] any remaining bespoke from the inventory not covered above
- [ ] **Verify + commit per batch** (full vitest + tsc green). Slice commit(s): `refactor(ui): migrate bespoke overlays → EnterpriseDialog (slice D1/D2)`

---

## SLICE E — Overflow + responsive + regression
- [ ] **Overflow guards:** in dialogs that render long values (customer names, case IDs, tenant IDs, KES amounts), add `truncate`/`break-words`/`min-w-0` so nothing escapes the dialog. Targets: detail panels (CollectionsRisk, SectorWatch, BranchHeatmap, ClaimInvestigation, AlertDetailModal), case/category modals. Use `truncate` + `title={fullValue}` for single-line IDs; `break-words` for free text.
- [ ] **Responsive sanity:** EnterpriseDialog is `w-full` capped at the size px with `p-4` backdrop padding (from Modal) → on < size widths it shrinks to viewport. Confirm no `min-w-[...]` inside dialogs forces horizontal scroll; fix any found. (Spot-check 480/768/1024/1280/1440 reasoning; no device farm — reason from the tailwind classes.)
- [ ] **Full regression:** `npx vitest run` (entire suite) green; `npx tsc --noEmit` excl. handlers = 0.
- [ ] **Commit:** `fix(ui): dialog overflow guards + responsive polish (slice E)`

---

## Final verification + report
- [ ] Full `npx vitest run` green; `tsc` excl-handlers 0.
- [ ] Grep: zero `<Modal>`-using files that also render a custom in-body close X (duplicate-close = 0).
- [ ] Push all slices to `main`.
- [ ] Report: dialogs audited 54 · duplicate-close removed 14 · ModalShell consolidated 9 · bespoke migrated 20 · overflow fixed · single close everywhere · suites green.

## Self-review notes
- Spec coverage: A=Phases 3-6 framework; B=Phase 2; C+D=consolidation/migration (Phases 4-6 applied); E=Phases 7-8-10. Phase 9 (a11y) inherited from Modal. Phase 1 done.
- Type consistency: `EnterpriseDialogSize` (sm/md/lg/xl) ↔ `WIDTH` map ↔ Modal `widthClass`. `DialogFooter` uses real `Button` variants (verify).
- Zero-regression: A is purely additive; B is minimal-diff defect fix; C/D swap wrappers without touching business logic/data fetching; existing page test suites must stay green at each step.
