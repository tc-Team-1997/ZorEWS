"""Happy-path tests for pipeline-svc."""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_trigger_known_dag_then_lists():
    r = client.post("/pipeline/run/feature_build")
    assert r.status_code == 200
    body = r.json()
    assert body["dag_id"] == "feature_build"
    assert body["state"] == "queued"
    assert body["run_id"].startswith("manual__")

    r = client.get("/pipeline/runs")
    assert r.status_code == 200
    runs = r.json()["runs"]
    assert any(run["run_id"] == body["run_id"] for run in runs)


def test_trigger_unknown_dag_404():
    r = client.post("/pipeline/run/does_not_exist")
    assert r.status_code == 404
