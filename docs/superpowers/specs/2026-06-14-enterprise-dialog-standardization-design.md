# Enterprise Dialog & Modal Standardization — Design

**Date:** 2026-06-14 · **Type:** UI standardization (no business-logic / API / route changes) · **Status:** approved (full sweep A→E)

## Objective
Platform-wide audit + remediation of every dialog/modal/drawer/overlay in the ZorEWS web SPA: eliminate duplicate close buttons, standardize header/footer/sizing/spacing, fix overflow, guarantee responsive + accessible behavior. Target: Oracle FCCM / Moody's / SAS / Actimize / Fenergo-grade modal experience.

## Phase-1 Inventory (audit complete — 54 dialogs)
| Bucket | Count |
|---|---|
| Shared `Modal` (a11y already done) | 29 |
| **Duplicate-close defect** (`<Modal>` + custom X) | 14 |
| Duplicate local `ModalShell` wrapper | 5 files / 9 instances |
| Bespoke `role="dialog"` overlays | 20 |
| Specialized (drawer / ⌘K palette / chat widget / notification bell) | 4 — **excluded** |

## Architecture decision
**`EnterpriseDialog` is a THIN WRAPPER over the existing battle-tested `Modal`** (`web/src/components/ui/Modal.tsx`) — NOT a from-scratch component. Rationale: `Modal` already provides Escape-close, focus-in-on-open + restore, body-scroll-lock, `role="dialog"`+`aria-modal`+`aria-label`, backdrop-click, `max-h-[90vh]`, `showCloseButton`, `closeOnBackdrop`, `closeOnEsc`, `size`, `testId`. 29 files + their tests depend on it. Reusing it gives Phase-9 accessibility for free and keeps everything additive/zero-regression.

### Single additive change to `Modal`
Add ONE optional prop `widthClass?: string`. When provided it REPLACES the `MAX_W_BY_SIZE[size]` width class on the content container; when absent, behavior is byte-identical (all 29 existing usages + `Modal.test` unaffected). This lets EnterpriseDialog hit the exact spec widths (480/720/960/1200) that tailwind's `max-w-*` scale doesn't cover.

### `EnterpriseDialog` API
```tsx
type EnterpriseDialogSize = 'sm' | 'md' | 'lg' | 'xl'; // 480 / 720 / 960 / 1200 px
interface EnterpriseDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;                 // sticky-header title (also the aria-label)
  description?: string;          // optional sticky-header subtitle
  size?: EnterpriseDialogSize;   // default 'md' (720)
  footer?: ReactNode;            // fixed footer content (compose with DialogFooter)
  closeOnBackdrop?: boolean;     // passthrough to Modal (default true)
  closeOnEsc?: boolean;          // passthrough (default true)
  testId?: string;
  children: ReactNode;           // body (independent scroll)
}
```
**Renders** (inside `<Modal showCloseButton={false} widthClass={WIDTH[size]} ariaLabel={title} ...>`):
- **Sticky header** (`sticky top-0 z-10 bg-white border-b border-aurora-line px-6 py-4`): `{title}` (+ `{description}`) on the left, **the SINGLE close X** on the right (`<X size={18}/>`, `data-testid="${testId}-close"`, `aria-label="Close dialog"`). Because Modal's own X is suppressed (`showCloseButton={false}`), a duplicate close is structurally impossible.
- **Body** (`px-6 py-6`): `{children}`. The Modal content container is `max-h-[90vh] overflow-y-auto`, so the sticky header/footer stay pinned while the body scrolls — "body scrolls independently".
- **Sticky footer** (only when `footer` set; `sticky bottom-0 z-10 bg-white border-t border-aurora-line px-6 py-3 flex items-center justify-end gap-3`): `{footer}`. Primary button is rightmost by layout.

### `DialogGrid` helper
```tsx
<DialogGrid>…fields…</DialogGrid>   // grid grid-cols-1 md:grid-cols-2 gap-4   (16px field gap)
<DialogGrid.FullWidth>…</DialogGrid.FullWidth>  // col-span-2 for textareas/wide fields
```
Section gap (24px) = wrap sections in `space-y-6`. Dialog padding (24px) = the body's `px-6 py-6` + footer/header `px-6`. **Applied where it genuinely helps** (multi-field forms) — NOT forced on single-field/confirmation dialogs (would look worse).

### `DialogFooter` helper
```tsx
<DialogFooter
  onCancel={…} cancelLabel="Cancel"      // ghost button, left
  secondary={…}                           // optional secondary action, middle
  primary={<Button>Save</Button>}         // primary, right-aligned
/>
```
Enforces the standard order **Cancel | Secondary | Primary** with the primary always rightmost. Examples: `Cancel | Save`, `Cancel | Analyze`, `Cancel | Generate Report`, `Cancel | Create Case`.

## Reasoned exclusions (NOT migrated to EnterpriseDialog)
These are not modal dialogs; forcing them into EnterpriseDialog would be wrong. Only verify they keep Esc-close + aria:
- `RiskTrendConfigDrawer` — slide-in drawer (3-panel, live preview).
- `CommandPalette` (⌘K) — keyboard-driven command interface.
- `ChatWidget` — floating fixed-position Copilot widget.
- `NotificationBell` — header dropdown/popover.

## Execution slices (full sweep)
- **A — Framework:** `Modal.widthClass` prop + `EnterpriseDialog` + `DialogGrid` + `DialogFooter` + tests.
- **B — Duplicate-close fix (14 files):** drop the custom X (Modal/EnterpriseDialog provides the single one). Quick win.
- **C — ModalShell consolidation (5 files / 9 instances):** replace local `ModalShell` definitions with `EnterpriseDialog`.
- **D — Bespoke overlay migration (20 files):** `role="dialog"` overlays → `EnterpriseDialog` (batched: admin-forms, banking, insurance, cms/misc).
- **E — Overflow + responsive + regression:** truncate/ellipsis on long IDs/names/tenant/currency in dialogs; validate 1440/1280/1024/768/480; full vitest + tsc green.

## Constraints
- Additive UI-only. No business logic, API, or route changes. No RBAC change. Existing page test suites stay green.
- Per-task local commits; push once at end of each slice (or end of sweep).
- Leave the 4 specialized components + any unrelated stray files untouched.

## Acceptance / final report
Dialogs audited (54) · duplicate-close removed (14) · ModalShell consolidated (9) · bespoke migrated (20) · overflow fixed · responsive validated · single close icon everywhere · full vitest + tsc green.
