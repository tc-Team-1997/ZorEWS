import { Navigate, useLocation } from 'react-router-dom';
import { type ReactNode } from 'react';
import { useAuth } from '@/store/auth';

export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const location = useLocation();

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  // First-login users get bounced to the wizard until they finish it.
  // The wizard route itself is rendered outside RequireAuth, so this
  // redirect doesn't loop. Skip the bounce when the user is already on
  // /first-login (covers a navigation that lands the user there directly).
  if (user?.must_change_password && location.pathname !== '/first-login') {
    return <Navigate to="/first-login" replace />;
  }
  return <>{children}</>;
}
