"""
Deterministic seed generator for APEX EWS dbt project.

Produces five CSVs under data/dbt/seeds/:
    seed_customers.csv         (>= 200 rows, unique customer_id)
    seed_loans.csv             (>= 500 rows; ~6% in DOUBTFUL/LOSS)
    seed_repayments.csv        (>= 5000 rows)
    seed_transactions.csv      (>= 5000 rows; we generate ~6000)
    seed_bureau_score.csv      (one snapshot per customer)

Distributions are loosely calibrated to a Kenyan retail-SME microfinance book:
    * 70% retail, 25% SME, 5% corp.
    * Median monthly income KES 45k retail / 380k SME / 1.2M corp.
    * NPA prevalence ~6% — split SUBSTANDARD/DOUBTFUL/LOSS roughly 3/2/1.

Run: python3 _generate_seeds.py
The generator is fully deterministic (random.seed(42)) — re-running produces
byte-identical CSVs, so dbt seed is reproducible across machines.
"""
from __future__ import annotations
import csv
import os
import random
from datetime import date, datetime, timedelta, timezone

random.seed(42)

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- knobs
# Scaled up 2026-05-03 from 220 → 10,000 customers so DBeaver / live-data
# screens look populated. Volumes grow proportionally:
#   ~10k customers · ~24k loans · ~250k repayments · ~280k txns · 10k bureau
# Total raw rows ≈ 575k. Postgres handles this without strain; mart rebuild
# takes ~30s on a laptop. Keep the same distribution knobs so risk
# characteristics are preserved.
N_CUSTOMERS    = 10_000
N_LOANS_TARGET = 24_000   # ~2.4 loans/customer for the active borrowers
N_TXNS_TARGET  = 280_000
NPA_RATIO      = 0.06     # 6% defaulted cohort
TODAY          = date(2026, 4, 26)

SEGMENTS = [
    ("retail", 0.70, (15_000,   90_000)),
    ("sme",    0.25, (180_000, 750_000)),
    ("corp",   0.05, (700_000, 3_000_000)),
]
PRODUCTS = [
    ("PL_RET",   "retail", (50_000,   500_000),  (12, 36),  (0.18, 0.24)),
    ("AUTO_RET", "retail", (300_000, 2_500_000), (24, 60),  (0.13, 0.18)),
    ("WC_SME",   "sme",    (500_000, 5_000_000), (12, 36),  (0.15, 0.20)),
    ("INV_SME",  "sme",    (1_000_000, 8_000_000),(24, 60), (0.14, 0.19)),
    ("CORP_TL",  "corp",   (5_000_000, 25_000_000),(24, 84),(0.11, 0.16)),
]
BRANCHES = ["NBO-001","NBO-002","NBO-003","MSA-010","KSM-020","ELD-030","NKR-040"]
CHANNELS = ["mpesa","branch","standing-order","card"]
TXN_CATS = ["salary","mpesa","atm","pos","standing-order","loan-disb","loan-repay","biller"]
BUREAUS  = ["Metropol","TransUnion","CreditInfo"]

# ---------------------------------------------------------------- helpers
def pick_segment():
    r = random.random()
    cum = 0.0
    for s, w, inc in SEGMENTS:
        cum += w
        if r <= cum:
            return s, inc
    return SEGMENTS[-1][0], SEGMENTS[-1][2]


def pick_product(segment):
    options = [p for p in PRODUCTS if p[1] == segment]
    return random.choice(options) if options else random.choice(PRODUCTS)


def iso_dt(d: datetime | date) -> str:
    if isinstance(d, datetime):
        return d.astimezone(timezone.utc).isoformat()
    return d.isoformat()


def random_dt_between(start: datetime, end: datetime) -> datetime:
    delta = end - start
    return start + timedelta(seconds=random.randint(0, int(delta.total_seconds())))

# ---------------------------------------------------------------- customers
customers = []
for i in range(1, N_CUSTOMERS + 1):
    cid = f"C{i:05d}"
    seg, inc_range = pick_segment()
    monthly_income = round(random.uniform(*inc_range), 2)
    dob = date(random.randint(1960, 2003), random.randint(1, 12), random.randint(1, 28))
    onboarded = datetime(random.randint(2018, 2025), random.randint(1, 12),
                         random.randint(1, 28), tzinfo=timezone.utc)
    customers.append({
        "source_event_id":  f"EV-CUST-{cid}",
        "customer_id":      cid,
        "full_name":        f"Customer {i:05d}",
        "national_id":      f"NID{random.randint(10_000_000, 39_999_999)}",
        "date_of_birth":    dob.isoformat(),
        "gender":           random.choice(["male","female"]),
        "marital_status":   random.choice(["single","married","divorced"]),
        "employment_status":random.choice(["employed","self-employed","business-owner","unemployed"]),
        "monthly_income":   f"{monthly_income:.2f}",
        "branch_code":      random.choice(BRANCHES),
        "segment":          seg,
        "onboarded_at":     iso_dt(onboarded),
        "kyc_status":       random.choices(["verified","pending","rejected"], weights=[92,6,2])[0],
        "risk_rating":      random.choices(["low","medium","high"], weights=[60,30,10])[0],
        "payload":          "{}",
    })

