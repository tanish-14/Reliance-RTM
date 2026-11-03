import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Role } from '@rtm/shared';
import { useAuth } from './lib/auth';
import { LoginPage } from './pages/Login';
import { DsrApp } from './pages/dsr/DsrApp';
import { DistributorApp } from './pages/distributor/DistributorApp';
import { HqApp } from './pages/hq/HqApp';
import { AdminApp } from './pages/admin/AdminApp';
import { RetailerApp } from './pages/retailer/RetailerApp';

/** Each role gets its own shell; visiting another role's route bounces you home. */
function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { token, user, home } = useAuth();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={home} replace />;
  return <>{children}</>;
}

export function App() {
  const { token, home } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/dsr/*" element={<Guard role="DSR"><DsrApp /></Guard>} />
      <Route path="/distributor/*" element={<Guard role="DISTRIBUTOR"><DistributorApp /></Guard>} />
      <Route path="/hq/*" element={<Guard role="MANAGER"><HqApp /></Guard>} />
      <Route path="/admin/*" element={<Guard role="ADMIN"><AdminApp /></Guard>} />
      <Route path="/retailer/*" element={<Guard role="RETAILER"><RetailerApp /></Guard>} />
      <Route path="*" element={<Navigate to={token ? home : '/login'} replace />} />
    </Routes>
  );
}
