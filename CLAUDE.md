# ZorEWS — Project Context for Claude

Early-Warning System prototype. **Prototype, not a deployable bank product.**

## Auto-loaded canonical docs

@AGENTS.md
@STATUS.md
@TASKS.md
@todo.md

> The four files above are imported inline every session. If you need a deeper read (`REQUIREMENTS.md`, `BOOTSTRAP.md`, `SKILLS.md`, `README.md`, `docs/database-schema.md`, `docs/database-gap-analysis.md`), open them on demand — don't import them here, they're large.

## Operating rules in this repo

- **Autonomous mode is on.** Pick the next ⏳ item from `todo.md` / `TASKS.md`, ship it (design → BFF → SPA → smoke → commit), update both docs, push to `main`. Don't ask "what's next?" between features. (See memory `feedback_autonomous_mode.md`.)
- **Still pause for destructive actions**: force-push, schema-destructive migrations, deleting branches, anything that rewrites shared history.
- **Doc-update protocol** (per `AGENTS.md`):
  1. Tick the task checkbox in `TASKS.md`.
  2. One-liner under today's heading in `STATUS.md` — `[<agent>] <what shipped>`.
  3. Full detail in `logs/<agent>.md` — files touched, decisions, hand-offs.
  4. Hand-off — name the next agent + task id in the log.
- **Owned paths matter.** Each agent edits only inside its owned paths (see `AGENTS.md`). The orchestrator alone edits `TASKS.md` + `STATUS.md` — but in autonomous mode I'm acting as orchestrator + module agent.
- **Commit shape:** one feature per commit, conventional-commit style (`feat:` / `fix:` / `test:` / `ui:` / `docs:`). Match recent `git log` voice.

## Build / verify commands

- `make install` — install all workspaces + build `@apex-ews/rbac`.
- `make test` — run TS jest + Python pytest + web vitest.
- `make up` / `make down` — start/stop all backend services (PIDs in `.pids/`, logs in `.logs/`).
- `make smoke` — curl `/healthz` on each running service.
- `make ci` — install + test + build + lint (the "did I break anything" gate).

## CodeGraph is initialized

`.codegraph/` exists (653 files, 9,552 nodes, 22,609 edges). Prefer:
- `codegraph_search` over `grep` for symbols
- `codegraph_callers` / `codegraph_callees` to trace flow
- `codegraph_impact` before changing a shared symbol

Auto-resync runs on every Edit/Write (PostToolUse) and on session Stop — no manual reindex needed.

## Source of truth

| Question | File |
|---|---|
| What's shipped, current phase, KPIs | `STATUS.md` |
| Canonical backlog (checkbox tasks per agent) | `TASKS.md` |
| Feature-gap audit against `EWS.docx` | `todo.md` |
| Agent roster + owned paths + DoD | `AGENTS.md` |
| Phase acceptance criteria | `REQUIREMENTS.md §5` |
| Repo bootstrap + model-quality notes | `BOOTSTRAP.md` |
| Schema reference / open service-wiring backlog | `docs/database-schema.md`, `docs/database-gap-analysis.md` |
