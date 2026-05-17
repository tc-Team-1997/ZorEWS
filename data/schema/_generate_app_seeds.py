"""
Synthetic data generator for the app_* schemas (004_app_schemas.sql).

Produces app_seeds.sql with realistic-looking rows for:
  app_iam.users                ~  500 operators
  app_iam.sessions             ~ 4,500 (avg ~9 per user, mix of active + revoked)
  app_iam.password_history     ~ 1,200 (avg 2-3 historical hashes per user)
  app_iam.audit_events         ~12,000 (login_success/failure, password_change, …)
  app_cases.cases              ~  720 (matches the 720-customer defaulted cohort)
  app_cases.actions            ~ 2,800 (avg ~4 actions per case)
  app_alerts.alerts            ~ 3,500 (subset of customers with active alerts)
  app_alerts.queue_assignments ~ 5,200 (more than alerts because of reassignments)
  app_bff.webhook_subscriptions ~   25 (realistic operator-managed webhooks)
  app_bff.webhook_deliveries   ~  800 (avg ~32 deliveries per active subscription)
  app_scenario.saved_scenarios ~  120

Total: ~31,000 app rows (added on top of the ~580k raw + 124k mart rows).

Run: python3 _generate_app_seeds.py
Then: psql -h localhost -p 55432 -U zorews_user -d zorews -f app_seeds.sql

Deterministic via random.seed(43) — re-running produces byte-identical SQL.
"""
from __future__ import annotations
import csv
import os
import random
import uuid
from datetime import datetime, timedelta, timezone

random.seed(43)

HERE = os.path.dirname(os.path.abspath(__file__))
SEEDS_DIR = os.path.join(HERE, "..", "dbt", "seeds")
OUT = os.path.join(HERE, "app_seeds.sql")
NOW = datetime(2026, 5, 3, 12, 0, 0, tzinfo=timezone.utc)

# ─── helpers ───────────────────────────────────────────────────────────

def sql_str(s):
    if s is None:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"

def sql_ts(dt):
    if dt is None:
        return "NULL"
    return "'" + dt.isoformat() + "'::timestamptz"

def sql_array(arr):
    inner = ", ".join(sql_str(x) for x in arr)
    return f"ARRAY[{inner}]::text[]"

def sql_jsonb(obj):
    import json
    return "'" + json.dumps(obj).replace("'", "''") + "'::jsonb"

def random_dt(start, end):
    delta = end - start
    return start + timedelta(seconds=random.randint(0, int(delta.total_seconds())))

# ─── load customer ids from the seed CSV (for FK realism) ──────────────

with open(os.path.join(SEEDS_DIR, "seed_customers.csv")) as fh:
    customer_rows = list(csv.DictReader(fh))
all_customer_ids = [r["customer_id"] for r in customer_rows]
all_customer_names = {r["customer_id"]: r["full_name"] for r in customer_rows}

# Identify the "defaulted cohort" — the customers most likely to have
# alerts + cases. Use the seed_loans.csv NPA flags as the proxy.
with open(os.path.join(SEEDS_DIR, "seed_loans.csv")) as fh:
    loan_rows = list(csv.DictReader(fh))
defaulted_customer_ids = sorted({
    r["customer_id"] for r in loan_rows
    if r["npa_status"] in ("SUBSTANDARD", "DOUBTFUL", "LOSS")
})
loans_by_customer: dict[str, list[dict]] = {}
for r in loan_rows:
    loans_by_customer.setdefault(r["customer_id"], []).append(r)

print(f"loaded {len(all_customer_ids)} customers ({len(defaulted_customer_ids)} defaulted)")

# ─── app_iam.users ─────────────────────────────────────────────────────

ROLES = [
    ("admin", 0.05),
    ("supervisor", 0.10),
    ("risk_analyst", 0.40),
    ("collection_officer", 0.25),
    ("field_officer", 0.20),
]

FIRST_NAMES = ["Alice","Brian","Catherine","Daniel","Esther","Faisal","Grace","Hassan","Irene","James",
               "Kavita","Linus","Maria","Nathan","Olivia","Peter","Quincy","Rita","Samuel","Teresa",
               "Uche","Victoria","William","Xander","Yvonne","Zara","Aaron","Beatrice","Charles","Diana",
               "Edwin","Fatuma","Geoffrey","Hannah","Isaac","Jane","Kevin","Lucy","Mark","Naomi"]
