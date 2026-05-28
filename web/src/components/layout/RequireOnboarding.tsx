import { Navigate } from 'react-router-dom';
import { type ReactNode } from 'react';
import { useCountry, useDomain, useTenantContext } from '@/lib/useOnboardingContext';

// Gate the authed app behind the 4-step context-selection flow. Rendered
// INSIDE RequireAuth and OUTSIDE the /onboarding/* routes (which are
// RequireAuth-only) so a missing step bounces the user to the right page
// without looping.
//
// Order mirrors useOnboardingContext: country (STEP 1) → domain (STEP 2)
// → tenant (STEP 3). Once all three are chosen the app renders normally.
// The login card stays untouched — login navigates to '/', this gate
// redirects into onboarding when context is incomplete.
export function RequireOnboarding({ children }: { children: ReactNode }) {
  const [country] = useCountry();
  const [domain] = useDomain();
  const [tenant] = useTenantContext();

  if (!country) return <Navigate to="/onboarding/country" replace />;
  if (!domain) return <Navigate to="/onboarding/domain" replace />;
  if (!tenant) return <Navigate to="/onboarding/tenant" replace />;

  return <>{children}</>;
}
