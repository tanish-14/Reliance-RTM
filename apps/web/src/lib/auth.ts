import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Role } from '@rtm/shared';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: string | null;
  distributorId: string | null;
  outletId: string | null;
}

interface AuthState {
  token: string | null;
  user: SessionUser | null;
  home: string;
  /** Demo switch: behave as if the network were down (sync calls fail fast). */
  forceOffline: boolean;
  /** Demo switch: use beat/outlet coordinates instead of the device GPS. */
  simulateGps: boolean;
  setSession: (token: string, user: SessionUser, home: string) => void;
  logout: () => void;
  setForceOffline: (v: boolean) => void;
  setSimulateGps: (v: boolean) => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      home: '/',
      forceOffline: false,
      simulateGps: true,
      setSession: (token, user, home) => set({ token, user, home }),
      logout: () => set({ token: null, user: null, home: '/' }),
      setForceOffline: (forceOffline) => set({ forceOffline }),
      setSimulateGps: (simulateGps) => set({ simulateGps }),
    }),
    { name: 'rtm-auth' },
  ),
);