LAST_NAMES = ["Mwangi","Otieno","Wanjiru","Kamau","Njeri","Hussein","Atieno","Mutua","Singh","Owino",
              "Kiprotich","Wambui","Onyango","Kimani","Achieng","Maina","Wairimu","Karanja","Chepngeno","Kipchumba",
              "Akinyi","Nyongo","Mwende","Cheruiyot","Sang","Korir","Ruto","Bett","Limo","Kosgei"]

def make_user(idx):
    role = random.choices([r[0] for r in ROLES], weights=[r[1] for r in ROLES])[0]
    fn = random.choice(FIRST_NAMES)
    ln = random.choice(LAST_NAMES)
    username = f"{fn.lower()}.{ln.lower()}{idx:03d}"
    return {
        "user_id": f"u-{uuid.UUID(int=random.getrandbits(128)).hex[:12]}",
        "username": username,
        "email": f"{username}@apex-ews.test",
        "display_name": f"{fn} {ln}",
        "role": role,
        # Pretend-hash for the synthetic seed; real auth-svc would write argon2.
        "password_hash": f"$argon2id$v=19$m=65536,t=3,p=4${random.randbytes(8).hex()}${random.randbytes(16).hex()}",
        "failed_login_count": random.choices([0, 1, 2, 3], weights=[80, 12, 6, 2])[0],
        "must_change_password": idx % 50 == 0,  # ~2% of users on first-login
        "terms_accepted_at": random_dt(NOW - timedelta(days=180), NOW - timedelta(days=1)) if idx % 50 != 0 else None,
        "locked": idx % 200 == 0,
        "created_at": random_dt(NOW - timedelta(days=400), NOW - timedelta(days=30)),
        "last_login_at": random_dt(NOW - timedelta(days=14), NOW) if random.random() < 0.85 else None,
    }

users = [make_user(i) for i in range(1, 501)]

# Make sure the 5 demo users from auth-svc/users.ts exist verbatim.
DEMO_USERS = [
    ("u-001", "alice.admin",    "alice.admin@apex-ews.test",    "Alice Mwangi",  "admin"),
    ("u-002", "ravi.risk",      "ravi.risk@apex-ews.test",      "Ravi Otieno",   "risk_analyst"),
    ("u-003", "sue.super",      "sue.super@apex-ews.test",      "Sue Wanjiru",   "supervisor"),
    ("u-004", "carl.collect",   "carl.collect@apex-ews.test",   "Carl Kamau",    "collection_officer"),
    ("u-005", "fiona.field",    "fiona.field@apex-ews.test",    "Fiona Achieng", "field_officer"),
]
for uid, un, em, dn, role in DEMO_USERS:
    users.insert(0, {
        "user_id": uid, "username": un, "email": em, "display_name": dn, "role": role,
        "password_hash": "$argon2id$v=19$m=65536,t=3,p=4$demo$demo",
        "failed_login_count": 0, "must_change_password": False,
        "terms_accepted_at": NOW - timedelta(days=300),
        "locked": False, "created_at": NOW - timedelta(days=400),
        "last_login_at": NOW - timedelta(hours=random.randint(1, 48)),
    })

print(f"users: {len(users)}")

# ─── app_iam.sessions ──────────────────────────────────────────────────

def make_session(user, idx):
    issued = random_dt(NOW - timedelta(days=90), NOW)
    expires = issued + timedelta(hours=random.choice([12, 24, 24, 48, 168]))
    revoked = random.random() < 0.35
    return {
        "sid": f"s-{uuid.UUID(int=random.getrandbits(128)).hex[:16]}",
        "user_id": user["user_id"],
        "issued_at": issued,
        "last_seen_at": min(NOW, issued + timedelta(minutes=random.randint(5, 600))),
        "expires_at": expires,
        "ip": f"10.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}",
        "user_agent": random.choice([
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Chrome/130.0",
            "Mozilla/5.0 (Windows NT 10.0; Win64) Firefox/132.0",
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0",
            "APEX-EWS-Mobile/1.2.3 iOS/17.4",
        ]),
        "revoked": revoked,
        "revoked_at": random_dt(issued, NOW) if revoked else None,
        "revoked_reason": random.choice(["user_logout", "admin_revoke", "idle_timeout", "session_replaced"]) if revoked else None,
    }

