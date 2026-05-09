-- seed_021_admin_defaults.sql
--
-- Re-runnable seed for the 021 tables, beyond what the inline seeds in
-- 021_case_scenarios_and_admin_extensions.sql already cover. Useful when
-- the prototype DB has been wiped + re-migrated and you want a richer
-- catalogue for SPA demos.
--
-- All inserts use ON CONFLICT DO NOTHING so re-running is a no-op.
-- Composite uniques (tenant_id, lower(name) [, locale]) drive the
-- conflict resolution.
--
-- Tenants: BANK_DEMO + BIL.

BEGIN;

-- ─── Notification templates — 6 extra ─────────────────────────────────

INSERT INTO app_admin.notification_templates
    (tenant_id, name, channel, subject, body, locale, status, created_by)
VALUES
    -- Bank
    ('BANK_DEMO', 'Case Closed — RM email',     'EMAIL',
     'Case {{case_number}} closed: {{resolution_category}}',
     'Hi {{rm_name}},\n\nCase {{case_number}} for {{customer_name}} has been closed.\nResolution: {{resolution_category}}\nNotes: {{resolution_notes}}\n\nThank you,\nZorEWS',
     'en-IN', 'ACTIVE', 'system:seed'),
    ('BANK_DEMO', 'Customer KYC reminder — SMS', 'SMS', NULL,
     'ZorEWS: Hi {{customer_name}}, please update your KYC at your nearest branch by {{kyc_due_date}} to avoid service disruption.',
     'en-IN', 'ACTIVE', 'system:seed'),
    ('BANK_DEMO', 'Escalation L2 — Risk Analyst in-app', 'IN_APP',
     'Case {{case_number}} escalated — Level 2',
     'Case {{case_number}} ({{priority}} {{case_category}}) was not actioned at level 1 and has now escalated to you. Please review urgently.',
     'en-IN', 'ACTIVE', 'system:seed'),
    -- BIL
    ('BIL', 'Claim approval — Customer email',  'EMAIL',
     'Claim {{claim_number}} approved',
     'Dear {{customer_name}},\n\nWe are pleased to inform you that your claim {{claim_number}} for policy {{policy_number}} has been approved.\nAmount payable: {{paid_amount_kes}} KES\nExpected credit: T+2 working days.\n\nRegards,\nBIL Claims',
     'en-IN', 'ACTIVE', 'system:seed'),
    ('BIL', 'Claim follow-up — Underwriter SMS', 'SMS', NULL,
     'ZorEWS: Claim {{claim_number}} pending docs since {{pending_since_days}}d. Contact UW desk.',
     'en-IN', 'ACTIVE', 'system:seed'),
    ('BIL', 'Escalation L3 — Admin in-app',     'IN_APP',
     'Case {{case_number}} escalated to admin',
     'Case {{case_number}} ({{priority}} {{case_category}}) reached escalation level 3 — admin attention required.',
     'en-IN', 'ACTIVE', 'system:seed')
ON CONFLICT DO NOTHING;

-- ─── Escalation matrix — 4 extra ──────────────────────────────────────

INSERT INTO app_admin.escalation_matrix
    (tenant_id, name, case_category, priority,
     level_1_after_minutes, level_1_role,
     level_2_after_minutes, level_2_role,
     level_3_after_minutes, level_3_role,
     status, created_by)
VALUES
    -- Bank: Compliance P1 — straight to admin
    ('BANK_DEMO', 'BANK Compliance P1 fast',   'compliance', 'P1',
     30,   'risk_analyst',
     120,  'admin',
     NULL, NULL,
     'ACTIVE', 'system:seed'),
    -- Bank: Default fallback for anything not category-specific
    ('BANK_DEMO', 'BANK Default P3 fallback',  'default_fallback', 'P3',
     1440, 'supervisor',
     NULL, NULL,
     NULL, NULL,
     'ACTIVE', 'system:seed'),
    -- BIL: Compliance P2 (IRDAI cycle)
    ('BIL', 'BIL Compliance P2 standard',      'compliance', 'P2',
     180,  'supervisor',
     720,  'risk_analyst',
     NULL, NULL,
     'ACTIVE', 'system:seed'),
    -- BIL: Default fallback
    ('BIL', 'BIL Default P3 fallback',         'default_fallback', 'P3',
     1440, 'supervisor',
     NULL, NULL,
     NULL, NULL,
     'ACTIVE', 'system:seed')
ON CONFLICT DO NOTHING;

-- ─── Case scenarios — 2 extra (tied to seeded matrix + templates) ────

INSERT INTO app_admin.case_scenarios
    (tenant_id, name, case_category, priority,
     trigger_indicator_id, trigger_threshold,
     default_escalation_id, notification_template_id,
     checklist, status, created_by)
SELECT
    'BANK_DEMO', 'KYC document expired → P3',  'kyc', 'P3',
    'KYC-001', 1.0,
    em.escalation_id, nt.template_id,
    '[
      {"title":"SMS customer with KYC reminder","required":true},
      {"title":"Block new account openings if expired > 90d","required":false},
      {"title":"Schedule branch visit","required":false}
     ]'::jsonb,
    'ACTIVE', 'system:seed'
FROM app_admin.escalation_matrix em
JOIN app_admin.notification_templates nt ON nt.tenant_id = em.tenant_id
WHERE em.tenant_id = 'BANK_DEMO'
  AND em.name = 'BANK KYC P3 reminder'
  AND nt.name = 'Customer KYC reminder — SMS'
ON CONFLICT DO NOTHING;

INSERT INTO app_admin.case_scenarios
    (tenant_id, name, case_category, priority,
     trigger_indicator_id, trigger_threshold,
     default_escalation_id, notification_template_id,
     checklist, status, created_by)
SELECT
    'BIL', 'Claim suspicious pattern → fraud P1', 'fraud', 'P1',
    'FRD-003', 0.9,
    em.escalation_id, nt.template_id,
    '[
      {"title":"Pull last 12 months claim history","required":true},
      {"title":"Cross-check provider against AML watchlist","required":true},
      {"title":"Hold payout until investigation completes","required":true}
     ]'::jsonb,
    'ACTIVE', 'system:seed'
FROM app_admin.escalation_matrix em
JOIN app_admin.notification_templates nt ON nt.tenant_id = em.tenant_id
WHERE em.tenant_id = 'BIL'
  AND em.name = 'BIL Claim Fraud P1'
  AND nt.name = 'Claim follow-up — Underwriter SMS'
ON CONFLICT DO NOTHING;

COMMIT;
