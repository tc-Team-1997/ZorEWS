import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Initialize i18n before any component renders. The import has a side
// effect (i18n.init) — we don't need the binding itself here.
import '@/lib/i18n';
import { LoginPage } from '@/modules/auth/LoginPage';
import { SignupPage } from '@/modules/auth/SignupPage';
import { ForgotPasswordPage } from '@/modules/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/modules/auth/ResetPasswordPage';
import { FirstLoginWizardPage } from '@/modules/auth/FirstLoginWizardPage';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/layout/RequireAuth';
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
import { CaseCausalAnalysisPage } from '@/modules/cms/CaseCausalAnalysisPage';
import { CaseCapPage } from '@/modules/cms/CaseCapPage';
import { ScenarioPage } from '@/modules/scenario/ScenarioPage';
import { ReportsPage } from '@/modules/reports/ReportsPage';
import { CasesDetailReportPage } from '@/modules/reports/CasesDetailReportPage';
import { ReportBuilderPage } from '@/modules/reports/builder/ReportBuilderPage';
import { FeatureStorePage } from '@/modules/admin/featureStore/FeatureStorePage';
import { StreamingLatencyPage } from '@/modules/admin/streamingLatency/StreamingLatencyPage';
import { AnalyticsPage } from '@/modules/dashboard/AnalyticsPage';
import { NpaPredictionPage } from '@/modules/banking/NpaPredictionPage';
import { SmaClassificationPage } from '@/modules/banking/SmaClassificationPage';
import { SectorWatchPage } from '@/modules/banking/SectorWatchPage';
import { AdminUsersPage } from '@/modules/admin/AdminUsersPage';
import { IntegrationsPage } from '@/modules/admin/IntegrationsPage';
import { AuditLogPage } from '@/modules/admin/AuditLogPage';
import { AuditTrailPage } from '@/modules/admin/AuditTrailPage';
import { DataIngestionPage } from '@/modules/admin/DataIngestionPage';
import { DataProfilingPage } from '@/modules/admin/DataProfilingPage';
import { AnomalyDetectionPage } from '@/modules/admin/AnomalyDetectionPage';
import { ReconciliationPage } from '@/modules/admin/ReconciliationPage';
import { DqScorePage } from '@/modules/admin/DqScorePage';
import { BorrowerWatchPage } from '@/modules/customers/BorrowerWatchPage';
import { AccountBehaviourPage } from '@/modules/customers/AccountBehaviourPage';
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
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="alerts" element={<AlertListPage />} />
            <Route path="customers" element={<CustomerListPage />} />
            <Route path="customers/:id" element={<CustomerRiskProfilePage />} />
            <Route path="rules" element={<RuleConfigPage />} />
            <Route path="rules/ews" element={<EwsRuleBuilderPage />} />
            <Route path="rules/ews/wizard" element={<EwsRuleWizardPage />} />
            <Route path="rules/ews/:rule_id/diff" element={<EwsRuleDiffPage />} />
            <Route path="cms/cases" element={<CmsCaseListPage />} />
            <Route path="cms/cases/kanban" element={<CmsCaseKanbanPage />} />
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
            <Route path="banking/npa-prediction" element={<NpaPredictionPage />} />
            <Route path="banking/sma" element={<SmaClassificationPage />} />
            <Route path="banking/sectors" element={<SectorWatchPage />} />
            <Route path="profile/sessions" element={<SessionsPage />} />
            <Route path="profile/activity" element={<LoginActivityPage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/integrations" element={<IntegrationsPage />} />
            <Route path="admin/audit-log" element={<AuditLogPage />} />
            <Route path="admin/audit-trail" element={<AuditTrailPage />} />
            <Route path="admin/ingestion" element={<DataIngestionPage />} />
            <Route path="admin/data-profiling" element={<DataProfilingPage />} />
            <Route path="admin/anomalies" element={<AnomalyDetectionPage />} />
            <Route path="admin/reconciliation" element={<ReconciliationPage />} />
            <Route path="admin/dq-score" element={<DqScorePage />} />
            <Route path="borrower-watch" element={<BorrowerWatchPage />} />
            <Route path="account-behaviour" element={<AccountBehaviourPage />} />
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