sessions = []
for u in users:
    n = random.choices([0, 2, 5, 9, 15], weights=[5, 25, 35, 25, 10])[0]
    for i in range(n):
        sessions.append(make_session(u, i))
print(f"sessions: {len(sessions)}")

# ─── app_iam.password_history ──────────────────────────────────────────

password_history = []
for u in users:
    n = random.choices([1, 2, 3, 4, 5], weights=[10, 30, 35, 18, 7])[0]
    for i in range(n):
        password_history.append({
            "user_id": u["user_id"],
            "password_hash": f"$argon2id$v=19$m=65536,t=3,p=4${random.randbytes(8).hex()}${random.randbytes(16).hex()}",
            "set_at": random_dt(NOW - timedelta(days=365), NOW - timedelta(days=i*30)),
        })
print(f"password_history: {len(password_history)}")

# ─── app_iam.audit_events ──────────────────────────────────────────────

AUDIT_TYPES = [
    ("login_success", 0.45),
    ("login_failure", 0.20),
    ("password_change", 0.05),
    ("session_revoked", 0.08),
    ("rate_limited", 0.04),
    ("captcha_failed", 0.03),
    ("account_locked", 0.01),
    ("account_unlocked", 0.005),
    ("first_login_completed", 0.005),
    ("password_reset_requested", 0.04),
    ("password_reset_completed", 0.03),
    ("forbidden_endpoint", 0.04),
    ("user_created", 0.005),
    ("role_changed", 0.005),
]

audit_events = []
event_types = [e[0] for e in AUDIT_TYPES]
event_weights = [e[1] for e in AUDIT_TYPES]
for _ in range(12_000):
    actor = random.choice(users)
    et = random.choices(event_types, weights=event_weights)[0]
    audit_events.append({
        "event_type": et,
        "actor_username": actor["username"] if et != "login_failure" or random.random() < 0.5 else None,
        "target_username": actor["username"],
        "ip": f"10.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}",
        "user_agent": random.choice(["Chrome/130.0", "Firefox/132.0", "APEX-EWS-Mobile/1.2.3", "Safari/17.4"]),
        "occurred_at": random_dt(NOW - timedelta(days=120), NOW),
        "detail": ({"attempt": random.randint(1, 5)} if et == "login_failure" else {}),
    })
print(f"audit_events: {len(audit_events)}")

# ─── app_cases.cases (one per defaulted customer + some extras) ────────

RULES = [
    ("r-09", "DPD ≥ 30 + utilisation > 95%", "high"),
    ("r-11", "Restructure flag + utilisation > 80%", "medium"),
    ("r-14", "Cheque return 2× in 30d", "medium"),
    ("r-15", "Net flow drop 30d > 40%", "medium"),
    ("r-18", "Sudden cash withdrawal pattern", "high"),
    ("r-22", "Salary inflow stopped 60d", "critical"),
    ("r-25", "Multi-bureau delinquency confirmed", "critical"),
    ("r-03", "Bureau enquiry surge", "low"),
]

CASE_STATES = ["open", "assigned", "in_action", "monitored", "closed"]
SLA_STATUSES = ["on_track", "approaching", "breached", "closed"]

case_assignees = [u for u in users if u["role"] in ("collection_officer", "field_officer", "risk_analyst")]
cases = []
for cid in defaulted_customer_ids:
    rule_id, rule_name, severity = random.choice(RULES)
    state = random.choices(CASE_STATES, weights=[10, 20, 30, 20, 20])[0]
    assigned = state != "open"
    closed = state == "closed"
    customer_loans = loans_by_customer.get(cid, [])
    case = {
        "case_id":        f"case-{uuid.UUID(int=random.getrandbits(128)).hex[:10]}",
        "alert_id":       f"a-{uuid.UUID(int=random.getrandbits(128)).hex[:10]}",
        "customer_id":    cid,
        "customer_name":  all_customer_names[cid],
        "severity":       severity,
        "rule_id":        rule_id,
        "rule_name":      rule_name,
        "state":          state,
        "assignee":       random.choice(case_assignees)["username"] if assigned else None,
        "loan_id":        customer_loans[0]["loan_id"] if customer_loans else None,
        "reason_summary": f"[{severity.upper()}] {rule_name} on {cid}",
        "outcome":        random.choice(["cured", "cured_temp", "defaulted"]) if closed else None,
        "created_at":     random_dt(NOW - timedelta(days=60), NOW - timedelta(days=2)),
        "updated_at":     None,  # filled below
        "closed_at":      None,
        "sla_status":     "closed" if closed else random.choices(SLA_STATUSES[:3], weights=[60, 25, 15])[0],
    }
    case["updated_at"] = random_dt(case["created_at"], NOW)
    if closed:
        case["closed_at"] = case["updated_at"]
    cases.append(case)

