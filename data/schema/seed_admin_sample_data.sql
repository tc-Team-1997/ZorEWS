-- ============================================================================
-- seed_admin_sample_data.sql
--
-- Idempotent sample data for the 4 M14 admin tables so the SPA renders
-- meaningful content out-of-the-box when the BFF is wired to Postgres:
--
--   app_admin.notification_templates       (Notification Templates page)
--   app_admin.escalation_matrix            (Escalation Matrix page)
--   app_admin.case_scenarios               (Case Scenarios page)
--   app_admin.notification_dispatch_log    (Notification Dispatches page)
--
-- The Escalation Worker page has no table of its own — it's a runtime cron
-- that reads from the three tables above and writes to the dispatch log.
-- Its admin page renders live state, not stored rows.
--
-- Apply:
--   docker exec -i apex-ews-pg psql -U apex -d apex_ews \
--     -v ON_ERROR_STOP=1 -f /tmp/seed_admin_sample_data.sql
--
-- Idempotent: each INSERT uses ON CONFLICT DO NOTHING against the natural
-- unique constraint, so re-running the seed leaves existing rows alone.
--
-- All UUIDs are deterministic prefixes so the seeded rows are easy to spot
-- in the DB:
--   a0000000-0000-0000-0000-00000000xxxx → notification_templates
--   b0000000-0000-0000-0000-00000000xxxx → escalation_matrix
--   c0000000-0000-0000-0000-00000000xxxx → case_scenarios
--   d0000000-0000-0000-0000-00000000xxxx → notification_dispatch_log
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Notification Templates (8 rows: 5 BANK_DEMO + 3 BIL)
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO app_admin.notification_templates
  (template_id, tenant_id, name, channel, subject, body, locale, status, created_by, updated_by, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'BANK_DEMO',
   'Sample · Loan disbursement — Customer email', 'EMAIL',
   'Loan {{loan_id}} disbursement confirmed',
   E'Hi {{customer_name}},\n\nYour loan {{loan_id}} for {{amount}} has been disbursed to account {{account_number}}.\nFirst EMI date: {{emi_start_date}}.\n\n— ZorEWS',
   'en-IN', 'ACTIVE', 'system:sample-seed', NULL, now() - interval '2 days', now() - interval '2 days'),
  ('a0000000-0000-0000-0000-000000000002'::uuid, 'BANK_DEMO',
   'Sample · Repayment overdue — Customer SMS', 'SMS', NULL,
   'Bank: Hi {{customer_name}}, EMI of {{amount}} for loan {{loan_id}} is overdue. Pay by {{due_date}} to avoid late fee.',
   'en-IN', 'ACTIVE', 'system:sample-seed', NULL, now() - interval '2 days', now() - interval '2 days'),
  ('a0000000-0000-0000-0000-000000000003'::uuid, 'BANK_DEMO',
   'Sample · Compliance review — Audit team email', 'EMAIL',
   'Compliance review pending — Case {{case_id}}',
   E'Audit Team,\n\nCase {{case_id}} for customer {{customer_name}} requires compliance review.\nFlag: {{flag_reason}}\nDue: {{review_deadline}}.\n\n— ZorEWS',
   'en-IN', 'DRAFT', 'system:sample-seed', NULL, now() - interval '1 day', now() - interval '1 day'),
  ('a0000000-0000-0000-0000-000000000004'::uuid, 'BANK_DEMO',
   'Sample · Fraud alert — Customer SMS', 'SMS', NULL,
   'Bank ALERT: Unusual activity on account {{account_number}} at {{merchant}}. Reply YES if genuine, NO to block. Helpline: 1800-XXX.',
   'en-IN', 'ACTIVE', 'system:sample-seed', NULL, now() - interval '3 days', now() - interval '3 days'),
  ('a0000000-0000-0000-0000-000000000005'::uuid, 'BANK_DEMO',
   'Sample · Escalation L2 — Risk team in-app', 'IN_APP',
   'L2 escalation: Case {{case_number}} requires risk review',
   'Case {{case_number}} ({{priority}} {{case_category}}) was not actioned at L1. Risk team review required within {{after_minutes}} minutes.',
   'en-IN', 'ACTIVE', 'system:sample-seed', NULL, now() - interval '5 days', now() - interval '5 days'),
  ('a0000000-0000-0000-0000-000000000006'::uuid, 'BIL',
   'Sample · Surrender request — Underwriter in-app', 'IN_APP',
   'Surrender request received — Policy {{policy_number}}',
   E'{{customer_name}} submitted a surrender request for policy {{policy_number}}.\nSurrender value: {{surrender_value}}\nReason: {{surrender_reason}}.',
   'en-IN', 'ACTIVE', 'system:sample-seed', NULL, now() - interval '2 days', now() - interval '2 days'),
  ('a0000000-0000-0000-0000-000000000007'::uuid, 'BIL',
   'Sample · Investigation summary — Risk team email', 'EMAIL',
   'Investigation summary — Case {{case_number}}',
   E'Risk Team,\n\nInvestigation on case {{case_number}} (policy {{policy_number}}) is complete.\nOutcome: {{outcome}}\nNext step: {{next_step}}.\n\n— ZorEWS Investigations',
   'en-IN', 'ACTIVE', 'system:sample-seed', NULL, now() - interval '4 days', now() - interval '4 days'),
  ('a0000000-0000-0000-0000-000000000008'::uuid, 'BIL',
   'Sample · Settlement delayed — Customer SMS', 'SMS', NULL,
   'BIL: Hi {{customer_name}}, claim {{claim_number}} settlement is delayed by {{delay_days}} days due to {{delay_reason}}. We apologise for the inconvenience.',
   'en-IN', 'ACTIVE', 'system:sample-seed', NULL, now() - interval '1 day', now() - interval '1 day')
