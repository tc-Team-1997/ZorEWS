# Demo Dry-Run Report — 2026-05-24

End-to-end verification of every Act in `ZorEWS_Demo_Script.md` against the running local stack.

---

## ✅ Pass Summary

| Layer | Result |
|---|---|
| **Newman full** | **890 requests / 2569 / 2569 assertions ✅ 0 failed** |
| **SPA build** | `vite build` clean (3.9s, 1.98 MB / 548 KB gzip) |
| **SPA vitest** | 510/510 pass |
| **BFF tsc** | clean |
| **3 servers live** | BFF :8084 ✅ / auth :8080 ✅ / SPA :5173 ✅ |
| **All 11 SPA routes** | 200 OK (incl. 3 new banking pages) |

---

## Act-by-Act Endpoint Verification

| Act | Path | Endpoint | Status | Notes |
|---|---|---|---|---|
| 1 | `/login` | POST /auth/login | ✅ 200 | All 6 users (alice/ravi/sue/carl/fiona/bil) login OK |
| 2 | `/` | GET /api/dashboard/summary | ✅ 200 | KPIs render |
| 2 | `/` | GET /api/customers | ✅ 200 | Top: Olivia Cherop c-115 PD 0.83 |
| 2 | `/` | GET /v1/banking/sectors/heatmap | ✅ 200 | 5 critical sectors (Power 10.49% NPA) |
| 3 | `/customers/c-115` | GET /api/customers/c-115/risk | ✅ 200 | Real customer in registry |
| 3 | `/customers/:id` | GET /v1/customers/:id/360 | ✅ 200 | Always 200 (BIL synth aggregator) |
| 4 | `/banking/npa-prediction` | GET /v1/banking/npa/high-risk | ✅ 200 | 63 high-risk, top: Arjun Reddy c-100014 PD 0.986 / Power |
| 4 | NPA Why modal | GET /v1/banking/npa/predictions/.../why | ✅ 200 | 5 features + recommended actions |
| 4 | Backtest modal | GET /v1/banking/npa/backtest/latest | ✅ 200 (admin role) | AUC 0.875, cohort 4958 |
| 5 | `/alerts` | GET /v1/alerts | ✅ 200 | 17 alerts total |
| 5 | `/cms/cases` | GET /api/cases | ✅ 200 | 50 cases total |
| 6 | `/admin/audit-log` | GET /v1/audit/events | ✅ 200 (admin role) | Event table |
| 6 | `/reports` | GET /v1/reports/catalog | ✅ 200 | 9 reports |
| 7 | `/banking/sma` | GET /v1/banking/sma/movements | ✅ 200 | 59 movements, 329M KES exposure |
| 7 | `/banking/sectors` | GET /v1/banking/sectors/heatmap | ✅ 200 | 12 sectors |

---

## 🚨 Issues Found and Fixed During Dry-Run

### Issue 1 — Wrong password documented for ravi.risk
- **Symptom:** ravi.risk login returned 401 with `Risk!Pass1`
- **Root cause:** `users.ts` has `RiskAnalyst!1` not `Risk!Pass1`
- **Fix:** Updated DEMO_PREP.md with correct passwords for all 6 users
- **Real passwords confirmed:**
  - `alice.admin` / `Admin!Pass1`
  - `ravi.risk` / `RiskAnalyst!1`
  - `sue.super` / `Super!Pass1`
  - `carl.collect` / `Collect!Pass1`
  - `fiona.field` / `Field!Pass1`
  - `bil.admin` / `BilAdmin!1`

### Issue 2 — `c-100014` (Arjun Reddy) is not in `/api/customers`
- **Symptom:** Navigating to `/customers/c-100014` returns 404 on `/api/customers/c-100014/risk`
- **Root cause:** Arjun Reddy is in the NPA prediction synthetic pool only; the customer registry has IDs `c-101..c-120` with different names
- **Fix:** Demo script Act 3 now navigates to **`/customers/c-115` (Olivia Cherop)** — the actual top of Borrower Watch list. Narrative bridge added: *"Ab Power sector ki taraf chalti hu — wahan ek borrower hai jo AI ne NPA-imminent flag kiya hai"* → transitions to NPA Prediction page where Arjun Reddy is anchored.

### Issue 3 — `audit:read` scope not held by `risk_analyst` role
- **Symptom:** `/v1/audit/events` and `/v1/banking/npa/backtest/latest` returned 403 when role=`risk_analyst`
- **Root cause:** Backtest + Audit endpoints require `audit:read` scope; only admin + supervisor roles carry it per RBAC matrix
- **Fix:** Demo script now uses `alice.admin` (admin role) as the persona login. Narration as "Credit Risk Officer" still works — the role behind the persona is admin. Alternative: stay on ravi.risk and skip Backtest modal + Audit Trail Act 6 (script's "Watch out for" callouts now document this).

### Issue 4 — `/v1/reports/catalog` returned 0 entries via wrong key
- **Symptom:** Initial parsing tried `body.reports` but real shape is `body.items`
- **Root cause:** Response uses paginated `{items, total}` envelope shape
- **Fix:** Real catalog confirmed — 9 reports including `portfolio_snapshot_daily` and `rbi_quarterly_summary` (both already in v2 script). No script change needed; demo presenter just clicks any report name from the rendered list.

### Issue 5 — Tab navigation on Borrower 360 doesn't exist
- **Symptom:** Script v1 claimed Ratios / Account Signals / SMA Status / Alerts History as separate tabs
- **Root cause:** CustomerRiskProfilePage shows panels, not tabs
- **Fix:** v2 script Act 3 rewritten to use panels narration. "Watch out for" callout added in case asked about tabs.

---

## 🎬 Recommended Demo Login

**Single user, all Acts work:** `alice.admin / Admin!Pass1`

Persona narration ("Credit Risk Officer") is the story you tell the audience; alice.admin is the technical login that lets every Act through. The role doesn't show up on screen anywhere obvious.

If you absolutely need to demo two-user maker-checker in Act 5:
- Tab 1: alice.admin (maker) issues escalate request
- Tab 2: sue.super (checker) approves it

---

## 🎯 Final Pre-Demo Checklist

- [x] Newman smoke: 32/32 ✅
- [x] Newman full: 2569/2569 ✅
- [x] SPA vitest: 510/510 ✅
- [x] SPA build clean ✅
- [x] All 11 demo routes return 200 ✅
- [x] Real data verified (Olivia c-115, Arjun c-100014 in NPA, AUC 0.875, 9 reports, 59 SMA movements, 5 critical sectors) ✅
- [x] Password discrepancy fixed in DEMO_PREP ✅
- [x] Act 3 navigation fixed to real customer c-115 ✅
- [x] Role-gating issues documented + working login path identified (alice.admin) ✅
- [ ] **Backup screenshots taken** (human task — Sunday/Monday)
- [ ] **15-min dry-run live with timer** (human task — Sunday/Monday)
- [ ] **Print/open DEMO_PREP.md on phone** (human task — Tuesday morning)

---

## Servers as of run time

```
:8080  auth-svc        ✅ status: ok
:8084  bff             ✅ ok: true
:5173  web (vite dev)  ✅ HTTP 200
```

Logs at `/tmp/auth.log`, `/tmp/bff.log`, `/tmp/web.log`.

---

*Dry-run executed 2026-05-24 against the live local stack. Re-run before demo if seed data is regenerated or auth-svc is restarted with stale state.*
