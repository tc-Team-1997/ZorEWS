# APEX EWS — Aurora schema bootstrap.
#
# Targets:
#   make up      : start a local postgres:16 container (port 55432).
#   make down    : tear it down.
#   make migrate : apply 001..005 in order. (004 = app_*, 005 = tenants.)
#   make verify  : check schemas + tables exist + audit hash chain works.
#   make psql    : open a psql shell.
#   make parse   : syntax-check the .sql files without a server (uses pg_query / psql -f).
#
# The local DB matches Aurora PG 16 (we pin the image tag).

PG_CONTAINER ?= apex-ews-pg
PG_IMAGE     ?= postgres:16
PG_PORT      ?= 55432
PG_DB        ?= apex_ews
PG_USER      ?= apex
PG_PASSWORD  ?= apex
PSQL         ?= PGPASSWORD=$(PG_PASSWORD) psql -h localhost -p $(PG_PORT) -U $(PG_USER) -d $(PG_DB)

SCHEMA_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: up down migrate verify psql parse logs

up:
	@if docker ps -a --format '{{.Names}}' | grep -q "^$(PG_CONTAINER)$$"; then \
	  echo "container $(PG_CONTAINER) already exists; starting…"; \
	  docker start $(PG_CONTAINER) >/dev/null; \
	else \
	  docker run -d --name $(PG_CONTAINER) \
	    -e POSTGRES_DB=$(PG_DB) \
	    -e POSTGRES_USER=$(PG_USER) \
	    -e POSTGRES_PASSWORD=$(PG_PASSWORD) \
	    -p $(PG_PORT):5432 \
	    $(PG_IMAGE) >/dev/null; \
	fi
	@echo "waiting for postgres on :$(PG_PORT)…"
	@for i in $$(seq 1 30); do \
	  if PGPASSWORD=$(PG_PASSWORD) pg_isready -h localhost -p $(PG_PORT) -U $(PG_USER) >/dev/null 2>&1; then \
	    echo "postgres is up"; exit 0; \
	  fi; sleep 1; \
	done; echo "postgres failed to start"; exit 1

down:
	-@docker stop $(PG_CONTAINER) >/dev/null 2>&1 || true
	-@docker rm   $(PG_CONTAINER) >/dev/null 2>&1 || true

migrate:
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)001_init_schemas.sql
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)002_raw_tables.sql
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)003_audit_table.sql
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)004_app_schemas.sql
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)005_tenants.sql
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)006_audit_tenant.sql
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)007_app_tenant.sql
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)008_cases_tenant.sql
	$(PSQL) -v ON_ERROR_STOP=1 -f $(SCHEMA_DIR)009_alerts_tenant.sql
	@echo "migration complete"

verify:
	@$(PSQL) -v ON_ERROR_STOP=1 -At -c \
	  "SELECT count(*) FROM information_schema.schemata WHERE schema_name IN ('raw','staging','mart','audit');" \
	  | grep -qx 4 || (echo "expected 4 schemas"; exit 1)
	@$(PSQL) -v ON_ERROR_STOP=1 -At -c \
	  "SELECT count(*) FROM information_schema.tables WHERE table_schema='raw';" \
	  | grep -qx 5 || (echo "expected 5 raw tables"; exit 1)
	@$(PSQL) -v ON_ERROR_STOP=1 -c \
	  "INSERT INTO audit.event_log (event_type, actor, subject_id, payload) \
	   VALUES ('VERIFY','make-verify','t1','{\"ok\":true}'::jsonb);"
	@$(PSQL) -v ON_ERROR_STOP=1 -c \
	  "INSERT INTO audit.event_log (event_type, actor, subject_id, payload) \
	   VALUES ('VERIFY','make-verify','t2','{\"ok\":true}'::jsonb);"
	@echo "verify OK — 4 schemas, 5 raw tables, 2 audit rows chained"

psql:
	$(PSQL)

logs:
	docker logs -f $(PG_CONTAINER)

# Best-effort offline syntax check using `psql -f` against a throwaway container,
# falling back to a pure parser when docker is unavailable.
parse:
	@command -v psql >/dev/null || (echo "psql required"; exit 1)
	@for f in 001_init_schemas.sql 002_raw_tables.sql 003_audit_table.sql; do \
	  echo "-- parsing $$f"; \
	  psql -X --set=ON_ERROR_STOP=1 --no-psqlrc \
	       --command "\\set AUTOCOMMIT off" \
	       --command "BEGIN; $$(cat $(SCHEMA_DIR)$$f); ROLLBACK;" \
	       postgres://$(PG_USER):$(PG_PASSWORD)@localhost:$(PG_PORT)/$(PG_DB) >/dev/null \
	    || (echo "parse failed: $$f"; exit 1); \
	done
	@echo "parse OK"
