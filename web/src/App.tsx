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
import { CmsCaseListPage } from '@/modules/cms/CmsCaseListPage';
import { CmsCaseKanbanPage } from '@/modules/cms/CmsCaseKanbanPage';
import { CmsCaseDetailPage } from '@/modules/cms/CmsCaseDetailPage';
import { CaseListPage } from '@/modules/cases/CaseListPage';
import { CaseDetailPage } from '@/modules/cases/CaseDetailPage';
import { ScenarioPage } from '@/modules/scenario/ScenarioPage';
import { ReportsPage } from '@/modules/reports/ReportsPage';
import { AdminUsersPage } from '@/modules/admin/AdminUsersPage';
import { IntegrationsPage } from '@/modules/admin/IntegrationsPage';
import { AuditLogPage } from '@/modules/admin/AuditLogPage';
import { WebhooksPage } from '@/modules/admin/WebhooksPage';
import { DashboardWidgetsPage } from '@/modules/admin/DashboardWidgetsPage';
import { AdminTenantsPage } from '@/modules/admin/AdminTenantsPage';
import { AdminServiceClientsPage } from '@/modules/admin/AdminServiceClientsPage';
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
            <Route path="cms/cases" element={<CmsCaseListPage />} />
            <Route path="cms/cases/kanban" element={<CmsCaseKanbanPage />} />
            <Route path="cms/cases/:id" element={<CmsCaseDetailPage />} />
            <Route path="cases" element={<CaseListPage />} />
            <Route path="cases/:id" element={<CaseDetailPage />} />
            <Route path="scenario" element={<ScenarioPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="profile/sessions" element={<SessionsPage />} />
            <Route path="profile/activity" element={<LoginActivityPage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/integrations" element={<IntegrationsPage />} />
            <Route path="admin/audit-log" element={<AuditLogPage />} />
            <Route path="admin/webhooks" element={<WebhooksPage />} />
            <Route path="admin/dashboard-widgets" element={<DashboardWidgetsPage />} />
            <Route path="admin/tenants" element={<AdminTenantsPage />} />
            <Route path="admin/service-clients" element={<AdminServiceClientsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
