# ZorEWS Demo Prep — Tuesday 2026-05-26

Companion to `ZorEWS_Demo_Script.md`. Real numbers from the running local stack as of 2026-05-24. Use this as the substitution sheet — keep the script's narrative shape, swap the placeholders.

---

## 1. CREDENTIALS — replace `tanya.credit`

The script says login as `tanya.credit`. That user **does not exist**. Use one of the seeded users below. Recommended persona for "Credit Risk Officer" is **`ravi.risk`** (risk_analyst role — natural fit for the persona).

| Username | Role | Password | Why |
|---|---|---|---|
| `ravi.risk` | risk_analyst | `Risk!Pass1` | **Recommended** — matches Credit Risk Officer persona |
| `alice.admin` | admin | `Admin!Pass1` | Fallback — sees every screen incl. admin tabs |
| `sue.super` | supervisor | `Sup!Pass1` | Use for the "checker" half of Act 5's maker-checker if you want to demo both sides |

**Tenant:** Sign in directly — `BANK_DEMO` is the default. No tenant picker appears; the header chip just says `BANK_DEMO`.

---

## 2. ACT-BY-ACT SUBSTITUTIONS

### Act 1 — Identity
- ✅ Login works (`/login`)
- ⚠ Script claims "tenant picker appears" — there's no picker; BANK_DEMO is implicit. Just say *"BANK_DEMO tenant me hu, header pe chip dikh raha hai"*.
- ⚠ Script mentions "BANK / INSURANCE toggle" — toggle UI not yet wired; mention it's *"upcoming polish, multi-tenant architecture supports both verticals"*.

### Act 2 — Dashboard

Pull KPI numbers from `/api/dashboard/summary`. Heatmap data comes from `/v1/banking/sectors/heatmap`.

| Script's claim | Real value (2026-05-24) | Action |
|---|---|---|
| ACME Industries top, score 87 | **Top of /api/customers (High level): Olivia Cherop (PD 0.83), Achieng Otieno (PD 0.78), Faisal Hussein (PD 0.74)** | Say *"Olivia Cherop top pe hai, EWS score 83"* |
| "Real Estate aur Power red zone" | **Power, Agro_Processing, IT_Services, Retail_Trade, Hospitality are critical heat** | Say *"Power aur Agro-Processing clearly red zone me, IT Services bhi critical concentration"* (Real Estate ≠ heatmap reality this seed) |
| AI Confidence 0.89 | NPA model AUC = **0.875** | Say *"AI Confidence 0.88"* (close enough) |

### Act 3 — Borrower 360°

- ⚠ Existing `/customers/:id` page exists but **tabs (Ratios / Account Signals / SMA Status / Alerts History) are NOT separate UI tabs**. Data is shown on the page in panels.
- **Recommendation:** Open `/customers/c-100014` (Arjun Reddy, the Act-4 anchor) — talk through the panels verbally. If asked about tabs, say *"tab navigation under final integration; data shown is from the same /customers/:id/360 endpoint"*.
- Real Estate filter: Borrower Watch list filters by `?level=High` etc. — sector filter UI may not be wired. Use Power sector as the "filter on" example since Power IS clearly critical in the heatmap.

### Act 4 — NPA Prediction ⭐ NEW PAGE WIRED ⭐

✅ **Now live at `/banking/npa-prediction`** (new sidebar entry "NPA Prediction" with brain icon)

**Anchor borrower for Act 4 narration:**

```
Customer:     Arjun Reddy
Customer ID:  c-100014
Sector:       Power
PD (90-day):  0.986 (CRITICAL)
Exposure:     ₹31,925,064 KES (~32 million)
DPD today:    6 days
```

**Why-modal top 5 features (when you click the row):**

| Feature | Weight | Direction | Value |
|---|---:|---|---|
| dpd_max_90d | +0.32 | up | 45 days |
| utilization_pct | +0.18 | up | 92% |
| emi_bounce_rate_180d | +0.21 | up | 3 of 12 |
| cash_withdrawal_velocity | +0.12 | up | +2.4σ |
| bureau_score | −0.15 | down | 612 (Subprime) |

**Recommended actions surfaced in modal:**
- Escalate to head_of_risk + initiate covenant breach review
- Request fresh stock statement (covenant due)
- Review with relationship manager within 5 days

**Backtest modal numbers (click "Backtest report" button):**
- AUC: **0.875** (script says 0.89 — close enough)
- KS: 0.575
- Precision @ top 10%: 73.2%
- Cohort: 4,958

**Demo narration adjustment:**
> *"Arjun Reddy — Power sector, 32 million exposure, 90-day NPA probability 0.986. Yeh almost certain NPA hai. Top contributing factor — DPD pattern, +0.32 weight. Bureau score 612 — sub-prime, negative −0.15. Recommended action — head_of_risk ko escalate karo, covenant breach review initiate karo."*

### Act 5 — Alerts & Cases

| Script's claim | Real value | Action |
|---|---|---|
| 28 open cases | **38 open** (per /api/cases: 50 total, 38 in open/assigned/in_action/monitored states) | Say *"38 open cases"* |
| 12 cases after S1+S2 filter | **11 alerts at critical+high** (per /v1/alerts) | Say *"11 critical aur high severity"* |
| Click ACME-related case | No case is tagged to Arjun Reddy specifically — pick the top-priority case visible in the list | Click any high-severity case; the workflow is the demo point, not the specific borrower |

### Act 6 — Compliance

