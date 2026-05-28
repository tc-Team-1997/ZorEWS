import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/store/auth';
import { useDomain } from '@/lib/useOnboardingContext';

// Route-level domain guard (layout route — renders <Outlet/> when allowed).
//
// Complements the sidebar's domain filter (which only HIDES wrong-domain
// links): this stops a direct URL-hop, e.g. a Banking user navigating to
// /insurance/policy-lapse by typing the URL. Wrap a contiguous domain
// route group:
//
//   <Route element={<RequireDomain domain="insurance" />}>
//     <Route path="insurance/policy-lapse" element={<PolicyLapsePage />} />
//     …
//   </Route>
//
// Allow rules (non-breaking by design):
//   - super-admin (canonical `admin` role) → always allowed (sees both).
//   - no active domain chosen → allowed (no-op; the RequireOnboarding gate
//     forces a choice in normal use, and tests that render pages directly
//     bypass routing entirely).
//   - active domain matches the route's domain → allowed.
//   - otherwise → bounce to the user's own domain dashboard.
export function RequireDomain({ domain }: { domain: 'banking' | 'insurance' }) {
  const [active] = useDomain();
  const isSuperAdmin = useAuth((s) => (s.user?.roles ?? []).includes('admin'));

  if (isSuperAdmin || !active || active === domain) return <Outlet />;

  return (
    <Navigate
      to={active === 'insurance' ? '/insurance/dashboard' : '/banking/dashboard'}
      replace
    />
  );
}
