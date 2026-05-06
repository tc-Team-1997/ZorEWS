# EWS Rules-Plus — Operator Guide

This is the day-to-day reference for the Rules-Plus extensions shipped as RP-1 (backend) + RP-2 (SPA). Read alongside [`ews-rules-engine-readme.md`](./ews-rules-engine-readme.md) — that base engine stays untouched; Rules-Plus adds versioning + 4-eyes maker-checker + clone + diff + a 4-step wizard.

For the design decisions and 8-task brief mapping, read [`ews-rules-plus-mapping.md`](./ews-rules-plus-mapping.md).

---

## What Rules-Plus adds

| Capability | Where | Backed by |
|---|---|---|
| SemVer versions per rule | `ews_rule_versions` table | `bumpSemver()` + `recordSubmission()` |
| 4-eyes maker-checker | `/approve` + `/reject` routes | `approveWithFourEyes()` |
| Clone (deprecated → new draft) | `/clone` route | `buildCloneInput()` |
| Field-by-field diff | `/versions/diff` route | `diffRuleSnapshots()` |
| 4-step modal wizard | `/rules/ews/wizard` (SPA) | `EwsRuleWizardPage` |
| Auto-save 30s + Cmd+S / Esc / Cmd+Enter | wizard | `localStorage` draft + window keydown |
| Side-by-side colored diff viewer | per-row 3-dot icon | `EwsRuleDiffViewer` |
| Inline Test Rule preview | step 2 of wizard | pure client simulator (mirrors BFF executor) |

---

## File map

| Concern | Path |
|---|---|
| RP-1 versions module | `services/bff/src/ews_rules_versions.ts` |
| RP-1 routes | `services/bff/src/server.ts` (search "RP-1") |
| RP-1 DB migration | `data/schema/015_ews_rules_versions.sql` |
| RP-1 tests (51) | `services/bff/__tests__/ews_rules_versions.test.ts` |
| RP-2 wizard | `web/src/modules/rules/EwsRuleWizardPage.tsx` |
| RP-2 diff viewer | `web/src/modules/rules/EwsRuleDiffViewer.tsx` |
| RP-2 API client + draft helpers | `web/src/modules/rules/rulesPlusApi.ts` |
| RP-2 tests (14) | `web/src/__tests__/EwsRuleWizardPage.test.tsx` + `EwsRuleDiffViewer.test.tsx` |
| Architecture mapping | `docs/ews-rules-plus-mapping.md` |
| Postman collection | `docs/ews-rules-plus-postman.json` |
| **This file** | `docs/ews-rules-plus-readme.md` |

---

## Operator path — author + activate a new rule

### 1. Open the wizard

Click **4-step wizard** in the header on `/rules/ews`. Lands you at `/rules/ews/wizard`. Auto-save kicks in every 30 seconds — your draft survives accidental close + refresh.

### 2. Step 1 — Basic Info

- `rule_id` — pattern `RULE_<UPPER>_<NNN>` (e.g. `RULE_LIQ_002`).
- `name`, `description`, `category` (10 enum values).

Press **Cmd+S** anytime to save the draft now.

### 3. Step 2 — Conditions + inline Test

- Add 1–12 conditions; pick `field` from the indicator dropdown (auto-populated from `/v1/ews/rules/indicators`).
- Logic: `AND` (all) or `OR` (any).
- The **Test rule** panel below the conditions runs a pure client-side simulator — no save required. Type values for the fields you've picked, click **Run test**. The MATCH banner shows whether the rule fires + the score impact (== `weight`).

The full server-side test is also still available via `/v1/ews/rules/:id/test` after the rule is saved.

### 4. Step 3 — Action

- `alert_severity` — RED · ORANGE · YELLOW · GREEN.
- `weight` (1–100). Cumulative across matches caps at 100. Aggregate: ≥75 RED · ≥50 ORANGE · ≥25 YELLOW.
- `recommended_action` — optional free-form note.