ON CONFLICT (tenant_id, lower(name), locale) WHERE deleted_at IS NULL DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Escalation Matrix (5 rows: 3 BANK_DEMO + 2 BIL)
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO app_admin.escalation_matrix
  (escalation_id, tenant_id, name, case_category, priority,
   level_1_after_minutes, level_1_role,
   level_2_after_minutes, level_2_role,
   level_3_after_minutes, level_3_role,
   status, created_by, updated_by, created_at, updated_at)
VALUES
  ('b0000000-0000-0000-0000-000000000001'::uuid, 'BANK_DEMO',
   'Sample · BANK Recovery P2 standard', 'recovery', 'P2',
   120, 'collection_officer', 480, 'supervisor', 1440, 'admin',
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '7 days', now() - interval '7 days'),
  ('b0000000-0000-0000-0000-000000000002'::uuid, 'BANK_DEMO',
   'Sample · BANK Repayment P3 reminder', 'repayment', 'P3',
   360, 'collection_officer', 1440, 'supervisor', NULL, NULL,
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '7 days', now() - interval '7 days'),
  ('b0000000-0000-0000-0000-000000000003'::uuid, 'BANK_DEMO',
   'Sample · BANK Field-Visit P2', 'field_visit', 'P2',
   240, 'field_officer', 720, 'supervisor', NULL, NULL,
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '6 days', now() - interval '6 days'),
  ('b0000000-0000-0000-0000-000000000004'::uuid, 'BIL',
   'Sample · BIL Surrender P2 escalation', 'surrender', 'P2',
   180, 'supervisor', 720, 'risk_analyst', 1440, 'admin',
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '5 days', now() - interval '5 days'),
  ('b0000000-0000-0000-0000-000000000005'::uuid, 'BIL',
   'Sample · BIL Renewal P3 reminder', 'renewal', 'P3',
   720, 'collection_officer', 1440, 'supervisor', NULL, NULL,
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '5 days', now() - interval '5 days')
ON CONFLICT (tenant_id, lower(name)) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Case Scenarios (4 rows: 2 BANK_DEMO + 2 BIL)
-- Each links to one of the new escalation rules + one of the new templates.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO app_admin.case_scenarios
  (scenario_id, tenant_id, name, case_category, priority,
   trigger_indicator_id, trigger_threshold,
   default_escalation_id, notification_template_id,
   checklist, status, created_by, updated_by, created_at, updated_at)
