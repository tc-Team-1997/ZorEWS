# Unified Rule Center — architecture

**Status:** shipped 2026-05-30
**Owner:** agent-rule + agent-ui

## Problem

The SPA exposed 4 separate sidebar entries for rule-related work, each pointing
at an existing page in `web/src/modules/rules/`:

| Sidebar entry  | i18nKey        | URL              | Page                       |
| -------------- | -------------- | ---------------- | -------------------------- |
| Rules Engine   | `rules_engine` | `/rules/engine`  | `RulesEnginePage`          |
| Rules          | `rules`        | `/rules`         | `RuleConfigPage`           |
| EWS Rules      | `ews_rules`    | `/rules/ews`     | `EwsRuleBuilderPage`       |
| Rule Reports   | `rule_reports` | `/rules/reports` | `RuleReportsPage`          |

Operators kept clicking the wrong one. The pages were also semantically
overlapping (Rules Engine had templates + simulator + indicators, EWS Rules
had the SemVer ledger + maker-checker, etc.) — yet none of them was billed as
the "place you go to do rule work".

## Solution

One sidebar entry: **Rule Center** at `/rule-center` with 6 named sub-sections.
Every sub-section is a thin wrapper around an existing page — **zero
duplication, zero rewrite, zero broken bookmark**. The legacy URLs all keep
resolving so any external link or test that points at `/rules/engine`,
`/rules/ews`, `/rules/reports`, or `/rules` continues to render the same
component it did before.

### New sidebar hierarchy

```
Rule Center                  /rule-center                  → RuleCenterPage (NEW landing)
├── Rule Builder             /rule-center/builder          → EwsRuleWizardPage
├── Rule Library             /rule-center/library          → RulesEnginePage
├── Rule Testing             /rule-center/testing          → RulesEnginePage (?tab=simulator)
├── Rule Reports             /rule-center/reports          → RuleReportsPage
├── Version History          /rule-center/history          → EwsRuleBuilderPage
└── Rule Comparison          /rule-center/comparison       → EwsRuleBuilderPage
                             /rule-center/comparison/:id   → EwsRuleDiffPage
```

### Page mapping (zero new components)

| Rule Center sub-section | Renders                  | Why it fits                                                                 |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------- |
| Builder                 | `EwsRuleWizardPage`      | 4-step wizard (basics → conditions → action → lifecycle) + built-in preview |
| Library                 | `RulesEnginePage`        | 5-tab UI: Templates / Custom / Indicators / Simulator / Scenarios           |
| Testing                 | `RulesEnginePage`        | Same page — the Simulator tab is the testing surface                        |
| Reports                 | `RuleReportsPage`        | Phase 9 T10 fleet aggregator (most-fired, FP rate, latency p95)             |
| Version History         | `EwsRuleBuilderPage`     | Per-rule SemVer ledger + maker–checker approvals                            |
| Comparison              | `EwsRuleBuilderPage`     | Lists rules → click → opens `EwsRuleDiffPage` at `?from=&to=`               |

## Migration strategy

**Backward-compatible, additive only.** Every legacy URL still works.

1. `web/src/App.tsx` — added the new `/rule-center` route + 8 wrapper routes.
   Existing `/rules`, `/rules/engine`, `/rules/ews`, `/rules/ews/wizard`,
   `/rules/ews/:rule_id/diff`, `/rules/reports` routes are **untouched**.
2. `web/src/components/layout/navConfig.ts` — the 4 legacy nav entries were
   removed from the sidebar tree, but the URLs they pointed at still resolve
   (App.tsx untouched). The new 6 Rule Center entries are added in the same
   group.
3. `web/src/lib/i18n.ts` — 7 new keys (`rule_center` + 6 sub-section labels)
   added across all 4 locales (en, hi, dz, ne). The old `rules_engine`,
   `rules`, `ews_rules`, `rule_reports` keys are kept so any in-flight string
   reference doesn't 404.
4. Tests, deep links, bookmarks — all keep working.

## UI architecture

- `RuleCenterPage` is the single new component (~210 LOC). It renders a
  6-card grid driven by an exported `RULE_CENTER_CARDS` array. The array is
  the source of truth — adding a 7th sub-section is a one-element push +
  one wrapper route in `App.tsx`.
- The same role gate as the existing `/rules/engine` page applies:
  `admin | supervisor | risk_analyst`. Non-matching roles redirect to `/`.
- A backwards-compatibility panel inside the page surfaces every legacy URL
  so power users (and the docs) can still link directly.
- No store, no react-query, no MSW handler. The page is pure presentation
  over a static catalog.

## Test surface

- `web/src/__tests__/RuleCenterPage.test.tsx` — 7 cases covering role gate
  (admin pass / risk_analyst pass / field_officer bounce), landing-card
  grid (all 6 testids), backwards-compat panel testid, exported
  `RULE_CENTER_CARDS` shape invariants.
- Existing rule-module tests (`EwsRuleBuilderPage.test.tsx`,
  `EwsRuleDiffPage.test.tsx`, `RulesEnginePage.test.tsx`,
  `RuleConfigPage.test.tsx`, `RuleReportsPage.test.tsx`,
  `EwsRuleWizardPage.test.tsx`) are unchanged and continue to drive the
  underlying pages — the Rule Center wrapper routes inherit that coverage.

## What we explicitly did NOT do

- Rename or move any existing rule module file.
- Change any existing rule API contract.
- Remove or repurpose any existing legacy URL.
- Add a new BFF route. The Rule Center is purely an SPA navigation feature.

## Follow-ups (future, not blocking)

- Once SPA telemetry confirms 0% traffic on the old sidebar entries for 60
  days, the legacy nav-entry-removal can be backed by analytics rather than
  an assumption.
- If the EWS Rule Builder page ever splits the "list + lifecycle" surface
  from the "version history" surface, the Rule Center cards for History +
  Comparison can split into separate page components — the card metadata is
  already keyed to the right URL.
