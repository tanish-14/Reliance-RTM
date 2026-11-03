import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';

/** Shared chrome for every role surface: brand bar, role nav, user + logout. */
export function Shell({ nav, children, extra, narrow }: { nav: { to: string; label: string; end?: boolean }[]; children: ReactNode; extra?: ReactNode; narrow?: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-red-800 bg-red-700 text-white">
        <div className={`mx-auto flex items-center gap-3 px-4 py-2.5 ${narrow ? 'max-w-xl' : 'max-w-6xl'}`}>
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold leading-tight">RCPL Route-to-Market</div>
            <div className="truncate text-xs text-red-100">
              {user?.name} · {user?.title ?? user?.role}
            </div>
          </div>
          {extra}
          <button
            title="Log out"
            className="rounded-md p-1.5 hover:bg-red-800"
            onClick={() => {
              logout();
              qc.clear();
              navigate('/login');
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
        <nav className={`mx-auto flex gap-1 overflow-x-auto px-3 pb-2 ${narrow ? 'max-w-xl' : 'max-w-6xl'}`}>
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-white text-red-800 font-medium' : 'text-red-50 hover:bg-red-800'}`}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className={`mx-auto space-y-4 px-4 py-4 ${narrow ? 'max-w-xl' : 'max-w-6xl'}`}>{children}</main>
    </div>
  );
}