VALUES
  ('c0000000-0000-0000-0000-000000000001'::uuid, 'BANK_DEMO',
   'Sample · Recovery P2 — 90+ DPD allocation', 'recovery', 'P2',
   'COLL-DPD90', 90,
   'b0000000-0000-0000-0000-000000000001'::uuid,
   'a0000000-0000-0000-0000-000000000002'::uuid,
   '[{"title":"Allocate to recovery agent within 24h","required":true},{"title":"Issue legal-notice draft","required":true},{"title":"Document settlement-offer terms","required":false}]'::jsonb,
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '6 days', now() - interval '6 days'),
  ('c0000000-0000-0000-0000-000000000002'::uuid, 'BANK_DEMO',
   'Sample · Repayment P3 — 30 DPD reminder', 'repayment', 'P3',
   'COLL-DPD30', 30,
   'b0000000-0000-0000-0000-000000000002'::uuid,
   'a0000000-0000-0000-0000-000000000002'::uuid,
   '[{"title":"Send SMS reminder","required":true},{"title":"Schedule 7-day follow-up","required":true}]'::jsonb,
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '6 days', now() - interval '6 days'),
  ('c0000000-0000-0000-0000-000000000003'::uuid, 'BIL',
   'Sample · Surrender P2 — Customer-initiated', 'surrender', 'P2',
   'BIL-SUR-REQ', 1,
   'b0000000-0000-0000-0000-000000000004'::uuid,
   'a0000000-0000-0000-0000-000000000006'::uuid,
   '[{"title":"Acknowledge request within 24h","required":true},{"title":"Compute surrender value","required":true},{"title":"Schedule customer call for retention offer","required":false},{"title":"Notify originating agent","required":true}]'::jsonb,
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '4 days', now() - interval '4 days'),
  ('c0000000-0000-0000-0000-000000000004'::uuid, 'BIL',
   'Sample · Renewal P3 — 30 days before due', 'renewal', 'P3',
   'BIL-RNW-30D', 30,
   'b0000000-0000-0000-0000-000000000005'::uuid,
   NULL,
   '[{"title":"Email customer with renewal premium","required":true},{"title":"Assign to retention agent","required":false}]'::jsonb,
   'ACTIVE', 'system:sample-seed', NULL, now() - interval '4 days', now() - interval '4 days')
ON CONFLICT (tenant_id, lower(name)) WHERE deleted_at IS NULL DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Notification Dispatch Log (20 rows, both tenants, 3 statuses, 3 triggers)
-- Timestamps staggered 30m → 33h ago so newest-first ordering looks like a
-- real ops feed. Each row references one of the new templates by UUID.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO app_admin.notification_dispatch_log
  (dispatch_id, tenant_id, template_id, template_name, channel, recipient,
   trigger, reference, rendered_subject, rendered_body, missing_vars,
   status, status_reason, performed_by, performed_at)
