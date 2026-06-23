# Page-Content Responsiveness (< lg) — Design

> UI-only, additive. No business logic / API / route / RBAC change. className-only edits — never touch text/role/testid. Continues the responsive-nav thread (dialog standardization → page h-scroll → mobile drawer → drawer focus-trap → **this**).

## Problem

The app shell + 54 dialogs are responsive, but **page content** still assumes desktop width. Below `lg` (1024px) two recurring patterns break:

1. **DataTable clips.** `web/src/components/ui/DataTable.tsx` wraps the `<table>` in `overflow-hidden` (line 32). On narrow viewports wide tables (alerts/cases/customers/rules/audit) are **clipped**, not scrollable — columns vanish off the right edge with no way to reach them.
2. **Bare multi-column grids cramp.** 42 `grid-cols-{3,4,5}` sites have no breakpoint prefix → KPI/metric rows stay N-up at any width, squashing each card to unreadable widths on phones.

Charts are mostly fine (40 already `ResponsiveContainer`); 9 fixed-pixel-width chart sites are a minor tail.

## Non-goals (YAGNI)

- No per-page bespoke layout rewrites. 146 pages compose shared primitives — fix the primitives + sweep the grids, don't hand-tune each page.
- No two-pane/detail-page collapse work (separate future pick if a specific page still reads badly after this).
- No content/copy/data/logic change of any kind.

## Design

### Slice 1 — DataTable horizontal scroll (highest leverage, 1 file)

`web/src/components/ui/DataTable.tsx`: the outer `<div className="overflow-hidden rounded-[14px] border …">` keeps its rounded border/shadow, but the `<table>` must become horizontally scrollable on overflow. Approach: keep the bordered container, wrap the `<table>` in an inner `overflow-x-auto` div, and give the table a sensible `min-w` (e.g. `min-w-[640px]`) so columns keep their width and the row scrolls instead of squashing. Rounded corners preserved by keeping `overflow-hidden` on the border container and `overflow-x-auto` on the inner scroll layer.

Net effect: **every** table-driven page becomes usable < lg in one edit. Existing `DataTable.test` asserts on cell text/empty-state/row content (not the wrapper class) → low risk; re-run to confirm.

### Slice 2 — bare-grid sweep (42 sites, ~30 files)

Mechanical className transform, **each site eyeballed** to confirm it's a KPI/metric/stat row (not a table-header grid, calendar grid, or `<dl>` definition list that should stay fixed):

- `grid-cols-3` → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`
- `grid-cols-4` → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`
- `grid-cols-5` → `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`

Batched by module area to keep diffs reviewable. Any site that is genuinely meant to stay N-up (rare) is left alone and noted. `<dl>`/`<ol>` grids (AdminServiceClients line 247, OnboardingTenant line 139) evaluated individually — stack them too unless that breaks a step-rail layout.

### Slice 3 — fixed-width charts (9 sites)

Fixed `width={N}` on a recharts component → wrap in `ResponsiveContainer width="100%" height={N}` (or set the chart `width="100%"`), matching the 40 sites that already do this. Lowest priority; smallest blast radius.

## Verification

- Per slice: full `npx vitest run` green + `npx tsc --noEmit | grep "error TS" | grep -vc "mocks/handlers.ts"` = 0 (19 pre-existing handlers.ts errors excluded).
- End: live Playwright at 375 / 768 / 1024 on a table page (e.g. `/alerts` or `/customers`) + a KPI dashboard — confirm tables scroll, KPI rows stack, no page h-scroll.
- Commit per slice; push once at end.

## Test-safety contract

className-only. Never rename/remove a `data-testid`, role, or visible text. The AppShell lesson: a transformed/scrollable element stays in the a11y tree, so `getByRole`/`getByText`/`getByTestId` queries are unaffected.
