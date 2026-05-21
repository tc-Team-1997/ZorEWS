# APEX EWS — top-level dev orchestration.
#
# Goals:
#   * `make install`            install deps for every workspace (and build
#                               the @apex-ews/rbac helper that cases/bff/
#                               alerts/collection-adapter import from dist/).
#   * `make test`               run every test suite (TS jest, Python pytest,
#                               web vitest). Mirrors what services-ci.yml +
#                               schema-compat.yml + rbac-matrix.yml do.
#   * `make build`              tsc-build every TS service + vite-build web.
#   * `make lint`               terraform fmt -check + recursive scan
#                               (mirrors terraform-ci.yml).
#   * `make ci`                 install + test + build + lint. The "I just
#                               cloned, did I break anything" target.
#   * `make up`                 start every backend service in the
#                               background; track PIDs in .pids/ so
#                               `make down` can kill them cleanly. Path B
#                               from the local-run guide.
#   * `make down`               kill every service started by `make up`.
#   * `make smoke`              curl /healthz on each running service.
#   * `make ps`                 list running services and ports.
#
# Conventions:
#   * Each target prints a one-line banner so the user can see progress.
#   * Background processes write to .logs/<svc>.log and .pids/<svc>.pid.
#   * Failures stop the chain (set -e via shell hook in each recipe).

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

REPO_ROOT := $(shell pwd)
PIDS_DIR  := $(REPO_ROOT)/.pids
LOGS_DIR  := $(REPO_ROOT)/.logs

# Service registry — name : path : default port.
# alerts default port (8082) clashes with indicators, so we override it to 8086.
TS_SERVICES := \
  rbac-lib:infra/rbac/lib:- \
  event-bus:services/event-bus:- \
  cases:services/regulatory-svc/cases:8083 \
  rules:services/regulatory-svc/rules:8081 \
  indicators:services/regulatory-svc/indicators:8082 \
  alerts:services/regulatory-svc/alerts:8086 \
  bff:services/bff:8084 \
  collection-adapter:services/collection-adapter:8085 \
  notification-svc:services/notification-svc:- \
  auth-svc:services/auth-svc:8080 \
  integration-mocks:services/integration-mocks:8091

# Subset that participate in `make up` (have an HTTP server with /healthz).
RUNNABLE := cases rules indicators alerts bff collection-adapter auth-svc integration-mocks

WEB_PATH      := web
RBAC_PATH     := infra/rbac/lib
RBAC_PYTESTS  := infra/rbac/tests
SCHEMA_PYTESTS := infra/schema-registry/tests
TF_LAYERS := 00-landing-zone 10-network 20-eks 30-data 40-edge

# ---------- helpers ----------

.PHONY: help
help:
	@echo "APEX EWS — top-level dev targets"
	@echo
	@echo "  make install   # npm/pip deps everywhere + build @apex-ews/rbac"
	@echo "  make test      # every TS jest + Python pytest + web vitest"
	@echo "  make build     # tsc every TS service + vite build web"
	@echo "  make lint      # terraform fmt -check across the IaC tree"
	@echo "  make ci        # install + test + build + lint (full PR check)"
	@echo
	@echo "  make up        # start every backend service in the background"
	@echo "  make down      # kill every service started by make up"
	@echo "  make smoke     # curl /healthz on each running service"
	@echo "  make ps        # list running services + ports"
	@echo "  make logs      # tail -f all running service logs"
	@echo
	@echo "  make web-dev   # vite dev server (Path A) — http://localhost:5173"

# ---------- install ----------

.PHONY: install install-rbac install-event-bus install-services install-web install-py
install: install-rbac install-event-bus install-services install-web install-py
	@echo "==> all dependencies installed"

install-rbac:
	@echo "==> @apex-ews/rbac install + build (cases/bff/alerts/collection-adapter import dist/)"
	@cd $(RBAC_PATH) && npm install --no-audit --no-fund && npm run build

install-event-bus:
	@echo "==> @apex-ews/event-bus install + build (alerts/cases/indicators import dist/)"
	@cd services/event-bus && npm install --no-audit --no-fund && npm run build