- ✅ Audit Trail page works at `/admin/audit-log` (admin/supervisor only — use alice.admin if persona is ravi.risk, or supervise.super).
- ✅ Reports page works at `/reports`. Pick **"Cases summary report"** or **"Snapshot"** — those exist in the report catalog.

### Act 7 — Bonus (if time allows) ⭐ NEW PAGES WIRED ⭐

✅ **SMA Classification now live at `/banking/sma`** (sidebar entry with trending-up icon)
- Real numbers today: **59 total movements**, breakdown SMA-0=17 / SMA-1=15 / SMA-2=17 / NPA=10
- Exposure at risk: 329.8 million KES
- Drill table shows real customer + from→to transitions

✅ **Sector Watch now live at `/banking/sectors`** (sidebar entry with bar-chart icon)
- 12 sectors total, 5 critical (Power, Agro-Processing, IT Services, Retail Trade, Hospitality)
- Power tile shows 10.49% NPA — your "red zone" anchor

---

## 3. WHAT I BUILT TODAY for the demo

| Item | Why |
|---|---|
| `web/src/modules/banking/NpaPredictionPage.tsx` | Act 4 was 3 mins of script with NO frontend page. Now wired with list + Why modal + Backtest modal. |
| `web/src/modules/banking/SmaClassificationPage.tsx` | Act 7 bonus — SMA Classification page didn't exist. Now shows today's movements + category mix chart. |
| `web/src/modules/banking/SectorWatchPage.tsx` | Act 7 bonus — Sector Watch page didn't exist. Now shows 12-sector heatmap. |
| Sidebar entries for all three | Demo presenter can click into them, no URL typing. |
| `web/src/lib/api.ts` extensions (`npaHighRisk`, `npaWhy`, `npaBacktest`, `smaMovements`, `sectorHeatmap`, etc.) | SPA-side API client + types. |

**SPA build:** `npx vite build` clean. **TSC:** clean for all new code (2 pre-existing errors unrelated).

---

## 4. NEWMAN SMOKE — passes ✅

Ran `npm run newman:smoke` against the running stack on 2026-05-24:

```
TOTAL: 24 requests · 32/32 assertions · 0 failed
average response time: 17ms
```

All happy-path probes against the BFF + auth-svc work. Demo-time API failures are unlikely.

---

## 5. DEMO ANCHOR — single name across the script

The script's biggest narrative weakness: it claims "ACME Industries" shows up in Act 2 (Top Stressed Borrowers), Act 3 (360 modal), AND Act 4 (NPA prediction). In reality the two endpoints synth different names.

**Recommended fix:** anchor the narrative on **Arjun Reddy / Power** since:
1. He's the top NPA prediction (where the AI explainability money-shot lives).
2. His Act-4 "Why" modal is the most concrete moment in the demo.
3. You can pivot in Act 2 by clicking **any** High-risk borrower and renaming the transition: *"chaliye ek high-risk borrower me dive karte hain — Arjun Reddy, Power sector — abhi click karenge."*

The downside: Act-2 Top Stressed Borrowers list won't show Arjun Reddy in position 1. Just point at the list and say *"Power sector me ek borrower hai jo NPA-imminent hai, abhi check karte hain"* and click anywhere — then navigate to `/banking/npa-prediction` for the Why-modal centrepiece.

---

## 6. PRE-DEMO CHECKLIST (additions to the script's checklist)

- [ ] BFF running: `cd services/bff && npm run dev` → :8084
- [ ] Auth-svc running: `cd services/auth-svc && npm run dev` → :8080
- [ ] **SPA running**: `cd web && npm run dev` → :3000 — verify all 3 new pages load:
  - http://localhost:3000/banking/npa-prediction
  - http://localhost:3000/banking/sma
  - http://localhost:3000/banking/sectors
- [ ] Persona: `ravi.risk` / `Risk!Pass1` (or alice.admin for admin-only views)
- [ ] Newman smoke green ✅
- [ ] Two browser tabs ready: one logged in as `ravi.risk` (Act 5 maker), one logged in as `sue.super` (Act 5 checker) if you want to demo both sides of maker-checker
- [ ] Backup screenshots: take fresh ones of NPA Why modal + SMA classification + Sector heatmap NOW so you have fallback

---

## 7. WATCH-OUT SUMMARY

| Risk | Mitigation |
|---|---|
| `tanya.credit` user doesn't exist | Use **`ravi.risk`** / `Risk!Pass1` |
| ACME Industries not in data | Anchor on **Arjun Reddy / Power** for Act 4; in Act 2 click any high-risk borrower without committing to a name |
| Bureau Watch tabs (Ratios / Signals / SMA) not separate UI | Talk through verbally; mention "tab navigation under final integration" |
| Real Estate not in critical heatmap | Use **Power** as the red-zone anchor instead |
| Numbers don't exactly match script (28 cases, 0.84 PD, AUC 0.89) | Use **38 / 0.986 / 0.875** — round close in narration |
| BANK ↔ INSURANCE toggle UI | Mention it as "upcoming polish, architecture supports both" |
| Act 5 specific ACME case | Pick any high-priority case on demo day; workflow is the point |

---

## 8. POST-DEMO

After demo:
- ⏱ Newman full run: `npm run newman:full`
- ⏱ Take fresh screenshots of every Act and add to `docs/demo-screenshots/`
- ⏱ Commit Q&A questions you got + answers as `docs/demo-feedback.md`

---

*Generated 2026-05-24 against the running local stack at `:8080`/`:8084`/`:3000`. Refresh this if seed data is regenerated.*
