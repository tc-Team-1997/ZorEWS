import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Initialize i18n before any component renders. The import has a side
// effect (i18n.init) — we don't need the binding itself here.
import '@/lib/i18n';
import { LoginPage } from '@/modules/auth/LoginPage';
import { SignupPage } from '@/modules/auth/SignupPage';
import { OnboardingCountryPage } from '@/modules/onboarding/OnboardingCountryPage';
import { OnboardingDomainPage } from '@/modules/onboarding/OnboardingDomainPage';
import { OnboardingTenantPage } from '@/modules/onboarding/OnboardingTenantPage';
import { AdminUserCreatePage } from '@/modules/admin/AdminUserCreatePage';
// Enterprise IAM Center (additive — legacy /admin/users + /admin/sessions URLs untouched).
import { IamCenterPage } from '@/modules/admin/iam/IamCenterPage';
import { UserLifecyclePage } from '@/modules/admin/iam/UserLifecyclePage';
import { UserApprovalsInboxPage } from '@/modules/admin/iam/UserApprovalsInboxPage';
import { UserAccessReviewPage } from '@/modules/admin/iam/UserAccessReviewPage';
import { UserAuditHistoryPage } from '@/modules/admin/iam/UserAuditHistoryPage';
import { PasswordPolicyPage } from '@/modules/admin/iam/PasswordPolicyPage';
import { ForgotPasswordPage } from '@/modules/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/modules/auth/ResetPasswordPage';
import { FirstLoginWizardPage } from '@/modules/auth/FirstLoginWizardPage';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/layout/RequireAuth';
import { RequireOnboarding } from '@/components/layout/RequireOnboarding';
import { RequireDomain } from '@/components/layout/RequireDomain';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
// Role-Based Dashboard Engine — additive overlay (existing / dashboard untouched).
import { RoleBasedDashboardPage } from '@/modules/dashboard/roleEngine/RoleBasedDashboardPage';
// Executive Risk Cockpit — additive overlay (existing dashboards untouched).
import { ExecutiveCockpitPage } from '@/modules/executive/ExecutiveCockpitPage';
// Predictive Risk Center — additive overlay; transforms ZorEWS from monitoring → predictive intelligence.
import { PredictiveRiskCenterPage } from '@/modules/predictive/PredictiveRiskCenterPage';
// Investigation Center — enterprise investigation + case intelligence overlay (12th IA addition this session).
import { InvestigationCenterPage } from '@/modules/investigation/InvestigationCenterPage';
// Regulatory Compliance Center — enterprise regulatory + reporting overlay (13th IA addition this session).
import { RegulatoryComplianceCenterPage } from '@/modules/regulatory/RegulatoryComplianceCenterPage';
// Data Fabric Center — enterprise data fabric + integration hub (14th IA addition this session).
import { DataFabricCenterPage } from '@/modules/dataFabric/DataFabricCenterPage';
// Enterprise Demo Foundation — realistic banking + insurance demo data (15th IA addition this session).
import { EnterpriseDemoCenterPage } from '@/modules/enterpriseDemo/EnterpriseDemoCenterPage';
// Demo Readiness Center — UAT + release readiness validation (16th IA addition this session).
import { DemoReadinessCenterPage } from '@/modules/demoReadiness/DemoReadinessCenterPage';
// Digital Twin Risk Simulation Center — deterministic scenario engine (17th IA overlay).
import { DigitalTwinCenterPage } from '@/modules/digitalTwin/DigitalTwinCenterPage';
// Autonomous Risk Operations Center — AI agents overlay (18th IA overlay).
import { AutonomousRiskCenterPage } from '@/modules/autonomousRisk/AutonomousRiskCenterPage';
import { AlertListPage } from '@/modules/alerts/AlertListPage';
import { CustomerListPage } from '@/modules/customers/CustomerListPage';
import { CustomerRiskProfilePage } from '@/modules/customers/CustomerRiskProfilePage';
import { RuleConfigPage } from '@/modules/rules/RuleConfigPage';
import { RuleReportsPage } from '@/modules/rules/RuleReportsPage';
import { EwsRuleBuilderPage } from '@/modules/rules/EwsRuleBuilderPage';
import { EwsRuleWizardPage } from '@/modules/rules/EwsRuleWizardPage';
import { EwsRuleDiffPage } from '@/modules/rules/EwsRuleDiffPage';
import { RuleCenterPage } from '@/modules/rules/RuleCenterPage';
import { CmsCaseListPage } from '@/modules/cms/CmsCaseListPage';
import { CmsCaseKanbanPage } from '@/modules/cms/CmsCaseKanbanPage';
import { CmsCaseDetailPage } from '@/modules/cms/CmsCaseDetailPage';
import { CaseWorkflowPage } from '@/modules/cms/CaseWorkflowPage';
import { CaseCausalAnalysisPage } from '@/modules/cms/CaseCausalAnalysisPage';
import { CaseCapPage } from '@/modules/cms/CaseCapPage';
import { ScenarioPage } from '@/modules/scenario/ScenarioPage';
import { ReportsPage } from '@/modules/reports/ReportsPage';
import { CasesDetailReportPage } from '@/modules/reports/CasesDetailReportPage';
import { ReportBuilderPage } from '@/modules/reports/builder/ReportBuilderPage';
import { FeatureStorePage } from '@/modules/admin/featureStore/FeatureStorePage';
import { StreamingLatencyPage } from '@/modules/admin/streamingLatency/StreamingLatencyPage';
import { AnalyticsPage } from '@/modules/dashboard/AnalyticsPage';
import { AiWorkbenchPage } from '@/modules/ai/AiWorkbenchPage';
import { ModelRegistryPage } from '@/modules/ai/ModelRegistryPage';
import { ExplainabilityPage } from '@/modules/ai/ExplainabilityPage';
import { ExperimentTrackingPage } from '@/modules/ai/ExperimentTrackingPage';
import { DriftMonitoringPage } from '@/modules/ai/DriftMonitoringPage';
import { AiInsightsPage } from '@/modules/ai/AiInsightsPage';
// Enterprise AI Governance Layer (additive — legacy /ai/* URLs still resolve).
import { AiGovernanceCenterPage } from '@/modules/ai/governance/AiGovernanceCenterPage';
import { AiModelMonitoringPage } from '@/modules/ai/governance/AiModelMonitoringPage';
import { AiPredictionAuditPage } from '@/modules/ai/governance/AiPredictionAuditPage';
import { AiPerformanceTrackingPage } from '@/modules/ai/governance/AiPerformanceTrackingPage';
import { AiDriftDashboardPage } from '@/modules/ai/governance/AiDriftDashboardPage';
import { AiGovernanceReportsPage } from '@/modules/ai/governance/AiGovernanceReportsPage';
import { MasterSetupPage } from '@/modules/admin/MasterSetupPage';
import { RiskScoreConfigPage } from '@/modules/admin/RiskScoreConfigPage';
import { AlertClassificationConfigPage } from '@/modules/admin/AlertClassificationConfigPage';
import { CaseTypeSetupPage } from '@/modules/admin/CaseTypeSetupPage';
import { JobSchedulerConfigPage } from '@/modules/admin/JobSchedulerConfigPage';
import { AccessControlConfigPage } from '@/modules/admin/AccessControlConfigPage';
import { RulesEnginePage } from '@/modules/rules/RulesEnginePage';
import { ThresholdsLimitsPage } from '@/modules/admin/ThresholdsLimitsPage';
import { WorkflowsPage } from '@/modules/admin/WorkflowsPage';
import { TestingHubPage } from '@/modules/admin/TestingHubPage';
import { NpaPredictionPage } from '@/modules/banking/NpaPredictionPage';
import { SmaClassificationPage } from '@/modules/banking/SmaClassificationPage';
import { SectorWatchPage } from '@/modules/banking/SectorWatchPage';
import { CollectionsRiskPage } from '@/modules/banking/CollectionsRiskPage';
import { BorrowerTimelinePage } from '@/modules/banking/BorrowerTimelinePage';
import { BranchHeatmapPage } from '@/modules/banking/BranchHeatmapPage';
import { AdminUsersPage } from '@/modules/admin/AdminUsersPage';
import { AdminSessionsPage } from '@/modules/admin/AdminSessionsPage';
import { MasterMenuPage } from '@/modules/admin/masters/MasterMenuPage';
import { MasterEntityPage } from '@/modules/admin/masters/MasterEntityPage';
import { PermissionMatrixPage } from '@/modules/admin/rbac/PermissionMatrixPage';
import { BranchesPage } from '@/modules/admin/governance/BranchesPage';
import { ComplianceRulesPage } from '@/modules/admin/governance/ComplianceRulesPage';
// Enterprise Governance Center (additive — every legacy admin URL untouched).
import { GovernanceCenterPage } from '@/modules/admin/governance/GovernanceCenterPage';
import { OrganizationGovernancePage } from '@/modules/admin/governance/OrganizationGovernancePage';
import { DomainGovernancePage } from '@/modules/admin/governance/DomainGovernancePage';
import { RoleGovernancePage } from '@/modules/admin/governance/RoleGovernancePage';
import { RiskAndAlertGovernancePage } from '@/modules/admin/governance/RiskAndAlertGovernancePage';
import { IntegrationsPage } from '@/modules/admin/IntegrationsPage';
import { AuditLogPage } from '@/modules/admin/AuditLogPage';
import { AuditTrailPage } from '@/modules/admin/AuditTrailPage';
import { GlossaryPage } from '@/modules/help/GlossaryPage';
import { DataIngestionPage } from '@/modules/admin/DataIngestionPage';
import { DataProfilingPage } from '@/modules/admin/DataProfilingPage';
import { AnomalyDetectionPage } from '@/modules/admin/AnomalyDetectionPage';
import { ReconciliationPage } from '@/modules/admin/ReconciliationPage';
import { DqScorePage } from '@/modules/admin/DqScorePage';
import { BorrowerWatchPage } from '@/modules/customers/BorrowerWatchPage';
import { AccountBehaviourPage } from '@/modules/customers/AccountBehaviourPage';
import { FinancialRatiosPage } from '@/modules/customers/FinancialRatiosPage';
import { FraudSignalsPage } from '@/modules/banking/FraudSignalsPage';
import { PolicyLapsePage } from '@/modules/insurance/PolicyLapsePage';
import { ClaimsAnomalyPage } from '@/modules/insurance/ClaimsAnomalyPage';
import { FraudDetectionPage } from '@/modules/insurance/FraudDetectionPage';
import { SolvencyWatchPage } from '@/modules/insurance/SolvencyWatchPage';
import { PersistencyWatchPage } from '@/modules/insurance/PersistencyWatchPage';
import { UnderwritingDeviationPage } from '@/modules/insurance/UnderwritingDeviationPage';
import { ChannelRiskPage } from '@/modules/insurance/ChannelRiskPage';
import { PolicyTimelinePage } from '@/modules/insurance/PolicyTimelinePage';
import { InsuranceHeatmapPage } from '@/modules/insurance/InsuranceHeatmapPage';
import { ClaimInvestigationPage } from '@/modules/insurance/ClaimInvestigationPage';
import { AdminActivityPage } from '@/modules/admin/AdminActivityPage';
// Security Activity Center (additive — admin/activity, audit-center/*, IAM
// Center, admin/sessions URLs all untouched).
import { SecurityActivityCenterPage } from '@/modules/admin/security/SecurityActivityCenterPage';
import { WebhooksPage } from '@/modules/admin/WebhooksPage';
import { DashboardWidgetsPage } from '@/modules/admin/DashboardWidgetsPage';
import { AdminTenantsPage } from '@/modules/admin/AdminTenantsPage';
import { AdminServiceClientsPage } from '@/modules/admin/AdminServiceClientsPage';
import { UserAccessOverrideListPage } from '@/modules/admin/userAccessOverride/UserAccessOverrideListPage';
import { EffectiveAccessPage } from '@/modules/admin/userAccessOverride/EffectiveAccessPage';
import { SlaConfigPage } from '@/modules/admin/slaConfig/SlaConfigPage';
import { NotificationTemplatesPage } from '@/modules/admin/notificationTemplates/NotificationTemplatesPage';
import { NotificationDispatchesPage } from '@/modules/admin/notificationTemplates/NotificationDispatchesPage';
import { EscalationMatrixPage } from '@/modules/admin/escalationMatrix/EscalationMatrixPage';
import { EscalationWorkerPage } from '@/modules/admin/escalationWorker/EscalationWorkerPage';
import { CaseScenariosPage } from '@/modules/admin/caseScenarios/CaseScenariosPage';
import { RecycleBinPage } from '@/modules/admin/RecycleBinPage';
import { RecoveryAnalyticsPage } from '@/modules/admin/RecoveryAnalyticsPage';
// Audit + Recovery unified centers (additive — legacy URLs still resolve).
import { AuditCenterPage } from '@/modules/admin/audit/AuditCenterPage';
import { AuditExportPage } from '@/modules/admin/audit/AuditExportPage';
import { AuditComplianceReportsPage } from '@/modules/admin/audit/AuditComplianceReportsPage';
import { RecoveryCenterPage } from '@/modules/admin/recovery/RecoveryCenterPage';
// Enterprise Recovery Management Center — 4 net-new pages layered over the
// existing recovery-center landing. All legacy URLs preserved.
import { RecoveryWorkflowQueuePage } from '@/modules/admin/recovery/RecoveryWorkflowQueuePage';
import { RecoveryHistoryPage } from '@/modules/admin/recovery/RecoveryHistoryPage';
import { RecoverySearchPage } from '@/modules/admin/recovery/RecoverySearchPage';
import { RecoveryPoliciesPage } from '@/modules/admin/recovery/RecoveryPoliciesPage';
import { SessionsPage } from '@/modules/profile/SessionsPage';
import { LoginActivityPage } from '@/modules/profile/LoginActivityPage';
import { useAuth } from '@/store/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export function App() {
  const hydrate = useAuth((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* First-login is auth-required but renders OUTSIDE the AppShell
              so the user can't navigate to other pages until they complete
              the wizard. RequireAuth would otherwise bounce in a loop. */}
          <Route path="/first-login" element={<FirstLoginWizardPage />} />

          {/* Onboarding STEPS 2 + 3 — auth-required but rendered
              OUTSIDE the AppShell so the user is fully committed to
              the flow until a domain + tenant are chosen. */}
          <Route
            path="/onboarding/country"
            element={
              <RequireAuth>
                <OnboardingCountryPage />
              </RequireAuth>
            }
          />
          <Route
            path="/onboarding/domain"
            element={
              <RequireAuth>
                <OnboardingDomainPage />
              </RequireAuth>
            }
          />
          <Route
            path="/onboarding/tenant"
            element={
              <RequireAuth>
                <OnboardingTenantPage />
              </RequireAuth>
            }
          />

          <Route
            element={
              <RequireAuth>
                <RequireOnboarding>
                  <AppShell />
                </RequireOnboarding>
              </RequireAuth>
            }
          >
            <Route index element={<DashboardPage />} />
            {/* Domain-specific dashboard aliases — post-onboarding redirect
                targets. DashboardPage is already domain-aware (useVerticalMode),
                so both render the right view; these give stable deep-links. */}
            <Route path="banking/dashboard" element={<DashboardPage />} />
            <Route path="insurance/dashboard" element={<DashboardPage />} />
            {/* Role-Based Dashboard Engine — additive overlay (existing / route
                untouched). Resolves widgets per (role × domain × country ×
                tenant × branch) governance. */}
            <Route path="dashboards/role-based" element={<RoleBasedDashboardPage />} />
            {/* Executive Risk Cockpit — additive overlay (existing dashboards
                untouched). Role-gated inside the page to 7 executive personas. */}
            <Route path="executive-cockpit" element={<ExecutiveCockpitPage />} />
            {/* Predictive Risk Center — predictive intelligence overlay. Existing
                dashboards / cockpit / role-based dashboard all untouched. */}
            <Route path="predictive-risk-center" element={<PredictiveRiskCenterPage />} />
            {/* Investigation Center — additive overlay; existing CMS modules /
                Case Workflow / Causal Analysis / Tracking Timeline untouched. */}
            <Route path="investigation-center" element={<InvestigationCenterPage />} />
            {/* Regulatory Compliance Center — additive overlay; existing Audit Center
                / Governance / IAM / Rule Center / Recovery untouched. */}
            <Route path="regulatory-compliance-center" element={<RegulatoryComplianceCenterPage />} />
            {/* Data Fabric Center — additive overlay; existing Data Ingestion /
                Profiling / Validation / Standardization / Anomaly / Reconciliation /
                Data Quality Score modules untouched. */}
            <Route path="data-fabric-center" element={<DataFabricCenterPage />} />
            {/* Enterprise Demo Foundation — additive overlay; existing demo data
                (raw seeds, app_*, mart) remains intact; this page consumes the
                deterministic enterpriseDemo engines for realistic banking + insurance volume. */}
            <Route path="enterprise-demo-center" element={<EnterpriseDemoCenterPage />} />
            {/* Demo Readiness Center — additive overlay; consumes the prior
                15 IA centers' deterministic engines to measure UAT + demo +
                release readiness. */}
            <Route path="demo-readiness-center" element={<DemoReadinessCenterPage />} />
            {/* Digital Twin Risk Simulation Center — additive overlay (zero
                changes to prior 16 overlays); deterministic scenario engine,
                multi-horizon impact analysis, AI recommendations. */}
            <Route path="digital-twin-center" element={<DigitalTwinCenterPage />} />
            <Route path="autonomous-risk-center" element={<AutonomousRiskCenterPage />} />
            <Route path="alerts" element={<AlertListPage />} />
            <Route path="customers" element={<CustomerListPage />} />
            <Route path="customers/:id" element={<CustomerRiskProfilePage />} />
            <Route path="rules" element={<RuleConfigPage />} />
            <Route path="rules/reports" element={<RuleReportsPage />} />
            <Route path="rules/ews" element={<EwsRuleBuilderPage />} />
            <Route path="rules/ews/wizard" element={<EwsRuleWizardPage />} />
            <Route path="rules/ews/:rule_id/diff" element={<EwsRuleDiffPage />} />
            {/* ── Unified Rule Center (additive) ──────────────────────
                Single landing + 6 sub-routes that RENDER the same
                components mounted above at the legacy paths. Both old
                and new URLs work; sidebar exposes only /rule-center/*. */}
            <Route path="rule-center" element={<RuleCenterPage />} />
            <Route path="rule-center/builder" element={<EwsRuleWizardPage />} />
            <Route path="rule-center/library" element={<RulesEnginePage />} />
            <Route path="rule-center/testing" element={<RulesEnginePage />} />
            <Route path="rule-center/reports" element={<RuleReportsPage />} />
            <Route path="rule-center/history" element={<EwsRuleBuilderPage />} />
            <Route path="rule-center/comparison" element={<EwsRuleBuilderPage />} />
            <Route path="rule-center/comparison/:rule_id" element={<EwsRuleDiffPage />} />
            <Route path="cms/cases" element={<CmsCaseListPage />} />
            <Route path="cms/cases/kanban" element={<CmsCaseKanbanPage />} />
            <Route path="cms/workflow" element={<CaseWorkflowPage />} />
            <Route path="cms/cases/:id" element={<CmsCaseDetailPage />} />
            <Route path="cms/cases/:id/causal-analysis" element={<CaseCausalAnalysisPage />} />
            <Route path="cms/cases/:id/cap" element={<CaseCapPage />} />
            <Route path="scenario" element={<ScenarioPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="reports/cases-detail" element={<CasesDetailReportPage />} />
            <Route path="reports/builder" element={<ReportBuilderPage />} />
            <Route path="admin/feature-store" element={<FeatureStorePage />} />
            <Route path="admin/streaming-latency" element={<StreamingLatencyPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="ai/workbench" element={<AiWorkbenchPage />} />
            <Route path="ai/workbench/explainability" element={<ExplainabilityPage />} />
            <Route path="ai/registry" element={<ModelRegistryPage />} />
            <Route path="ai/explainability" element={<ExplainabilityPage />} />
            {/* Enterprise AI Governance Layer (additive — legacy /ai/* routes above still work). */}
            <Route path="ai/governance" element={<AiGovernanceCenterPage />} />
            <Route path="ai/governance/monitoring" element={<AiModelMonitoringPage />} />
            <Route path="ai/governance/prediction-audit" element={<AiPredictionAuditPage />} />
            <Route path="ai/governance/performance" element={<AiPerformanceTrackingPage />} />
            <Route path="ai/governance/drift" element={<AiDriftDashboardPage />} />
            <Route path="ai/governance/reports" element={<AiGovernanceReportsPage />} />
            <Route path="ai/experiments" element={<ExperimentTrackingPage />} />
            <Route path="ai/drift" element={<DriftMonitoringPage />} />
            <Route path="ai/insights" element={<AiInsightsPage />} />
            <Route path="admin/master-setup" element={<MasterSetupPage />} />
            <Route path="admin/risk-score-config" element={<RiskScoreConfigPage />} />
            <Route path="admin/alert-classification" element={<AlertClassificationConfigPage />} />
            <Route path="admin/case-types" element={<CaseTypeSetupPage />} />
            <Route path="admin/job-scheduler" element={<JobSchedulerConfigPage />} />
            <Route path="admin/access-control" element={<AccessControlConfigPage />} />
            <Route path="rules/engine" element={<RulesEnginePage />} />
            <Route path="admin/thresholds-limits" element={<ThresholdsLimitsPage />} />
            <Route path="admin/workflows" element={<WorkflowsPage />} />
            <Route path="admin/testing-hub" element={<TestingHubPage />} />
            {/* Banking-EWS modules — domain-guarded (symmetric with the
                Insurance block below): an Insurance user who URL-hops here is
                bounced to their own dashboard. Super-admin + unset-domain pass
                through (non-breaking). /customers stays unguarded — it's a
                cross-workflow drill-through anchor, not a banking-only page. */}
            <Route element={<RequireDomain domain="banking" />}>
              <Route path="banking/npa-prediction" element={<NpaPredictionPage />} />
              <Route path="banking/sma" element={<SmaClassificationPage />} />
              <Route path="banking/sectors" element={<SectorWatchPage />} />
            </Route>
            <Route path="profile/sessions" element={<SessionsPage />} />
            <Route path="profile/activity" element={<LoginActivityPage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/users/new" element={<AdminUserCreatePage />} />
            <Route path="admin/sessions" element={<AdminSessionsPage />} />
            {/* Enterprise IAM Center (additive — legacy admin/users + admin/sessions still work). */}
            <Route path="admin/iam" element={<IamCenterPage />} />
            <Route path="admin/iam/lifecycle" element={<UserLifecyclePage />} />
            <Route path="admin/iam/approvals" element={<UserApprovalsInboxPage />} />
            <Route path="admin/iam/access-review" element={<UserAccessReviewPage />} />
            <Route path="admin/iam/access-review/:username" element={<UserAccessReviewPage />} />
            <Route path="admin/iam/audit" element={<UserAuditHistoryPage />} />
            <Route path="admin/iam/audit/:username" element={<UserAuditHistoryPage />} />
            <Route path="admin/iam/password-policy" element={<PasswordPolicyPage />} />
            <Route path="admin/masters" element={<MasterMenuPage />} />
            <Route path="admin/masters/:entity" element={<MasterEntityPage />} />
            <Route path="admin/permission-matrix" element={<PermissionMatrixPage />} />
            <Route path="admin/governance/branches" element={<BranchesPage />} />
            <Route path="admin/governance/compliance-rules" element={<ComplianceRulesPage />} />
            {/* Enterprise Governance Center — additive landings (every Master Setup
                URL above + every legacy admin/* config URL still resolves). */}
            <Route path="admin/governance" element={<GovernanceCenterPage />} />
            <Route path="admin/governance/organization" element={<OrganizationGovernancePage />} />
            <Route path="admin/governance/domains" element={<DomainGovernancePage />} />
            <Route path="admin/governance/roles" element={<RoleGovernancePage />} />
            <Route path="admin/governance/risk" element={<RiskAndAlertGovernancePage />} />
            <Route path="admin/governance/alerts" element={<RiskAndAlertGovernancePage />} />
            <Route path="admin/integrations" element={<IntegrationsPage />} />
            <Route path="admin/audit-log" element={<AuditLogPage />} />
            <Route path="admin/audit-trail" element={<AuditTrailPage />} />
            <Route path="glossary" element={<GlossaryPage />} />
            <Route path="admin/ingestion" element={<DataIngestionPage />} />
            <Route path="admin/data-profiling" element={<DataProfilingPage />} />
            <Route path="admin/anomalies" element={<AnomalyDetectionPage />} />
            <Route path="admin/reconciliation" element={<ReconciliationPage />} />
            <Route path="admin/dq-score" element={<DqScorePage />} />
            <Route element={<RequireDomain domain="banking" />}>
              <Route path="borrower-watch" element={<BorrowerWatchPage />} />
              <Route path="account-behaviour" element={<AccountBehaviourPage />} />
              <Route path="financial-ratios" element={<FinancialRatiosPage />} />
              <Route path="fraud-signals" element={<FraudSignalsPage />} />
              <Route path="collections-risk" element={<CollectionsRiskPage />} />
              <Route path="borrower-timeline" element={<BorrowerTimelinePage />} />
              <Route path="branch-heatmap" element={<BranchHeatmapPage />} />
            </Route>
            {/* Insurance modules — domain-guarded: a Banking user who
                URL-hops here is bounced to their own dashboard. Super-admin
                + unset-domain pass through (non-breaking). */}
            <Route element={<RequireDomain domain="insurance" />}>
              <Route path="insurance/policy-lapse" element={<PolicyLapsePage />} />
              <Route path="insurance/claims-anomaly" element={<ClaimsAnomalyPage />} />
              <Route path="insurance/fraud" element={<FraudDetectionPage />} />
              <Route path="insurance/solvency" element={<SolvencyWatchPage />} />
              <Route path="insurance/persistency" element={<PersistencyWatchPage />} />
              <Route path="insurance/underwriting" element={<UnderwritingDeviationPage />} />
              <Route path="insurance/channel-risk" element={<ChannelRiskPage />} />
              <Route path="insurance/claim-investigation" element={<ClaimInvestigationPage />} />
              <Route path="insurance/policy-timeline" element={<PolicyTimelinePage />} />
              <Route path="insurance/heatmaps" element={<InsuranceHeatmapPage />} />
            </Route>
            <Route path="admin/activity" element={<AdminActivityPage />} />
            {/* Security Activity Center (additive) — wraps admin/activity + audit + IAM + sessions. */}
            <Route path="admin/security" element={<SecurityActivityCenterPage />} />
            <Route path="admin/webhooks" element={<WebhooksPage />} />
            <Route path="admin/dashboard-widgets" element={<DashboardWidgetsPage />} />
            <Route path="admin/tenants" element={<AdminTenantsPage />} />
            <Route path="admin/service-clients" element={<AdminServiceClientsPage />} />
            <Route path="admin/user-access-override" element={<UserAccessOverrideListPage />} />
            <Route
              path="admin/user-access-override/users/:user_id/effective-access"
              element={<EffectiveAccessPage />}
            />
            <Route path="admin/sla-config" element={<SlaConfigPage />} />
            <Route path="admin/notification-templates" element={<NotificationTemplatesPage />} />
            <Route path="admin/notification-dispatches" element={<NotificationDispatchesPage />} />
            <Route path="admin/escalation-matrix" element={<EscalationMatrixPage />} />
            <Route path="admin/escalation-worker" element={<EscalationWorkerPage />} />
            <Route path="admin/case-scenarios" element={<CaseScenariosPage />} />
            <Route path="admin/recycle-bin" element={<RecycleBinPage />} />
            <Route path="admin/recovery-analytics" element={<RecoveryAnalyticsPage />} />
            {/* Unified Audit + Recovery Centers (additive — legacy URLs above still work). */}
            <Route path="audit-center" element={<AuditCenterPage />} />
            <Route path="audit-center/trail" element={<AuditTrailPage />} />
            <Route path="audit-center/login-audit" element={<AdminSessionsPage />} />
            <Route path="audit-center/activity" element={<AuditLogPage />} />
            <Route path="audit-center/activity/admin" element={<AdminActivityPage />} />
            <Route path="audit-center/export" element={<AuditExportPage />} />
            <Route path="audit-center/compliance" element={<AuditComplianceReportsPage />} />
            <Route path="recovery-center" element={<RecoveryCenterPage />} />
            <Route path="recovery-center/deleted" element={<RecycleBinPage />} />
            <Route path="recovery-center/restore" element={<RecycleBinPage />} />
            <Route path="recovery-center/permanent-delete" element={<RecycleBinPage />} />
            <Route path="recovery-center/analytics" element={<RecoveryAnalyticsPage />} />
            {/* Enterprise Recovery Management Center — additive overlay (zero
                changes to the 4 lines above; legacy URLs untouched). */}
            <Route path="recovery-center/workflow" element={<RecoveryWorkflowQueuePage />} />
            <Route path="recovery-center/history" element={<RecoveryHistoryPage />} />
            <Route path="recovery-center/search" element={<RecoverySearchPage />} />
            <Route path="recovery-center/policies" element={<RecoveryPoliciesPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