install-services:
	@for entry in $(TS_SERVICES); do \
	  name=$${entry%%:*}; rest=$${entry#*:}; path=$${rest%%:*}; \
	  if [ "$$name" = "rbac-lib" ] || [ "$$name" = "event-bus" ]; then continue; fi; \
	  echo "==> install $$name ($$path)"; \
	  (cd $(REPO_ROOT)/$$path && npm install --no-audit --no-fund) || exit 1; \
	done

install-web:
	@echo "==> install web (vite + react + msw)"
	@cd $(WEB_PATH) && npm install --no-audit --no-fund

install-py:
	@echo "==> python deps already in .venv (jsonschema, pytest, ajv stack via dbt)"
	@test -d .venv || (echo "no .venv — bootstrap first per BOOTSTRAP.md" && exit 1)

# ---------- test ----------

.PHONY: test test-ts test-py test-web
test: test-ts test-py test-web
	@echo "==> all suites pass"

test-ts:
	@for entry in $(TS_SERVICES); do \
	  name=$${entry%%:*}; rest=$${entry#*:}; path=$${rest%%:*}; \
	  echo "==> jest $$name"; \
	  (cd $(REPO_ROOT)/$$path && npm test --silent) || exit 1; \
	done

test-py:
	@echo "==> pytest schema-registry + rbac"
	@source .venv/bin/activate && pytest $(SCHEMA_PYTESTS) $(RBAC_PYTESTS) -q

test-web:
	@echo "==> vitest web"
	@cd $(WEB_PATH) && npx vitest run

# ---------- build ----------

.PHONY: build build-ts build-web
build: build-ts build-web
	@echo "==> all builds clean"

build-ts:
	@for entry in $(TS_SERVICES); do \
	  name=$${entry%%:*}; rest=$${entry#*:}; path=$${rest%%:*}; \
	  echo "==> tsc $$name"; \
	  (cd $(REPO_ROOT)/$$path && npm run --silent build) || exit 1; \
	done

build-web:
	@echo "==> vite build web"
	@cd $(WEB_PATH) && npm run --silent build

# ---------- lint ----------

.PHONY: lint
lint:
	@echo "==> terraform fmt -check (recursive)"
	@terraform fmt -check -recursive infra/terraform
	@for layer in $(TF_LAYERS); do \
	  echo "==> terraform validate $$layer"; \
	  (cd infra/terraform/$$layer && terraform init -backend=false -input=false >/dev/null 2>&1 && terraform validate -no-color) || exit 1; \
	done

# ---------- ci ----------

.PHONY: ci
ci: install test build lint
	@echo "==> CI green locally"

# ---------- up / down / smoke ----------

.PHONY: up down smoke ps logs
up: install-rbac
	@mkdir -p $(PIDS_DIR) $(LOGS_DIR)
	@for name in $(RUNNABLE); do \
	  for entry in $(TS_SERVICES); do \
	    en=$${entry%%:*}; rest=$${entry#*:}; path=$${rest%%:*}; port=$${rest#*:}; \
	    if [ "$$en" = "$$name" ]; then \
	      pidfile=$(PIDS_DIR)/$$name.pid; \
	      if [ -f $$pidfile ] && kill -0 $$(cat $$pidfile) 2>/dev/null; then \
	        echo "  $$name already running (pid $$(cat $$pidfile))"; \
	      else \
	        echo "==> start $$name ($$path) on :$$port"; \
	        ( cd $(REPO_ROOT)/$$path && \
	          PORT=$$port APEX_CASES_URL=http://localhost:8083 \
	          nohup npm run --silent dev > $(LOGS_DIR)/$$name.log 2>&1 & \
	          echo $$! > $$pidfile ); \
	      fi; \
	    fi; \
	  done; \
	done
	@echo
	@echo "==> services starting; run 'make smoke' in ~10s to verify"

down:
	@if [ ! -d $(PIDS_DIR) ]; then echo "no .pids/ — nothing to kill"; exit 0; fi
	@for f in $(PIDS_DIR)/*.pid; do \
	  [ -f "$$f" ] || continue; \
	  pid=$$(cat $$f); name=$$(basename $$f .pid); \
	  if kill -0 $$pid 2>/dev/null; then \
	    echo "==> kill $$name (pid $$pid)"; kill $$pid; \
	  fi; \
	  rm -f $$f; \
	done

smoke:
	@for name in $(RUNNABLE); do \
	  for entry in $(TS_SERVICES); do \
	    en=$${entry%%:*}; rest=$${entry#*:}; path=$${rest%%:*}; port=$${rest#*:}; \
	    if [ "$$en" = "$$name" ] && [ "$$port" != "-" ]; then \
	      printf "  :%s %-22s " "$$port" "$$name"; \
	      curl -sf http://localhost:$$port/healthz >/dev/null && echo "OK" || echo "DOWN"; \
	    fi; \
	  done; \
	done

ps:
	@if [ ! -d $(PIDS_DIR) ]; then echo "(no services tracked)"; exit 0; fi
	@for f in $(PIDS_DIR)/*.pid; do \
	  [ -f "$$f" ] || continue; \
	  name=$$(basename $$f .pid); pid=$$(cat $$f); \
	  if kill -0 $$pid 2>/dev/null; then \
	    echo "  $$name pid=$$pid (running)"; \
	  else \
	    echo "  $$name pid=$$pid (DEAD — stale .pids/$$name.pid)"; \
	  fi; \
	done

logs:
	@if [ ! -d $(LOGS_DIR) ]; then echo "no .logs/"; exit 0; fi
	@tail -F $(LOGS_DIR)/*.log

# ---------- web ----------

.PHONY: web-dev
web-dev:
	@echo "==> vite dev (Path A) — http://localhost:5173"
	@cd $(WEB_PATH) && npm run dev

# ---------- production operations ----------
# Phases: T3-P2..T5-P3 + BAU + DR + go-live.
# See docs/operationalization/execution-plans.md for phase IDs.

.PHONY: bootstrap-cluster smoke-prod infra-health dr-drill deploy-validate-pre deploy-validate-post rollback

bootstrap-cluster:
	@./scripts/bootstrap-cluster.sh $${CLUSTER:-apex-ews-prod}

smoke-prod:
	@./scripts/smoke.sh

infra-health:
	@./scripts/infra-health.sh

dr-drill:
	@./scripts/dr-drill.sh --scope=$${SCOPE:-aurora} --target=$${TARGET:-staging} $${EXTRA_ARGS:-}

deploy-validate-pre:
	@DEPLOY_PHASE=pre ./scripts/deploy-validate.sh

deploy-validate-post:
	@DEPLOY_PHASE=post ./scripts/deploy-validate.sh

rollback:
	@./scripts/rollback.sh $${ROLLBACK_ARGS:-}

.PHONY: seed-secrets test-tenant-isolation
seed-secrets:
	@./scripts/seed-secrets.sh

test-tenant-isolation:
	@./scripts/test-tenant-isolation.sh
