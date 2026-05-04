"""End-to-end tests for the ai-copilot-svc FastAPI app."""

from __future__ import annotations


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["model_version"] == "0.0.1-test"


def test_model_info(client):
    r = client.get("/model/info")
    assert r.status_code == 200
    body = r.json()
    assert body["champion"]["name"] == "pd_xgboost"
    assert body["champion"]["version"] == "0.0.1-test"
    assert body["level_bands"]["low_max"] == 0.05
    assert body["level_bands"]["high_min"] == 0.20


def test_score_happy_path(client, sample_customer):
    r = client.post("/score", json=sample_customer)
    assert r.status_code == 200, r.text
    body = r.json()
    assert 0.0 <= body["pd"] <= 1.0
    assert body["level"] in {"Low", "Medium", "High"}
    assert body["model_name"] == "pd_xgboost"
    assert body["model_version"] == "0.0.1-test"
    assert isinstance(body["top_reasons"], list)
    assert len(body["top_reasons"]) <= 5
    if body["top_reasons"]:
        first = body["top_reasons"][0]
        assert {"feature", "value", "shap_value", "direction"}.issubset(first.keys())
        assert first["direction"] in {"positive", "negative"}


def test_level_banding(client, sample_customer):
    # Very low-risk profile -> Low
    safe = dict(sample_customer)
    safe.update(
        {
            "utilization": 0.05,
            "dpd_max_90d": 0.0,
            "balance_drop_30d_pct": 5.0,
            "bureau_score": 820.0,
            "repayment_delay_streak": 0,
            "txn_volume_zscore_90d": 1.0,
            "tenure_months": 120,
            "product_type": "mortgage",
            "income_bucket": "high",
        }
    )
    safe_pd = client.post("/score", json=safe).json()["pd"]

    # Very high-risk profile -> typically High (or at least Medium)
    risky = dict(sample_customer)
    risky.update(
        {
            "utilization": 0.98,
            "dpd_max_90d": 75.0,
            "balance_drop_30d_pct": -55.0,
            "bureau_score": 420.0,
            "repayment_delay_streak": 6,
            "txn_volume_zscore_90d": -2.5,
            "tenure_months": 4,
            "product_type": "personal_loan",
            "income_bucket": "low",
        }
    )
    risky_pd = client.post("/score", json=risky).json()["pd"]

    assert risky_pd > safe_pd, f"expected risky_pd ({risky_pd}) > safe_pd ({safe_pd})"


def test_batch(client, sample_customer):
    customers = []
    for i in range(5):
        c = dict(sample_customer)
        c["customer_id"] = f"BATCH{i:03d}"
        c["utilization"] = 0.1 + i * 0.15
        customers.append(c)
    r = client.post("/score/batch", json={"customers": customers})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["scores"]) == 5
    ids = [s["customer_id"] for s in body["scores"]]
    assert ids == [f"BATCH{i:03d}" for i in range(5)]
    for s in body["scores"]:
        assert 0.0 <= s["pd"] <= 1.0
        assert s["level"] in {"Low", "Medium", "High"}


def test_score_validates_input(client, sample_customer):
    bad = dict(sample_customer)
    bad["utilization"] = -1.0  # out of range
    r = client.post("/score", json=bad)
    assert r.status_code == 422
