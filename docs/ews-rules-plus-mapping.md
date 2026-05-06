# EWS Rules Engine — "Plus" extensions (8-task brief)

**Status:** RFC — informs RP-1. Sign-off needed on §4 before RP-2 (SPA wizard) lands.
**Date:** 2026-05-06.
**Brief:** 8 tasks — Add Rule (4-step modal), Edit (versioning), Delete/Deprecate, Clone, Maker-Checker (4-eyes), 15 backend APIs, 3 DB tables, UI/UX (auto-save, keyboard shortcuts, diff viewer, test rule).

---

## 1. What ZorEWS already has — existing EWS Rules Engine (EWS-1..5)

The 5-commit `EWS-1..5` series shipped the rules engine end-to-end. Covering the brief's tasks against existing surface:

| Brief task | Already shipped (EWS-x) | Gap |
|---|---|---|
| Task 1 — Add Rule (basic) | `POST /v1/ews/rules` + SPA `EwsRuleBuilderPage` | **4-step modal flow + auto-save not yet** |
| Task 2 — Edit Existing Rule | `PUT /v1/ews/rules/:id` (bumps integer `version`) | **SemVer (1.4.0 → 1.5.0) + status-based edit restrictions + clone-as-new for deprecated** |
| Task 3 — Delete / Deprecate | `DELETE /v1/ews/rules/:id` (soft, state→deprecated) | **Hard delete for DRAFT (admin-only triple-confirm) + reason field** |
| Task 4 — Clone | not present | **New `/clone` endpoint** |
| Task 5 — Maker-Checker (4-eyes) | `POST /v1/ews/rules/:id/activate` exists but **does NOT enforce self-approval refusal** | **New `/approve` + `/reject` route pair with maker ≠ approver check** |
| Task 6 — Backend APIs (15) | EWS-3 ships **9** routes already | **Add 6: clone, approve, reject, versions list, versions detail, versions diff** |
| Task 7 — DB (3 tables) | `app.ews_rules` + `app.ews_rule_executions` exist | **Add `ews_rule_versions` (snapshot history) + `ews_rule_approvals`** |
| Task 8 — UI/UX | `EwsRuleBuilderPage` is a single-page form | **Refactor to 4-step modal + auto-save 30s + keyboard shortcuts + Diff Viewer + Test Rule button (test endpoint exists, just needs SPA wiring)** |

**Net new code:** 1 backend module (`ews_rules_versions.ts`), 6 new routes, 2 new DB tables, 1 SPA wizard (replaces or extends the existing builder), Diff Viewer component, Postman + README. ~80 new tests on top of the existing 124 EWS-rules tests.

**Standing additive-only rule:** existing `ews_rules.ts` state machine, store, and routes stay frozen. New layer wraps them.

---

## 2. SemVer versioning

### 2.1 Format

`MAJOR.MINOR.PATCH` (e.g. `0.1.0`, `1.4.0`, `1.5.0`). Follows SemVer conventions:

| Change kind | Triggered by | Bump |
|---|---|---|
| New rule from scratch | `POST /v1/ews/rules` (create) | starts at `0.1.0` |
| Edit conditions / action | `PUT /:id` while DRAFT or PENDING_REVIEW | **MINOR** bump (1.4.0 → 1.5.0) |
| Edit metadata only (name, tags, description) | `PUT /:id` non-substantive | **PATCH** bump (1.4.0 → 1.4.1) |
| Submit for review | `POST /:id/submit` | no bump |
| Approve → ACTIVE | `POST /:id/approve` (NEW) | no bump |
| Cumulative breaking change | first promotion to `1.0.0` (manual operator action) | **MAJOR** bump |
| Clone | `POST /:id/clone` (NEW) | new rule_id, version reset to `0.1.0` |
| Reopen / reactivate | not in scope | n/a |

Pure helper `bumpSemver(prev, kind: 'major' | 'minor' | 'patch'): string`.

### 2.2 Version snapshot table

Every state-change writes a snapshot row in `app.ews_rule_versions`. Snapshot captures the FULL rule body (conditions/action/state/etc.) at that moment, plus the actor + reason.

This is in addition to (not replacing) the M9.4-style audit-trail event already shipped in EWS-3 — the existing audit captures the action verb; the new snapshot captures the FULL state for diffing.

Cap 50 versions per rule; oldest evicted with FIFO.

---

## 3. Maker-checker (4-eyes)

### 3.1 The rule

The user who **created** or **last submitted** the rule cannot **approve** it. Returns `EWS_403_self_approval_refused` if violated.

This mirrors the existing M9.3 case-maker-checker pattern in `case_maker_checker.ts`.

### 3.2 New endpoints

| Method + path | Role | Purpose |
|---|---|---|
| `POST /v1/ews/rules/:id/approve` | rules:retire | maker-checker promote PENDING_REVIEW → ACTIVE; refuses if actor was the maker |
| `POST /v1/ews/rules/:id/reject` | rules:retire | maker-checker reject PENDING_REVIEW → DRAFT with a reason |

Approval audit lives in `app.ews_rule_approvals` (NEW) — every approval/rejection writes a row with maker_username + approver_username + decision + reason + timestamp.

The legacy `POST /v1/ews/rules/:id/activate` stays UNTOUCHED for back-compat. The new `/approve` is the recommended path going forward.

---

## 4. Proposed architecture (RP-1 scope)

### 4.1 Module + namespace

