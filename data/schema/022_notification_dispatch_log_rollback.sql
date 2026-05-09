-- 022_notification_dispatch_log_rollback.sql
--
-- Rollback for 022_notification_dispatch_log.sql.
--
-- Drops the table + triggers + the trigger function. Idempotent.
-- Lossy by design — every dispatched-notification audit row is wiped.

BEGIN;

DROP TRIGGER IF EXISTS trg_notification_dispatch_log_block_update
    ON app_admin.notification_dispatch_log;
DROP TRIGGER IF EXISTS trg_notification_dispatch_log_block_delete
    ON app_admin.notification_dispatch_log;
DROP FUNCTION IF EXISTS app_admin.notification_dispatch_log_block_mutate();

DROP TABLE IF EXISTS app_admin.notification_dispatch_log;

COMMIT;
