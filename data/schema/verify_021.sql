-- verify_021.sql
--
-- Post-migration verification queries for 021_case_scenarios_and_admin_extensions.
--
-- Run with:
--   PGPASSWORD=apex psql -h localhost -p 55432 -U zorews_user -d zorews \
--     -f data/schema/verify_021.sql
--
-- Each section prints either a row count or a structural fact. Visual
-- inspection: the four tables exist, the seed counts match, the
-- append-only trigger blocks UPDATE on case_scenario_history, and the
-- widened admin_audit_log CHECK accepts the new entity_types.

\echo
\echo '── 1. The 4 new tables exist ─────────────────────────────────────'
SELECT table_name
FROM   information_schema.tables
WHERE  table_schema = 'app_admin'
  AND  table_name IN (
        'case_scenarios',
        'case_scenario_history',
        'notification_templates',
        'escalation_matrix'
       )
ORDER  BY table_name;

\echo
\echo '── 2. Row counts (expect 5 templates, 5 escalation rules, 2 scenarios from inline seed) ──'
SELECT 'notification_templates' AS tbl, count(*) AS rows FROM app_admin.notification_templates
UNION ALL
SELECT 'escalation_matrix',         count(*)               FROM app_admin.escalation_matrix
UNION ALL
SELECT 'case_scenarios',            count(*)               FROM app_admin.case_scenarios
UNION ALL
SELECT 'case_scenario_history',     count(*)               FROM app_admin.case_scenario_history;

\echo
\echo '── 3. Per-tenant seed distribution ───────────────────────────────'
SELECT tenant_id, channel, count(*)
FROM   app_admin.notification_templates
GROUP  BY tenant_id, channel
ORDER  BY tenant_id, channel;

SELECT tenant_id, case_category, priority, count(*)
FROM   app_admin.escalation_matrix
GROUP  BY tenant_id, case_category, priority
ORDER  BY tenant_id, case_category, priority;

SELECT tenant_id, case_category, priority, count(*)
FROM   app_admin.case_scenarios
WHERE  deleted_at IS NULL
GROUP  BY tenant_id, case_category, priority
ORDER  BY tenant_id, case_category, priority;

\echo
\echo '── 4. admin_audit_log_entity_check now accepts the new entity types ──'
SELECT pg_get_constraintdef(c.oid)
FROM   pg_constraint c
JOIN   pg_class t ON t.oid = c.conrelid
JOIN   pg_namespace n ON n.oid = t.relnamespace
WHERE  n.nspname = 'app_admin'
  AND  t.relname = 'admin_audit_log'
  AND  c.conname = 'admin_audit_log_entity_check';

\echo
\echo '── 5. admin_audit_log_action_check includes activate/archive/restore ──'
SELECT pg_get_constraintdef(c.oid)
FROM   pg_constraint c
JOIN   pg_class t ON t.oid = c.conrelid
JOIN   pg_namespace n ON n.oid = t.relnamespace
WHERE  n.nspname = 'app_admin'
  AND  t.relname = 'admin_audit_log'
  AND  c.conname = 'admin_audit_log_action_check';

\echo
\echo '── 6. Append-only trigger blocks UPDATE on case_scenario_history ──'
\echo '── (expect: ERROR raised by trigger, then ROLLBACK)              ──'
BEGIN;
DO $$
DECLARE
  s_id UUID;
  hid  BIGINT;
BEGIN
  -- Need a real scenario_id for the FK; reuse the first seeded one if any.
  SELECT scenario_id INTO s_id FROM app_admin.case_scenarios LIMIT 1;
  IF s_id IS NULL THEN
    -- Fallback: skip the test if no scenarios seeded.
    RAISE NOTICE 'no scenarios — skipping append-only verify';
    RETURN;
  END IF;

  INSERT INTO app_admin.case_scenario_history
    (scenario_id, tenant_id, action, diff, after_state, performed_by)
  VALUES
    (s_id, 'BANK_DEMO', 'create', '[]'::jsonb, '{}'::jsonb, 'system:verify')
  RETURNING history_id INTO hid;

  BEGIN
    UPDATE app_admin.case_scenario_history
       SET action = 'update'
     WHERE history_id = hid;
    RAISE EXCEPTION 'BUG: UPDATE on append-only table succeeded';
  EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'OK — UPDATE blocked by append-only trigger';
  END;

  BEGIN
    DELETE FROM app_admin.case_scenario_history WHERE history_id = hid;
    RAISE EXCEPTION 'BUG: DELETE on append-only table succeeded';
  EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'OK — DELETE blocked by append-only trigger';
  END;
END;
$$;
ROLLBACK;

\echo
\echo '── 7. FK ON DELETE policies are RESTRICT for cross-feature, CASCADE for owned ──'
SELECT conrelid::regclass        AS table,
       conname                   AS constraint,
       pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  conrelid::regclass::text IN (
         'app_admin.case_scenarios',
         'app_admin.case_scenario_history'
       )
  AND  contype = 'f'
ORDER  BY conrelid::regclass, conname;

\echo
\echo '── 8. Indexes present ────────────────────────────────────────────'
SELECT schemaname || '.' || tablename AS table, indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'app_admin'
  AND  tablename IN (
         'case_scenarios','case_scenario_history',
         'notification_templates','escalation_matrix'
       )
ORDER  BY tablename, indexname;

\echo
\echo '── verify_021 complete ──'