print(f"cases: {len(cases)}")

# ─── app_cases.actions ─────────────────────────────────────────────────

ACTION_KINDS = ["call", "visit", "sms", "email", "note"]
actions = []
for c in cases:
    if c["state"] in ("open",):
        n = 0
    else:
        n = random.choices([1, 2, 3, 5, 8], weights=[20, 30, 25, 15, 10])[0]
    for _ in range(n):
        kind = random.choice(ACTION_KINDS)
        action = {
            "action_id": f"act-{uuid.UUID(int=random.getrandbits(128)).hex[:10]}",
            "case_id":   c["case_id"],
            "kind":      kind,
            "officer_id": c["assignee"] or random.choice(case_assignees)["username"],
            "occurred_at": random_dt(c["created_at"], c["updated_at"]),
            "outcome_note": random.choice([
                "Customer promised payment by Friday",
                "No answer; left voicemail",
                "Visited residence; customer confirmed salary delay",
                "Sent reminder via SMS",
                "Email sent to registered address",
                "Customer requested 14-day extension",
                "Spoke with spouse; will call back tomorrow",
                "Restructure offer accepted in principle",
                None,
            ]),
            "gps_lat": round(-1.2921 + random.uniform(-0.1, 0.1), 6) if kind == "visit" else None,
            "gps_lng": round(36.8219 + random.uniform(-0.1, 0.1), 6) if kind == "visit" else None,
            "gps_accuracy_m": round(random.uniform(5, 25), 2) if kind == "visit" else None,
        }
        actions.append(action)
print(f"actions: {len(actions)}")

# ─── app_alerts.alerts ─────────────────────────────────────────────────

# Alerts target the defaulted cohort + ~25% of WATCH-status loans (random
# customers with meaningful exposure).
watch_customer_ids = sorted({
    r["customer_id"] for r in loan_rows if r["npa_status"] == "WATCH"
})

