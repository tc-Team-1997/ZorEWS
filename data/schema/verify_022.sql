-- verify_022.sql
--
-- Post-migration verification queries for
-- 022_notification_dispatch_log.
--
-- Run with:
--   PGPASSWORD=apex psql -h localhost -p 55432 -U zorews_user -d zorews \
--     -f data/schema/verify_022.sql

\echo
\echo '── 1. Table exists ───────────────────────────────────────────────'
SELECT table_name
FROM   information_schema.tables
WHERE  table_schema = 'app_admin'
  AND  table_name = 'notification_dispatch_log';

\echo
\echo '── 2. CHECK constraints registered ───────────────────────────────'
SELECT conname, pg_get_constraintdef(c.oid) AS def
FROM   pg_constraint c
JOIN   pg_class t ON t.oid = c.conrelid
JOIN   pg_namespace n ON n.oid = t.relnamespace
WHERE  n.nspname = 'app_admin'
  AND  t.relname = 'notification_dispatch_log'
  AND  c.contype = 'c'
ORDER  BY conname;

\echo
\echo '── 3. Indexes present ────────────────────────────────────────────'
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'app_admin'
  AND  tablename = 'notification_dispatch_log'
ORDER  BY indexname;

\echo
\echo '── 4. Append-only trigger blocks UPDATE + DELETE ─────────────────'
\echo '── (expect: NOTICE "OK — UPDATE/DELETE blocked")                ──'
BEGIN;
DO $$
DECLARE
  d_id UUID;
BEGIN
  INSERT INTO app_admin.notification_dispatch_log
    (tenant_id, template_id, template_name, channel, recipient,
     trigger, rendered_subject, rendered_body, missing_vars, status,
     performed_by)
  VALUES
    ('TEST_VERIFY_022', gen_random_uuid(), 'verify-tpl', 'EMAIL',
     'verify@example.com', 'admin_test_fire', 'verify subject',
     'verify body', '[]'::jsonb, 'sent', 'system:verify')
  RETURNING dispatch_id INTO d_id;

  BEGIN
    UPDATE app_admin.notification_dispatch_log
       SET status = 'failed' WHERE dispatch_id = d_id;
    RAISE EXCEPTION 'BUG: UPDATE on append-only table succeeded';
  EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'OK — UPDATE blocked by append-only trigger';
  END;

  BEGIN
    DELETE FROM app_admin.notification_dispatch_log WHERE dispatch_id = d_id;
    RAISE EXCEPTION 'BUG: DELETE on append-only table succeeded';
  EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'OK — DELETE blocked by append-only trigger';
  END;
END;
$$;
ROLLBACK;

\echo
\echo '── 5. SMS-no-subject CHECK enforced (defence in depth) ──────────'
\echo '── (expect: ERROR — check_violation)                           ──'
BEGIN;
DO $$
BEGIN
  BEGIN
    INSERT INTO app_admin.notification_dispatch_log
      (tenant_id, template_id, template_name, channel, recipient,
       trigger, rendered_subject, rendered_body, status, performed_by)
    VALUES
      ('TEST_VERIFY_022', gen_random_uuid(), 'bad-sms', 'SMS',
       'verify@example.com', 'admin_test_fire', 'should be null',
       'body', 'sent', 'system:verify');
    RAISE EXCEPTION 'BUG: SMS row with subject was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK — SMS row with subject blocked by CHECK';
  END;
END;
$$;
ROLLBACK;

\echo
\echo '── verify_022 complete ──'
