# RBAC matrix + quarterly access review

Implements **T3.9**. The matrix in `matrix.json` is the source of truth for which role can perform which operation in APEX EWS.

## Roles

| Role                 | Description |
|----------------------|-------------|
| `admin`              | Platform admin. Owns user lifecycle, audit log access, overrides everywhere. Tightly held. |
| `risk_analyst`       | Front-line analyst. Triages alerts, opens + works cases, authors + simulates rules. |
| `supervisor`         | Risk manager. Oversight + assignment authority. Approves closes + rule retirements. |
| `collection_officer` | Collection-team operator. Works cases routed via T3.4; logs actions; closes on outcome. |
| `field_officer`      | On-the-ground field rep. Mobile-first; logs call/visit + optional GPS; read-only elsewhere. |

## Permission matrix

Generated from `matrix.json`. ✓ = allowed; blank = denied.

| Operation                       | admin | risk_analyst | supervisor | collection_officer | field_officer |
|---------------------------------|:-:|:-:|:-:|:-:|:-:|
| `alerts:list`                   | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alerts:read`                   | ✓ | ✓ | ✓ | ✓ | ✓ |
| `alerts:assign`                 | ✓ | ✓ | ✓ |   |   |
| `alerts:ack`                    | ✓ | ✓ | ✓ |   |   |
| `alerts:close`                  | ✓ | ✓ | ✓ |   |   |
| `cases:create`                  | ✓ | ✓ | ✓ |   |   |
| `cases:list`                    | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cases:read`                    | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cases:assign`                  | ✓ |   | ✓ |   |   |
| `cases:log_action`              | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cases:monitor`                 | ✓ | ✓ | ✓ | ✓ |   |
| `cases:close`                   | ✓ |   | ✓ | ✓ |   |
| `rules:list`                    | ✓ | ✓ | ✓ | ✓ | ✓ |
| `rules:read`                    | ✓ | ✓ | ✓ | ✓ | ✓ |
| `rules:create`                  | ✓ | ✓ |   |   |   |
| `rules:update`                  | ✓ | ✓ |   |   |   |
| `rules:simulate`                | ✓ | ✓ | ✓ |   |   |
| `rules:retire`                  | ✓ |   | ✓ |   |   |
| `customers:list`                | ✓ | ✓ | ✓ | ✓ | ✓ |
| `customers:read_risk_profile`   | ✓ | ✓ | ✓ | ✓ | ✓ |
| `collection:callback`           | ✓ |   | ✓ | ✓ |   |
| `users:list`                    | ✓ |   | ✓ |   |   |
| `users:create`                  | ✓ |   |   |   |   |
| `users:role_change`             | ✓ |   |   |   |   |
| `users:deactivate`              | ✓ |   |   |   |   |
| `audit:read`                    | ✓ |   | ✓ |   |   |

## Quarterly access review process

Per FR-INT and FR-AUDIT, the access roster is reviewed every 90 days. The intent is to catch role drift, dormant accounts, and over-privileged users before they're exploited.

### Cadence

* **Q1 / Q2 / Q3 / Q4** — first business day of January, April, July, October. The review must close within 5 business days.
* **Trigger:** the Risk-IT lead schedules a `quarterly-access-review` Linear ticket on the first day of the quarter. The orchestrator agent files a comment with the latest review report (see *Running the review*).

### Owners

| Step | Owner |
|------|-------|
| Schedule the review | Risk-IT lead |
| Run `access_review.py` and post the report | Orchestrator agent (or anyone with read access to `app.users`) |
| Validate the report against HR's active-employee roster | HR rep |
| Confirm no role drift in the matrix | Risk-Ops manager |
| Sign-off + close the ticket | CISO or delegate |

### Running the review

```sh
source .venv/bin/activate
python infra/rbac/scripts/access_review.py \
    --matrix infra/rbac/matrix.json \
    --roster infra/rbac/scripts/sample_roster.json \
    --report-out review-$(date +%Y-Q%q).md
```

The script:

1. Validates the matrix is well-formed (all listed roles appear in `roles[]`; every permission set references known roles).
2. Validates the roster — every user references a role that exists in the matrix.
3. Emits a Markdown report listing each user with their role, the operation count granted by that role, and a flag for any user whose `last_login` is older than 90 days (dormant).
4. Exits 1 on any inconsistency, so CI can gate the matrix file on every PR.

In production, the roster is read from `app.users` in Aurora rather than a flat file; the prototype ships `sample_roster.json` so the script is exercisable end-to-end.

### Audit trail

* The review report is appended to the audit-svc hash-chain (`apex.audit.events`) with `event_type: "access.review.completed"`.
* Sign-off comments live on the Linear ticket.
* Discovered changes (revoke / role-change) become standard `users:role_change` or `users:deactivate` operations and themselves emit audit events.

## Library access

* **Python:** `infra/rbac/scripts/access_review.py` exposes `load_matrix(path)` and `validate_roster(matrix, roster)`.
* **TypeScript:** `infra/rbac/lib/rbac.ts` exposes `loadMatrix()` + `can(role, operation)` for service-side guards (auth-svc / regulatory-svc / bff / collection-adapter).

## Updating the matrix

Treat `matrix.json` as a contract. PRs that change it must:

1. Update this README's permission table (the script can regenerate it — see the `--render-table` flag).
2. Pass the matrix self-validation in CI (`access_review.py --matrix matrix.json --validate-only`).
3. Get sign-off from a Risk-Ops reviewer (CODEOWNERS catches this).