### 5. Step 4 — Lifecycle

- "Activate immediately after create" checkbox — best-effort: tries the 4-eyes path (`/submit` + `/approve`); falls back to legacy `/activate` if self-approval is refused. Default leaves the rule in DRAFT and lets a colleague approve.

### 6. Save the rule

**Cmd+S** on step 4 (or click **Save rule**). The wizard POSTs to `/v1/ews/rules`, clears the localStorage draft, and redirects to `/rules/ews`.

### Keyboard shortcuts

| Key | Action |
|---|---|
| **Cmd/Ctrl+S** | Save draft (steps 1–3) or submit (step 4) |
| **Esc** | Cancel the wizard, navigate back to `/rules/ews` |
| **Cmd/Ctrl+Enter** | Advance to next step |

---

## Maker-Checker (4-eyes)

The user who **created** or **last submitted** the rule cannot approve it. Refused at the application layer (`EWS_403_self_approval_refused`) and at the DB layer (`CHECK approver_username IS NULL OR approver_username <> maker_username`).

```bash
# Maker — submits for review
curl -X POST $BFF/v1/ews/rules/RULE_FOO_001/submit \
  -H "X-APEX-USER: jane.maker" -H "x-apex-role: risk_analyst" \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -d '{"reason": "Threshold tuned per April loss review"}'

# Checker — different user — approves
curl -X POST $BFF/v1/ews/rules/RULE_FOO_001/approve \
  -H "X-APEX-USER: bob.checker" -H "x-apex-role: rules_admin" \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -d '{"reason": "Reviewed; aligns with policy 4.2"}'

# Same maker tries to approve → 403 self_approval_refused
curl -X POST $BFF/v1/ews/rules/RULE_FOO_001/approve \
  -H "X-APEX-USER: jane.maker" ...
# → { "error": { "code": "EWS_403_self_approval_refused", ... } }
```

Pending approval shows up in `/v1/ews/rules/:id/approvals` until decided. Decision rows are immutable — every decision creates a new row.

---

## SemVer

| Change kind | Bump |
|---|---|
| New rule | starts at `0.1.0` |
| Edit conditions / action / category | **MINOR** (1.4.0 → 1.5.0) |
| Edit metadata only (name / description / tags) | **PATCH** (1.4.0 → 1.4.1) |
| Submit / approve / reject | no bump |
| Clone | new rule_id, version reset to `0.1.0` |
| Cumulative breaking change (manual) | **MAJOR** |

`classifyEditBump(prev, next)` decides minor vs patch by inspecting the diffable fields. Versions are capped at 50 per rule (FIFO eviction).

---

## Diff Viewer

From the rule list, click the **GitCompare** icon on any row. Selectors default to **newest → previous**. The viewer fetches `/versions/diff` and renders one card per changed field with rose-50 (before) and emerald-50 (after) panels.

```bash
curl -X POST $BFF/v1/ews/rules/RULE_FOO_001/versions/diff \
  -H "X-APEX-USER: jane" -H "x-apex-role: risk_analyst" \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -d '{"from": "0.1.0", "to": "0.2.0"}'
```

`diff` rows have `kind: 'changed' | 'added' | 'removed'`. `change_count` is the row total.

---

## Clone

Click the **Copy** icon on any rule (including DEPRECATED ones — that's the whole point: you can't edit DEPRECATED, but you can clone to a fresh DRAFT). The modal pre-fills `<rule_id>_COPY` and `<name> (copy)`. Submitting POSTs to `/clone` and returns a new rule at `0.1.0` in DRAFT.

```bash
curl -X POST $BFF/v1/ews/rules/RULE_FOO_001/clone \
  -H "X-APEX-USER: jane" -H "x-apex-role: risk_analyst" \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -d '{"new_rule_id": "RULE_FOO_002", "new_name": "High EMI bounce — tighter"}'
```

---

## RBAC