# Pre-pick a defaulted cohort (target ~6% of LOANS, so map via customers)
n_default_customers = max(1, int(round(N_CUSTOMERS * NPA_RATIO * 1.2)))
defaulted_customers = set(random.sample([c["customer_id"] for c in customers], n_default_customers))

# ---------------------------------------------------------------- loans
loans = []
loan_idx = 0
loan_meta = {}  # loan_id -> dict for downstream use
while loan_idx < N_LOANS_TARGET:
    cust = random.choice(customers)
    loan_idx += 1
    lid = f"L{loan_idx:06d}"
    code, seg, p_range, t_range, ir_range = pick_product(cust["segment"])
    principal = round(random.uniform(*p_range), 2)
    rate = round(random.uniform(*ir_range), 4)
    tenor = random.randint(*t_range)
    disbursed = datetime(random.randint(2023, 2026), random.randint(1, 12),
                         random.randint(1, 28), tzinfo=timezone.utc)
    maturity = (disbursed + timedelta(days=30 * tenor)).date()

    is_default = cust["customer_id"] in defaulted_customers and random.random() < 0.6
    if is_default:
        npa = random.choices(["SUBSTANDARD","DOUBTFUL","LOSS"], weights=[3,2,1])[0]
        dpd = {"SUBSTANDARD": random.randint(91,180),
               "DOUBTFUL":    random.randint(181,360),
               "LOSS":        random.randint(361, 720)}[npa]
        outstanding = round(principal * random.uniform(0.55, 0.95), 2)
        last_repay = disbursed + timedelta(days=random.randint(30, 90))
    else:
        # 12% in early-warning WATCH, 88% PERFORMING
        if random.random() < 0.12:
            npa = "WATCH"
            dpd = random.randint(31, 60)
            outstanding = round(principal * random.uniform(0.4, 0.85), 2)
        else:
            npa = "PERFORMING"
            dpd = random.choices([0, random.randint(1,15), random.randint(16,30)],
                                 weights=[80,15,5])[0]
            outstanding = round(principal * random.uniform(0.05, 0.7), 2)
        last_repay = datetime.combine(TODAY - timedelta(days=random.randint(0, 25)),
                                       datetime.min.time(), tzinfo=timezone.utc)
    collateral = round(principal * random.uniform(0.6, 1.4), 2) if seg != "retail" else None

    rec = {
        "source_event_id":   f"EV-LOAN-{lid}",
        "loan_id":           lid,
        "customer_id":       cust["customer_id"],
        "product_code":      code,
        "currency":          "KES",
        "principal_amount":  f"{principal:.2f}",
        "outstanding_amount":f"{outstanding:.2f}",
        "interest_rate":     f"{rate:.4f}",
        "tenor_months":      tenor,
        "disbursed_at":      iso_dt(disbursed),
        "maturity_date":     maturity.isoformat(),
        "npa_status":        npa,
        "days_past_due":     dpd,
        "last_repayment_at": iso_dt(last_repay),
        "collateral_value":  f"{collateral:.2f}" if collateral is not None else "",
        "branch_code":       cust["branch_code"],
        "payload":           "{}",
    }
    loans.append(rec)
    loan_meta[lid] = {
        "customer_id": cust["customer_id"],
        "principal": principal,
        "tenor": tenor,
        "disbursed": disbursed,
        "is_default": is_default,
        "npa": npa,
    }

actual_npa = sum(1 for l in loans if l["npa_status"] in ("SUBSTANDARD","DOUBTFUL","LOSS"))
npa_ratio_actual = actual_npa / len(loans)

# ---------------------------------------------------------------- repayments
repayments = []
rep_idx = 0
for lid, meta in loan_meta.items():
    # ~12 months of monthly repayments capped to repayments-per-loan budget
    months = min(meta["tenor"], 12 + random.randint(0, 8))
    sched_emi = round(meta["principal"] / max(meta["tenor"], 6), 2)
    for m in range(1, months + 1):
        rep_idx += 1
        rid = f"R{rep_idx:07d}"
        rdate = (meta["disbursed"] + timedelta(days=30 * m)).date()
        if rdate > TODAY:
            break
        if meta["is_default"] and m > random.randint(2, 6):
            # Defaulted cohort stops paying after a few EMIs
            paid = round(sched_emi * random.uniform(0.0, 0.4), 2)
            arrears = True
        elif meta["npa"] == "WATCH" and random.random() < 0.4:
            paid = round(sched_emi * random.uniform(0.5, 0.95), 2)
            arrears = True
        else:
            paid = round(sched_emi * random.uniform(0.95, 1.05), 2)
            arrears = False
        principal_paid = round(paid * random.uniform(0.55, 0.75), 2)
        interest_paid  = round(paid * random.uniform(0.20, 0.35), 2)
        fees_paid      = round(max(paid - principal_paid - interest_paid, 0), 2)
        repayments.append({
            "source_event_id":   f"EV-REP-{rid}",
            "repayment_id":      rid,
            "loan_id":           lid,
            "customer_id":       meta["customer_id"],
            "repayment_date":    rdate.isoformat(),
            "scheduled_amount":  f"{sched_emi:.2f}",
            "paid_amount":       f"{paid:.2f}",
            "principal_paid":    f"{principal_paid:.2f}",
            "interest_paid":     f"{interest_paid:.2f}",
            "fees_paid":         f"{fees_paid:.2f}",
            "currency":          "KES",
            "channel":           random.choice(CHANNELS),
            "is_arrears_payment":"true" if arrears else "false",
            "payload":           "{}",
        })
    # No safety cap — at 10k customers / 24k loans the natural ceiling is
    # ~250k repayments which Postgres handles without strain.