VALUES
  -- BANK_DEMO — escalation_worker
  ('d0000000-0000-0000-0000-000000000001'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000005'::uuid,
   'Sample · Escalation L2 — Risk team in-app',
   'IN_APP', 'role:risk_analyst', 'escalation_worker', 'case:c-001:lvl:2',
   'L2 escalation: Case c-001 requires risk review',
   'Case c-001 (P1 fraud) was not actioned at L1. Risk team review required within 60 minutes.',
   '[]'::jsonb, 'sent', NULL, 'system:escalation-worker', now() - interval '30 minutes'),
  ('d0000000-0000-0000-0000-000000000002'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000005'::uuid,
   'Sample · Escalation L2 — Risk team in-app',
   'IN_APP', 'role:risk_analyst', 'escalation_worker', 'case:c-014:lvl:1',
   'L2 escalation: Case c-014 requires risk review',
   'Case c-014 (P2 credit_risk) was not actioned at L1. Risk team review required within 240 minutes.',
   '[]'::jsonb, 'sent', NULL, 'system:escalation-worker', now() - interval '1 hour 12 minutes'),
  ('d0000000-0000-0000-0000-000000000003'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000002'::uuid,
   'Sample · Repayment overdue — Customer SMS',
   'SMS', '+91-98765-43210', 'escalation_worker', 'case:c-007:lvl:1',
   NULL, 'Bank: Hi Sharma Holdings, EMI of 12500 for loan LN-2014 is overdue. Pay by 2026-05-18 to avoid late fee.',
   '[]'::jsonb, 'sent', NULL, 'system:escalation-worker', now() - interval '2 hours'),
  -- BANK_DEMO — case_create_pipeline
  ('d0000000-0000-0000-0000-000000000004'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000001'::uuid,
   'Sample · Loan disbursement — Customer email',
   'EMAIL', 'ravi.rm@bankdemo.test', 'case_create_pipeline', 'case:c-023',
   'Loan LN-2023 disbursement confirmed',
   E'Hi ABC Traders Pvt Ltd,\n\nYour loan LN-2023 for 1500000 has been disbursed to account 9012345678.\nFirst EMI date: 2026-06-15.\n\n— ZorEWS',
   '[]'::jsonb, 'sent', NULL, 'system:case-pipeline', now() - interval '3 hours 30 minutes'),
  ('d0000000-0000-0000-0000-000000000005'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000002'::uuid,
   'Sample · Repayment overdue — Customer SMS',
   'SMS', '+91-99887-65432', 'case_create_pipeline', 'case:c-024',
   NULL, 'Bank: Hi Mehta Industries, EMI of 28500 for loan LN-2024 is overdue. Pay by 2026-05-20 to avoid late fee.',
   '[]'::jsonb, 'sent', NULL, 'system:case-pipeline', now() - interval '4 hours 48 minutes'),
  -- BANK_DEMO — admin_test_fire
  ('d0000000-0000-0000-0000-000000000006'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000004'::uuid,
   'Sample · Fraud alert — Customer SMS',
   'SMS', '+91-92020-11122', 'admin_test_fire', NULL,
   NULL, 'Bank ALERT: Unusual activity on account 7711223344 at MERCHANT_TEST. Reply YES if genuine, NO to block. Helpline: 1800-XXX.',
   '[]'::jsonb, 'sent', NULL, 'alice.admin', now() - interval '6 hours'),
  ('d0000000-0000-0000-0000-000000000007'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000003'::uuid,
   'Sample · Compliance review — Audit team email',
   'EMAIL', 'audit-team@bankdemo.test', 'admin_test_fire', NULL,
   'Compliance review pending — Case CMS-COMP-001',
   E'Audit Team,\n\nCase CMS-COMP-001 for customer TEST_VENDOR_PTE requires compliance review.\nFlag: PEP_MATCH_88%\nDue: 2026-05-18.\n\n— ZorEWS',
   '[]'::jsonb, 'sent', NULL, 'sue.super', now() - interval '8 hours 30 minutes'),
  -- BANK_DEMO — failed (SMS gateway rejected)
  ('d0000000-0000-0000-0000-000000000008'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000002'::uuid,
   'Sample · Repayment overdue — Customer SMS',
   'SMS', '+91-INVALID', 'escalation_worker', 'case:c-019:lvl:2',
   NULL, 'Bank: Hi Test Customer, EMI of 8200 for loan LN-2019 is overdue. Pay by 2026-05-17 to avoid late fee.',
   '[]'::jsonb, 'failed', 'SMS gateway rejected: invalid phone number format',
   'system:escalation-worker', now() - interval '10 hours'),
  -- BANK_DEMO — preview (no real send, just a render check)
  ('d0000000-0000-0000-0000-000000000009'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000004'::uuid,
   'Sample · Fraud alert — Customer SMS',
   'SMS', '+91-PREVIEW', 'admin_test_fire', NULL,
   NULL, 'Bank ALERT: Unusual activity on account {{account_number}} at {{merchant}}. Reply YES if genuine, NO to block. Helpline: 1800-XXX.',
   '["account_number","merchant"]'::jsonb, 'preview', NULL,
   'alice.admin', now() - interval '12 hours 18 minutes'),
  ('d0000000-0000-0000-0000-000000000010'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000001'::uuid,
   'Sample · Loan disbursement — Customer email',
   'EMAIL', 'rm-test@bankdemo.test', 'admin_test_fire', NULL,
   'Loan LN-TEST disbursement confirmed',
   E'Hi TEST_CUSTOMER,\n\nYour loan LN-TEST for 500000 has been disbursed to account 1234567890.\nFirst EMI date: 2026-07-01.\n\n— ZorEWS',
   '[]'::jsonb, 'sent', NULL, 'alice.admin', now() - interval '15 hours'),
  -- BIL — escalation_worker
  ('d0000000-0000-0000-0000-000000000011'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000008'::uuid,
   'Sample · Settlement delayed — Customer SMS',
   'SMS', '+975-17-555-101', 'escalation_worker', 'case:c-BIL-008:lvl:1',
   NULL, 'BIL: Hi Tashi Wangmo, claim CLM-BIL-2008 settlement is delayed by 7 days due to additional verification. We apologise for the inconvenience.',
   '[]'::jsonb, 'sent', NULL, 'system:escalation-worker', now() - interval '48 minutes'),
  ('d0000000-0000-0000-0000-000000000012'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000007'::uuid,
   'Sample · Investigation summary — Risk team email',
   'EMAIL', 'risk-team@bil.test', 'escalation_worker', 'case:c-BIL-011:lvl:2',
   'Investigation summary — Case CLM-BIL-2011',
   E'Risk Team,\n\nInvestigation on case CLM-BIL-2011 (policy POL-BIL-9015) is complete.\nOutcome: confirmed_fraud\nNext step: deny claim + recover documentation.\n\n— ZorEWS Investigations',
   '[]'::jsonb, 'sent', NULL, 'system:escalation-worker', now() - interval '2 hours 42 minutes'),
  ('d0000000-0000-0000-0000-000000000013'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000006'::uuid,
   'Sample · Surrender request — Underwriter in-app',
   'IN_APP', 'role:supervisor', 'escalation_worker', 'case:c-BIL-022:lvl:1',
   'Surrender request received — Policy POL-BIL-9023',
   E'Karma Dorji submitted a surrender request for policy POL-BIL-9023.\nSurrender value: 380000\nReason: alternate investment.',
   '[]'::jsonb, 'sent', NULL, 'system:escalation-worker', now() - interval '4 hours 6 minutes'),
  -- BIL — case_create_pipeline
  ('d0000000-0000-0000-0000-000000000014'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000006'::uuid,
   'Sample · Surrender request — Underwriter in-app',
   'IN_APP', 'role:supervisor', 'case_create_pipeline', 'case:c-BIL-030',
   'Surrender request received — Policy POL-BIL-9042',
   E'Sonam Choden submitted a surrender request for policy POL-BIL-9042.\nSurrender value: 220000\nReason: financial hardship.',
   '[]'::jsonb, 'sent', NULL, 'system:case-pipeline', now() - interval '1 hour 48 minutes'),
  ('d0000000-0000-0000-0000-000000000015'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000008'::uuid,
   'Sample · Settlement delayed — Customer SMS',
   'SMS', '+975-17-555-088', 'case_create_pipeline', 'case:c-BIL-031',
   NULL, 'BIL: Hi Pema Lhamo, claim CLM-BIL-2031 settlement is delayed by 4 days due to bank holiday. We apologise for the inconvenience.',
   '[]'::jsonb, 'sent', NULL, 'system:case-pipeline', now() - interval '5 hours 24 minutes'),
  -- BIL — admin_test_fire
  ('d0000000-0000-0000-0000-000000000016'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000007'::uuid,
   'Sample · Investigation summary — Risk team email',
   'EMAIL', 'risk-test@bil.test', 'admin_test_fire', NULL,
   'Investigation summary — Case CLM-BIL-TEST',
   E'Risk Team,\n\nInvestigation on case CLM-BIL-TEST (policy POL-BIL-TEST) is complete.\nOutcome: cleared\nNext step: approve claim.\n\n— ZorEWS Investigations',
   '[]'::jsonb, 'sent', NULL, 'fiona.field', now() - interval '7 hours 12 minutes'),
  ('d0000000-0000-0000-0000-000000000017'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000008'::uuid,
   'Sample · Settlement delayed — Customer SMS',
   'SMS', '+975-17-PREVIEW', 'admin_test_fire', NULL,
   NULL, 'BIL: Hi {{customer_name}}, claim {{claim_number}} settlement is delayed by {{delay_days}} days due to {{delay_reason}}. We apologise for the inconvenience.',
   '["customer_name","claim_number","delay_days","delay_reason"]'::jsonb, 'preview', NULL,
   'fiona.field', now() - interval '9 hours'),
  -- BIL — failed (provider outage)
  ('d0000000-0000-0000-0000-000000000018'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000008'::uuid,
   'Sample · Settlement delayed — Customer SMS',
   'SMS', '+975-17-555-999', 'case_create_pipeline', 'case:p-BIL-099',
   NULL, 'BIL: Hi Dorji Tshering, claim CLM-BIL-2099 settlement is delayed by 14 days due to underwriting review. We apologise for the inconvenience.',
   '[]'::jsonb, 'failed', 'SMS provider returned 503 (gateway temporarily unavailable)',
   'system:case-pipeline', now() - interval '11 hours 30 minutes'),
  -- Older entries (>1 day ago) to fill the timeline
  ('d0000000-0000-0000-0000-000000000019'::uuid, 'BANK_DEMO',
   'a0000000-0000-0000-0000-000000000001'::uuid,
   'Sample · Loan disbursement — Customer email',
   'EMAIL', 'sneha.rm@bankdemo.test', 'case_create_pipeline', 'case:c-016',
   'Loan LN-2016 disbursement confirmed',
   E'Hi Sharma Holdings,\n\nYour loan LN-2016 for 850000 has been disbursed to account 8877665544.\nFirst EMI date: 2026-06-10.\n\n— ZorEWS',
   '[]'::jsonb, 'sent', NULL, 'system:case-pipeline', now() - interval '26 hours 30 minutes'),
  ('d0000000-0000-0000-0000-000000000020'::uuid, 'BIL',
   'a0000000-0000-0000-0000-000000000007'::uuid,
   'Sample · Investigation summary — Risk team email',
   'EMAIL', 'dorji@customer.test', 'admin_test_fire', NULL,
   'Investigation summary — Case CLM-BIL-1998',
   E'Risk Team,\n\nInvestigation on case CLM-BIL-1998 (policy POL-BIL-8722) is complete.\nOutcome: approved\nNext step: settle within T+2.\n\n— ZorEWS Investigations',
   '[]'::jsonb, 'sent', NULL, 'sue.super', now() - interval '32 hours 30 minutes')