alert_customer_pool = sorted(set(defaulted_customer_ids) | set(random.sample(watch_customer_ids, len(watch_customer_ids) // 2)))
alerts = []
for cid in alert_customer_pool:
    n = random.choices([1, 2, 3], weights=[60, 30, 10])[0]
    for _ in range(n):
        rule_id, rule_name, severity = random.choice(RULES)
        # criticality formula: severityWeight × confidence × log10(exposure/100k) × ageBoost
        sev_w = {"critical": 4, "high": 3, "medium": 2, "low": 1}[severity]
        confidence = round(random.uniform(0.55, 0.97), 3)
        cust_loans = loans_by_customer.get(cid, [])
        exposure = sum(float(l["outstanding_amount"]) for l in cust_loans) or 100_000
        import math
        exp_mult = max(1.0, 1.0 + math.log10(exposure / 100_000))
        age_min = random.randint(5, 600)
        age_boost = 1.0 if age_min < 1440 else 1.2 if age_min < 4320 else 1.5
        score = round(sev_w * confidence * exp_mult * age_boost, 2)
        created_at = NOW - timedelta(minutes=age_min)
        status = random.choices(["open", "acked", "closed"], weights=[60, 25, 15])[0]
        # Pick 1-3 indicators per alert
        ind_pool = ["IND_FIN_02","IND_FIN_05","IND_FIN_07","IND_BEH_03","IND_BEH_06","IND_TXN_03","IND_TXN_05","IND_TXN_07","IND_TXN_11","IND_CRD_01","IND_CRD_02","IND_CRD_05"]
        indicators = random.sample(ind_pool, k=random.choice([1, 2, 2, 3]))
        alerts.append({
            "alert_id":             f"a-{uuid.UUID(int=random.getrandbits(128)).hex[:10]}",
            "severity":             severity,
            "customer_id":          cid,
            "customer_name":        all_customer_names[cid],
            "rule_id":              rule_id,
            "rule_name":            rule_name,
            "indicators":           indicators,
            "confidence":           confidence,
            "customer_exposure_kes": round(exposure, 2),
            "criticality_score":    score,
            "assignee":             random.choice(["risk", "field", None, None]),
            "status":               status,
            "created_at":           created_at,
            "acked_at":             random_dt(created_at, NOW) if status in ("acked", "closed") else None,
            "closed_at":            random_dt(created_at, NOW) if status == "closed" else None,
        })

print(f"alerts: {len(alerts)}")

# ─── app_alerts.queue_assignments ──────────────────────────────────────

assignments = []
for a in alerts:
    n = random.choices([1, 2, 3], weights=[70, 25, 5])[0]
    queues = ["critical" if a["severity"] in ("critical", "high") else
              "medium" if a["severity"] == "medium" else "low"]
    for i in range(n):
        assignments.append({
            "alert_id": a["alert_id"],
            "queue": queues[0],
            "assigned_to": random.choice([None, a["assignee"]] + [u["username"] for u in case_assignees[:5]]),
            "assigned_at": random_dt(a["created_at"], NOW),
            "assigned_by": random.choice(["system", "supervisor.001", "alice.admin"]),
        })

print(f"queue_assignments: {len(assignments)}")

# ─── app_bff.webhook_subscriptions ─────────────────────────────────────

WEBHOOK_NAMES = [
    ("AML Hub primary", "https://aml-prod.bank.test/apex/events", ["alert.created", "case.assigned"]),
    ("AML Hub fallback", "https://aml-dr.bank.test/apex/events", ["alert.created"]),
    ("Collection module", "https://collection.bank.test/apex/inbound", ["case.assigned", "case.closed"]),
    ("Branch ops dashboard", "https://branch-ops.bank.test/notifications", ["alert.created", "scenario.run"]),
    ("Risk reporting BI", "https://bi.bank.test/apex/snapshot", ["scenario.run"]),
    ("Mobile push gateway", "https://push.bank.test/apex/officer-notify", ["case.assigned"]),
    ("Fraud team channel", "https://fraud.bank.test/apex/intake", ["alert.created"]),
    ("Audit replication", "https://audit-replicator.bank.test/ingest", ["alert.created", "case.assigned", "case.closed", "scenario.run"]),
    ("CIO daily digest", "https://digest.bank.test/apex/daily", ["scenario.run"]),
    ("Compliance archive", "https://compliance.bank.test/apex/archive", ["alert.created", "case.closed"]),
    ("Slack #risk-alerts", "https://hooks.slack.test/services/T0/B0/risk", ["alert.created"]),
    ("PagerDuty critical", "https://events.pagerduty.test/apex/critical", ["alert.created"]),
    ("Webhook test endpoint (dev)", "https://webhook.site/dev-bin", ["webhook.test"]),
    ("Customer ops queue", "https://ops.bank.test/apex/queue", ["case.assigned"]),
    ("Internal audit log", "https://audit.bank.test/apex/log", ["alert.created", "case.closed"]),
    ("Risk dashboard refresh", "https://riskdash.bank.test/apex/refresh", ["scenario.run"]),
    ("Treasury risk feed", "https://treasury.bank.test/apex/risk", ["scenario.run"]),
    ("Email notification gateway", "https://email-gw.bank.test/apex/notify", ["case.assigned", "case.closed"]),
    ("SMS notification gateway", "https://sms-gw.bank.test/apex/notify", ["case.assigned"]),
    ("Regional ops Mombasa", "https://msa-ops.bank.test/apex", ["alert.created"]),
    ("Regional ops Kisumu", "https://ksm-ops.bank.test/apex", ["alert.created"]),
    ("Regional ops Eldoret", "https://eld-ops.bank.test/apex", ["alert.created"]),
    ("ML retraining trigger", "https://ml-pipeline.bank.test/apex/retrain", ["scenario.run"]),
    ("Compliance Slack", "https://hooks.slack.test/services/T0/B0/compliance", ["case.closed"]),
    ("Risk Slack", "https://hooks.slack.test/services/T0/B0/risk-team", ["alert.created"]),
]

webhook_subs = []
for idx, (name, url, events) in enumerate(WEBHOOK_NAMES):
    last = random_dt(NOW - timedelta(days=10), NOW) if idx < 18 else None
    webhook_subs.append({
        "subscription_id":       f"wh-{uuid.UUID(int=random.getrandbits(128)).hex[:8]}",
        "name":                  name,
        "url":                   url,
        "secret":                random.randbytes(32).hex(),
        "events":                events,
        "active":                idx < 22,  # last 3 inactive
        "created_at":            random_dt(NOW - timedelta(days=200), NOW - timedelta(days=10)),
        "last_delivery_at":      last,
        "last_delivery_status":  random.choice(["success", "success", "success", "failed"]) if last else None,
    })

print(f"webhook_subscriptions: {len(webhook_subs)}")

# ─── app_bff.webhook_deliveries ────────────────────────────────────────

deliveries = []
for sub in webhook_subs:
    if not sub["active"]:
        continue
    n = random.choices([10, 25, 50, 75, 120], weights=[20, 30, 25, 15, 10])[0]
    for _ in range(n):
        success = random.random() < 0.92
        attempts = 1 if success else random.choice([1, 2, 3])
        et = random.choice(sub["events"])
        created = random_dt(NOW - timedelta(days=30), NOW)
        deliveries.append({
            "delivery_id":     f"wd-{uuid.UUID(int=random.getrandbits(128)).hex[:8]}",
            "subscription_id": sub["subscription_id"],
            "event_type":      et,
            "payload":         {"event": et, "ts": created.isoformat(), "synthetic": True},
            "attempts":        attempts,
            "status":          "success" if success else "failed",
            "response_status": 200 if success else random.choice([500, 502, 503, 0, 401]),
            "response_body":   "ok" if success else random.choice(["internal server error", "service unavailable", "", "unauthorized"]),
            "created_at":      created,
            "completed_at":    created + timedelta(seconds=random.randint(1, 25)),
        })

print(f"webhook_deliveries: {len(deliveries)}")

# ─── app_scenario.saved_scenarios ──────────────────────────────────────

SCENARIO_TEMPLATES = [
    ("Baseline", 0, 0, 0),
    ("Mild recession Q3", -2, 50, 3),
    ("Mild recession Q4", -2, 75, 4),
    ("Severe recession 2026", -5, 200, 8),
    ("COVID-like demand cliff", -7, -75, 5),
    ("RBI mandated stress", -3, 200, 10),
    ("Rate hike +200 bps", 0, 200, 0),
    ("FX stress KES -10%", 0, 0, 10),
    ("Combined stress test", -3, 150, 6),
    ("Conservative recovery", 1, -50, -2),
    ("Optimistic growth", 2, -50, -3),
    ("Black swan", -7, 350, 18),
]

saved_scenarios = []
saver_pool = [u for u in users if u["role"] in ("admin", "supervisor", "risk_analyst")]
for _ in range(120):
    name, gdp, rate, fx = random.choice(SCENARIO_TEMPLATES)
    saved_scenarios.append({
        "scenario_id": f"s-{uuid.UUID(int=random.getrandbits(128)).hex[:12]}",
        "name":        f"{name} ({random.choice(['Q1','Q2','Q3','Q4'])} {random.choice([2025, 2026])})",
        "saved_by":    random.choice(saver_pool)["username"],
        "saved_at":    random_dt(NOW - timedelta(days=180), NOW),
        "gdp_shock_pct":  gdp,
        "rate_shock_bps": rate,
        "fx_shock_pct":   fx,
        "result":         {
            "inputs": {"gdp": gdp, "rate": rate, "fx": fx},
            "portfolio_size": 240,
            "baseline_ecl_kes":  random.randint(8_000_000, 15_000_000),
            "stressed_ecl_kes":  random.randint(8_000_000, 28_000_000),
            "baseline_portfolio_pd": round(random.uniform(0.04, 0.06), 4),
            "stressed_portfolio_pd": round(random.uniform(0.04, 0.12), 4),
            "synthetic_seed": True,
        },
    })

print(f"saved_scenarios: {len(saved_scenarios)}")

# ─── write SQL ─────────────────────────────────────────────────────────

lines = []
lines.append("-- app_seeds.sql — generated by _generate_app_seeds.py")
lines.append(f"-- Generated at: {NOW.isoformat()}")
lines.append("BEGIN;")
lines.append("")
lines.append("-- Truncate to make this idempotent.")
lines.append("TRUNCATE app_iam.audit_events, app_iam.password_history, app_iam.sessions, app_iam.users RESTART IDENTITY CASCADE;")
lines.append("TRUNCATE app_cases.actions, app_cases.cases CASCADE;")
lines.append("TRUNCATE app_alerts.queue_assignments, app_alerts.alerts RESTART IDENTITY CASCADE;")
lines.append("TRUNCATE app_bff.webhook_deliveries, app_bff.webhook_subscriptions CASCADE;")
lines.append("TRUNCATE app_scenario.saved_scenarios;")
lines.append("")

# Helper: chunked INSERTs (Postgres has a 1664-arg cap per statement)
def emit_inserts(table, cols, rows, chunk=500):
    lines.append(f"-- {table}: {len(rows)} rows")
    for start in range(0, len(rows), chunk):
        batch = rows[start:start + chunk]
        lines.append(f"INSERT INTO {table} ({', '.join(cols)}) VALUES")
        value_strs = []
        for r in batch:
            vals = []
            for col in cols:
                v = r[col]
                if v is None:
                    vals.append("NULL")
                elif isinstance(v, bool):
                    vals.append("TRUE" if v else "FALSE")
                elif isinstance(v, datetime):
                    vals.append(sql_ts(v))
                elif isinstance(v, list):
                    vals.append(sql_array(v))
                elif isinstance(v, dict):
                    vals.append(sql_jsonb(v))
                elif isinstance(v, (int, float)):
                    vals.append(str(v))
                else:
                    vals.append(sql_str(str(v)))
            value_strs.append("  (" + ", ".join(vals) + ")")
        lines.append(",\n".join(value_strs) + ";")
    lines.append("")

emit_inserts("app_iam.users",
             ["user_id","username","email","display_name","role","password_hash",
              "failed_login_count","must_change_password","terms_accepted_at","locked",
              "created_at","last_login_at"],
             users)

emit_inserts("app_iam.sessions",
             ["sid","user_id","issued_at","last_seen_at","expires_at","ip","user_agent",
              "revoked","revoked_at","revoked_reason"],
             sessions)

emit_inserts("app_iam.password_history",
             ["user_id","password_hash","set_at"],
             password_history)

emit_inserts("app_iam.audit_events",
             ["event_type","actor_username","target_username","ip","user_agent",
              "occurred_at","detail"],
             audit_events,
             chunk=300)

emit_inserts("app_cases.cases",
             ["case_id","alert_id","customer_id","customer_name","severity","rule_id","rule_name",
              "state","assignee","loan_id","reason_summary","outcome",
              "created_at","updated_at","closed_at","sla_status"],
             cases)

emit_inserts("app_cases.actions",
             ["action_id","case_id","kind","officer_id","occurred_at","outcome_note",
              "gps_lat","gps_lng","gps_accuracy_m"],
             actions)

emit_inserts("app_alerts.alerts",
             ["alert_id","severity","customer_id","customer_name","rule_id","rule_name",
              "indicators","confidence","customer_exposure_kes","criticality_score",
              "assignee","status","created_at","acked_at","closed_at"],
             alerts)

emit_inserts("app_alerts.queue_assignments",
             ["alert_id","queue","assigned_to","assigned_at","assigned_by"],
             assignments)

emit_inserts("app_bff.webhook_subscriptions",
             ["subscription_id","name","url","secret","events","active",
              "created_at","last_delivery_at","last_delivery_status"],
             webhook_subs)

emit_inserts("app_bff.webhook_deliveries",
             ["delivery_id","subscription_id","event_type","payload","attempts",
              "status","response_status","response_body","created_at","completed_at"],
             deliveries,
             chunk=200)

emit_inserts("app_scenario.saved_scenarios",
             ["scenario_id","name","saved_by","saved_at",
              "gdp_shock_pct","rate_shock_bps","fx_shock_pct","result"],
             saved_scenarios)

lines.append("COMMIT;")
lines.append("")

with open(OUT, "w") as fh:
    fh.write("\n".join(lines))

print(f"\nwrote {OUT} ({len(lines)} lines)")
print(f"total app rows: "
      f"{len(users)+len(sessions)+len(password_history)+len(audit_events)+len(cases)+len(actions)+len(alerts)+len(assignments)+len(webhook_subs)+len(deliveries)+len(saved_scenarios)}")