# ---------------------------------------------------------------- transactions
transactions = []
txn_idx = 0
n_per_cust = max(1, N_TXNS_TARGET // N_CUSTOMERS)
for cust in customers:
    is_def = cust["customer_id"] in defaulted_customers
    # defaulted customers see declining inflows in last 60d
    base_inflow = float(cust["monthly_income"])
    for k in range(n_per_cust + random.randint(-3, 5)):
        txn_idx += 1
        tid = f"T{txn_idx:08d}"
        days_back = random.randint(0, 180)
        ts = datetime.combine(TODAY - timedelta(days=days_back),
                              datetime.min.time(), tzinfo=timezone.utc) \
             + timedelta(seconds=random.randint(0, 86_400 - 1))
        cat = random.choice(TXN_CATS)
        if cat in ("salary","mpesa","loan-disb"):
            t_type = "credit"
            amt = round(random.uniform(0.05, 1.2) * base_inflow / 4, 2)
            if is_def and days_back < 60:
                amt = round(amt * 0.4, 2)  # inflow drop signal
        else:
            t_type = "debit"
            amt = round(random.uniform(0.02, 0.5) * base_inflow / 4, 2)
            if is_def and days_back < 60 and random.random() < 0.3:
                amt = round(amt * 1.4, 2)  # outflow spike signal
        bal = round(random.uniform(1_000, 250_000), 2)
        transactions.append({
            "source_event_id":  f"EV-TXN-{tid}",
            "txn_id":           tid,
            "customer_id":      cust["customer_id"],
            "account_id":       f"A{cust['customer_id'][1:]}-01",
            "txn_timestamp":    iso_dt(ts),
            "txn_type":         t_type,
            "txn_category":     cat,
            "amount":           f"{amt:.2f}",
            "currency":         "KES",
            "balance_after":    f"{bal:.2f}",
            "counterparty":     f"CP-{random.randint(1,9999):04d}",
            "channel":          random.choice(CHANNELS),
            "payload":          "{}",
        })

# ---------------------------------------------------------------- bureau
bureau_rows = []
for cust in customers:
    is_def = cust["customer_id"] in defaulted_customers
    if is_def:
        score = random.randint(280, 520)
    else:
        score = random.randint(540, 850)
    if score < 400:    band = "E"
    elif score < 500:  band = "D"
    elif score < 600:  band = "C"
    elif score < 720:  band = "B"
    else:              band = "A"
    bureau_rows.append({
        "source_event_id":  f"EV-BUR-{cust['customer_id']}",
        "customer_id":      cust["customer_id"],
        "bureau_name":      random.choice(BUREAUS),
        "score":            score,
        "score_band":       band,
        "score_as_of":      (TODAY - timedelta(days=random.randint(0, 6))).isoformat(),
        "delinquencies_12m": random.randint(3, 9) if is_def else random.randint(0, 2),
        "open_facilities":  random.randint(1, 7),
        "total_exposure":   f"{random.uniform(50_000, 4_000_000):.2f}",
        "enquiries_3m":     random.randint(0, 4),
        "payload":          "{}",
    })

# ---------------------------------------------------------------- write
def write_csv(name, rows, fieldnames):
    path = os.path.join(HERE, name)
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"wrote {len(rows):>5d} rows -> {name}")


write_csv("seed_customers.csv", customers, list(customers[0].keys()))
write_csv("seed_loans.csv", loans, list(loans[0].keys()))
write_csv("seed_repayments.csv", repayments, list(repayments[0].keys()))
write_csv("seed_transactions.csv", transactions, list(transactions[0].keys()))
write_csv("seed_bureau_score.csv", bureau_rows, list(bureau_rows[0].keys()))

print(f"\nNPA loan ratio: {npa_ratio_actual:.2%} ({actual_npa}/{len(loans)})")
print(f"defaulted cohort customers: {len(defaulted_customers)}/{N_CUSTOMERS}")
