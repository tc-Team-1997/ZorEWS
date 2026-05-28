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
import { ForgotPasswordPage } from '@/modules/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/modules/auth/ResetPasswordPage';
import { FirstLoginWizardPage } from '@/modules/auth/FirstLoginWizardPage';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/layout/RequireAuth';
import { RequireOnboarding } from '@/components/layout/RequireOnboarding';
import { RequireDomain } from '@/components/layout/RequireDomain';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { AlertListPage } from '@/modules/alerts/AlertListPage';
import { CustomerListPage } from '@/modules/customers/CustomerListPage';
import { CustomerRiskProfilePage } from '@/modules/customers/CustomerRiskProfilePage';
import { RuleConfigPage } from '@/modules/rules/RuleConfigPage';
import { EwsRuleBuilderPage } from '@/modules/rules/EwsRuleBuilderPage';
import { EwsRuleWizardPage } from '@/modules/rules/EwsRuleWizardPage';
import { EwsRuleDiffPage } from '@/modules/rules/EwsRuleDiffPage';
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
import { MasterSetupPage } from '@/modules/admin/MasterSetupPage';
import { RulesEnginePage } from '@/modules/rules/RulesEnginePage';
import { ThresholdsLimitsPage } from '@/modules/admin/ThresholdsLimitsPage';
import { WorkflowsPage } from '@/modules/admin/WorkflowsPage';
import { TestingHubPage } from '@/modules/admin/TestingHubPage';
import { NpaPredictionPage } from '@/modules/banking/NpaPredictionPage';
import { SmaClassificationPage } from '@/modules/banking/SmaClassificationPage';
import { SectorWatchPage } from '@/modules/banking/SectorWatchPage';
import { AdminUsersPage } from '@/modules/admin/AdminUsersPage';
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
import { AdminActivityPage } from '@/modules/admin/AdminActivityPage';
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
            <Route path="alerts" element={<AlertListPage />} />
            <Route path="customers" element={<CustomerListPage />} />
            <Route path="customers/:id" element={<CustomerRiskProfilePage />} />
            <Route path="rules" element={<RuleConfigPage />} />
            <Route path="rules/ews" element={<EwsRuleBuilderPage />} />
            <Route path="rules/ews/wizard" element={<EwsRuleWizardPage />} />
            <Route path="rules/ews/:rule_id/diff" element={<EwsRuleDiffPage />} />
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
            <Route path="ai/registry" element={<ModelRegistryPage />} />
            <Route path="ai/explainability" element={<ExplainabilityPage />} />
            <Route path="admin/master-setup" element={<MasterSetupPage />} />
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
            </Route>
            <Route path="admin/activity" element={<AdminActivityPage />} />
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
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
