-- seed_ews_rules.sql
--
-- Seed data for the 10 brief-mandated EWS rules (EWS-4).
-- Loaded into a tenant on first init (or via the SPA's first-tenant
-- onboarding wizard, which calls seedDefaultEwsRules()).
--
-- Row shape mirrors the EwsRule TypeScript interface verbatim.
-- ON CONFLICT DO NOTHING — re-running this seed is idempotent.

INSERT INTO app.ews_rules (
    rule_id, tenant_id, name, category, description,
    conditions, logic, action, is_active, state, version,
    tags, created_by
)
VALUES
    -- 1. RULE_CREDIT_001
    (
        'RULE_CREDIT_001', 'BIL',
        'High EMI Bounce Risk',
        'credit',
        '3 or more EMI bounces in the last 90 days indicates the customer can no longer service debt — escalate to RM within 24 hours.',
        '[{"field":"emi_bounce_count_90d","operator":">=","value":3}]'::jsonb,
        'AND',
        '{"alert_severity":"RED","weight":25,"recommended_action":"Pause further disbursement; assign to RM for 24-hour callback."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 2. RULE_LAPSE_001
    (
        'RULE_LAPSE_001', 'BIL',
        'Premium Overdue',
        'lapse',
        'Premium overdue beyond 15 days triggers grace-period outreach to prevent policy lapse.',
        '[{"field":"premium_overdue_days","operator":">","value":15}]'::jsonb,
        'AND',
        '{"alert_severity":"ORANGE","weight":20,"recommended_action":"Send grace-period reminder; agent to call customer within 48 hours."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 3. RULE_FRAUD_001
    (
        'RULE_FRAUD_001', 'BIL',
        'High-Claim Early-Policy Fraud Signal',
        'fraud',
        'Claim more than 3x the customer''s rolling-12-month average AND filed within 30 days of policy inception suggests claim-loading fraud.',
        '[{"field":"claim_to_avg_ratio","operator":">","value":3},{"field":"policy_age_days_at_claim","operator":"<","value":30}]'::jsonb,
        'AND',
        '{"alert_severity":"RED","weight":30,"recommended_action":"Hold payout; route to fraud investigations for documentary evidence review."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 4. RULE_KYC_001
    (
        'RULE_KYC_001', 'BIL',
        'KYC Document Expired',
        'kyc',
        'KYC document expired more than 30 days ago — operator must re-verify before any disbursement or payout.',
        '[{"field":"kyc_doc_expiry_days","operator":">","value":30}]'::jsonb,
        'AND',
        '{"alert_severity":"YELLOW","weight":10,"recommended_action":"Request fresh KYC docs; block transactions > 50k until re-verified."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 5. RULE_TXN_001
    (
        'RULE_TXN_001', 'BIL',
        'Transaction Spike',
        'transaction',
        'A single transaction more than 10x the customer''s 90-day rolling average is a known fraud / mule-account signal.',
        '[{"field":"txn_amount_to_avg_ratio","operator":">","value":10}]'::jsonb,
        'AND',
        '{"alert_severity":"ORANGE","weight":20,"recommended_action":"Step-up authentication; manual review by transaction monitoring team."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 6. RULE_AGENT_001
    (
        'RULE_AGENT_001', 'BIL',
        'Agent Portfolio Lapse Rate High',
        'agent',
        'Agent portfolio lapse rate exceeded 20% over the trailing 12 months — agent quality review required.',
        '[{"field":"agent_portfolio_lapse_pct","operator":">","value":20}]'::jsonb,
        'AND',
        '{"alert_severity":"RED","weight":25,"recommended_action":"Suspend new-business onboarding for the agent; supervisor review of book."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 7. RULE_OPS_001
    (
        'RULE_OPS_001', 'BIL',
        'Login From New Country',
        'ops',
        'First-ever login from a country the customer has never used before in the last 24 hours — possible account takeover.',
        '[{"field":"login_new_country_24h","operator":"==","value":1}]'::jsonb,
        'AND',
        '{"alert_severity":"YELLOW","weight":15,"recommended_action":"Force step-up auth on next login; SMS/email confirmation to customer."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 8. RULE_CONC_001
    (
        'RULE_CONC_001', 'BIL',
        'Customer Concentration Risk',
        'concentration',
        'Single customer accounts for more than 30% of the lender''s portfolio exposure — concentration limit breach.',
        '[{"field":"customer_exposure_pct_of_portfolio","operator":">","value":30}]'::jsonb,
        'AND',
        '{"alert_severity":"ORANGE","weight":20,"recommended_action":"No further disbursement to this customer; risk committee review of book mix."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 9. RULE_BEHAV_001
    (
        'RULE_BEHAV_001', 'BIL',
        'Sudden Transaction Frequency Drop',
        'behaviour',
        'Transaction frequency dropped 50% comparing the trailing 30 days vs the prior 30 days — possible attrition or distress.',
        '[{"field":"txn_freq_drop_30d_pct","operator":">=","value":50}]'::jsonb,
        'AND',
        '{"alert_severity":"ORANGE","weight":20,"recommended_action":"Outbound retention call; check for service complaints; product upsell or churn risk."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    ),
    -- 10. RULE_SCORE_001
    (
        'RULE_SCORE_001', 'BIL',
        'Risk Score Sudden Increase',
        'score',
        'Internal BIL risk score increased by 30+ points in the last 7 days — material deterioration in customer health.',
        '[{"field":"risk_score_delta_7d","operator":">=","value":30}]'::jsonb,
        'AND',
        '{"alert_severity":"RED","weight":25,"recommended_action":"Immediate RM review; consider down-grading credit limit; queue for collections."}'::jsonb,
        FALSE, 'draft', 1, '{}', 'system'
    )
ON CONFLICT (tenant_id, rule_id) DO NOTHING;