- New module: `services/bff/src/ews_rules_versions.ts`
- Routes: `/v1/ews/rules/:id/{clone, approve, reject, versions, versions/diff}`
- DB schema: `data/schema/015_ews_rules_versions.sql` (new tables `ews_rule_versions` + `ews_rule_approvals`)
- SPA module (RP-2): `web/src/modules/rules/EwsRuleWizard.tsx` (4-step modal) + `EwsRuleDiffViewer.tsx` + auto-save hook

### 4.2 New routes (RP-1)

```
POST   /v1/ews/rules/:rule_id/clone
       body { name?, rule_id? } → 201 with new rule (DRAFT, v0.1.0)

POST   /v1/ews/rules/:rule_id/approve
       body { reason? } → 200 with rule (ACTIVE)
       Refuses if X-APEX-USER === maker (self_approval_refused)

POST   /v1/ews/rules/:rule_id/reject
       body { reason } → 200 with rule (back to DRAFT)
       reason required.

GET    /v1/ews/rules/:rule_id/versions
       List all snapshot rows, newest-first

GET    /v1/ews/rules/:rule_id/versions/:version
       Single snapshot

POST   /v1/ews/rules/:rule_id/versions/diff
       body { from: 'v1.4.0', to: 'v1.5.0' } → field-by-field diff
```

### 4.3 New DB tables — `data/schema/015_ews_rules_versions.sql`

```sql
CREATE TABLE app.ews_rule_versions (
    version_id      UUID         PRIMARY KEY,
    rule_id         TEXT         NOT NULL,
    tenant_id       TEXT         NOT NULL,
    semver          TEXT         NOT NULL,        -- '0.1.0', '1.4.0', etc.
    snapshot        JSONB        NOT NULL,        -- full rule body at this version
    created_by      TEXT         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    reason          TEXT,                          -- free-form note
    UNIQUE (tenant_id, rule_id, semver),
    CHECK (semver ~ '^[0-9]+\.[0-9]+\.[0-9]+$')
);

CREATE TABLE app.ews_rule_approvals (
    approval_id        UUID         PRIMARY KEY,
    rule_id            TEXT         NOT NULL,
    tenant_id          TEXT         NOT NULL,
    maker_username     TEXT         NOT NULL,
    approver_username  TEXT,                       -- NULL until decided
    decision           TEXT         NOT NULL,
        -- pending / approved / rejected / withdrawn
    reason             TEXT,
    submitted_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    decided_at         TIMESTAMPTZ,
    CHECK (decision IN ('pending','approved','rejected','withdrawn'))
);
```

### 4.4 Closed-rule lock semantics

`DEPRECATED` rules cannot be edited or approved — only **cloned** to a new DRAFT (per the brief: "Deprecated rules → Clone as new option"). The clone helper handles this: pulls the deprecated rule's body, creates a new rule_id under v0.1.0 in DRAFT.

### 4.5 RBAC — capability map

| Operation | Capability | Maker | Checker | Admin |
|---|---|---|---|---|
| Create rule | `rules:create` | ✓ | – | ✓ |
| Edit rule (DRAFT) | `rules:create` | ✓ | – | ✓ |
| Submit for review | `rules:create` | ✓ | – | ✓ |
| Approve | `rules:retire` | **refused** | ✓ | ✓ (when not maker) |
| Reject | `rules:retire` | **refused** | ✓ | ✓ (when not maker) |
| Deprecate | `rules:retire` | ✓ | ✓ | ✓ |
| Clone | `rules:create` | ✓ | ✓ | ✓ |
| View versions / diff | `rules:read` | ✓ | ✓ | ✓ |

---

## 5. Implementation sub-phases

| Commit | Scope | Tests |
|---|---|---|
| **RP-1** (this commit) | Versions store + clone + approve/reject + diff + DB migration. ZERO modifications to existing EWS routes. | ~50 |
| **RP-2** | SPA — 4-step modal wizard + auto-save 30s + keyboard shortcuts (Cmd+S, Esc) + diff viewer + clone-from-3-dot-menu + Test Rule button | ~25 |
| **RP-3** | README + Postman + sample audit walkthrough + 8-task checklist mapping | ~5 |

Total ≈ 80 new tests. Combined with existing EWS-1..5 → 200+ total rules-engine coverage.

---

## 6. Open questions for sign-off (defaulting if no reply)

| # | Question | Default |
|---|---|---|
| Q1 | Modify existing `/activate` to add maker-checker, or add new `/approve`? | **New `/approve` route** (additive; legacy stays for back-compat) |
| Q2 | SemVer auto-increment: substantive vs metadata change boundary? | "Substantive" = conditions/action change → MINOR; metadata-only (name/desc/tags) → PATCH; cumulative → MAJOR (manual operator action) |
| Q3 | DEPRECATED rule → clone-as-new: same `category`/`description`? | Yes — clone copies all fields except `rule_id` (caller supplies new id) and resets state to DRAFT v0.1.0 |
| Q4 | Hard-delete for DRAFT (admin-only triple-confirm)? | **Skip in RP-1** — soft delete via `DELETE` already handles it; hard delete is brief task #3 sub-bullet but operationally rare. SPA in RP-2 can wire a "danger" hard-delete that calls a new `DELETE :id?force=true` if needed. |
| Q5 | Diff viewer format: text-diff vs structured field-by-field? | **Structured** — list each changed field with old/new values (operator-friendly; don't need a unified diff library) |
| Q6 | Test Rule button — call existing `POST /:id/test` with sample values inline? | **Yes** — already shipped in EWS-3; SPA in RP-2 wires the inline test panel (already partly there in `EwsRuleBuilderPage`) |
| Q7 | Versions cap (FIFO eviction)? | 50 versions per rule. Production can lift via config. |

If any default needs to change, redirect before RP-2.