ON CONFLICT (dispatch_id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- Verify row counts
-- ────────────────────────────────────────────────────────────────────────────
SELECT 'notification_templates'    AS table_name, count(*) FROM app_admin.notification_templates WHERE created_by = 'system:sample-seed'
UNION ALL
SELECT 'escalation_matrix',                       count(*) FROM app_admin.escalation_matrix     WHERE created_by = 'system:sample-seed'
UNION ALL
SELECT 'case_scenarios',                          count(*) FROM app_admin.case_scenarios        WHERE created_by = 'system:sample-seed'
UNION ALL
SELECT 'notification_dispatch_log',               count(*) FROM app_admin.notification_dispatch_log WHERE performed_by IN ('alice.admin','sue.super','fiona.field','system:escalation-worker','system:case-pipeline') AND template_id IN (
  'a0000000-0000-0000-0000-000000000001'::uuid,
  'a0000000-0000-0000-0000-000000000002'::uuid,
  'a0000000-0000-0000-0000-000000000003'::uuid,
  'a0000000-0000-0000-0000-000000000004'::uuid,
  'a0000000-0000-0000-0000-000000000005'::uuid,
  'a0000000-0000-0000-0000-000000000006'::uuid,
  'a0000000-0000-0000-0000-000000000007'::uuid,
  'a0000000-0000-0000-0000-000000000008'::uuid
);

COMMIT;