| Operation | Capability | Maker | Checker | Admin |
|---|---|---|---|---|
| Create / edit DRAFT | `rules:create` | ✓ | – | ✓ |
| Submit for review | `rules:create` | ✓ | – | ✓ |
| **Approve** | `rules:retire` | **refused** | ✓ | ✓ (when not maker) |
| **Reject** | `rules:retire` | **refused** | ✓ | ✓ (when not maker) |
| Deprecate | `rules:retire` | ✓ | ✓ | ✓ |
| Clone | `rules:create` | ✓ | ✓ | ✓ |
| View versions / diff | `rules:read` | ✓ | ✓ | ✓ |

---

## Tests

- **RP-1 BFF**: 51 tests in `__tests__/ews_rules_versions.test.ts`. Covers SemVer helpers, store CRUD, FIFO cap, all 7 routes, 4-eyes refusal, no-regression on existing `/test` + `/activate`. Run isolated with `npx jest ews_rules_versions`.
- **RP-2 SPA**: 14 tests across `EwsRuleWizardPage.test.tsx` (10) and `EwsRuleDiffViewer.test.tsx` (4). Step nav, Cmd+S / Esc / Cmd+Enter, draft reload, auto-save fires at 30s, save POST + clear draft + redirect, diff render, modal close.
- Full BFF regression: 103 suites / 3474 tests pass under `--maxWorkers=2`.

---

## 8-task brief — mapping to shipped work

The 8-task Hinglish brief (Add / Edit / Delete / Clone / Maker-Checker / 15 APIs / 3 DB tables / UI) maps to RP-1 + RP-2 like this:

| Brief task | Shipped in | Status |
|---|---|---|
| **Task 1** — Add New Rule (4-step modal) | RP-2 wizard | ✓ |
| **Task 2** — Edit Existing Rule (SemVer + status-based restriction) | RP-1 versions module + classifier | ✓ |
| **Task 3** — Delete / Deprecate (soft via state→deprecated; clone-as-new for DEPRECATED) | base engine `DELETE` + RP-1 `/clone` | ✓ (hard delete for DRAFT — skipped per Q4 default) |
| **Task 4** — Clone (incl. from DEPRECATED → new DRAFT v0.1.0) | RP-1 `/clone` | ✓ |
| **Task 5** — Maker-Checker (4-eyes; self-approval refused) | RP-1 `/submit` + `/approve` + `/reject` + DB CHECK | ✓ |
| **Task 6** — 15 backend APIs | base engine 9 routes + RP-1 7 new routes (clone, submit, approve, reject, versions list, version detail, diff, approvals) | ✓ (16 routes — exceeds target) |
| **Task 7** — 3 DB tables | `app.ews_rules` (existing) + `app.ews_rule_versions` (RP-1) + `app.ews_rule_approvals` (RP-1) | ✓ |
| **Task 8** — UI/UX (auto-save, shortcuts, diff viewer, Test Rule) | RP-2 wizard + diff viewer + clone modal | ✓ |

---

## Defaults locked in (per RP-1 RFC §6)

These were chosen during RP-1 sign-off; raise a redirect issue if the prototype needs to revisit any:

- **Q1** `/approve` is a NEW route; legacy `/activate` is untouched for back-compat.
- **Q2** "Substantive" = conditions/action/category change → MINOR; metadata-only → PATCH; cumulative → MAJOR (manual operator action).
- **Q3** Clone copies all fields except `rule_id`; the caller supplies the new id; new rule lands at `0.1.0` in DRAFT.
- **Q4** Hard delete for DRAFT is skipped — soft delete via base engine is sufficient for the prototype.
- **Q5** Diff format is **structured** (field-by-field with kind: changed/added/removed) — no unified-diff dependency.
- **Q6** Test Rule re-uses existing `/v1/ews/rules/:id/test`. Wizard step 2 also has a *pure-client* simulator for pre-save preview.
- **Q7** Versions cap = 50 per rule; FIFO eviction. Production can lift via config.
