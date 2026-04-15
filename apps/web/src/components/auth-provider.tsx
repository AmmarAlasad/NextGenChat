/**
 * Auth Provider
 *
 * Phase 1 implementation status:
 * - This file now owns the first working client-side auth/session state.
 * - Current scope covers health probing (with retry backoff for slow backend startup),
 *   first-run setup detection, login, refresh, logout, and in-memory access-token storage.
 * - Future phases can grow this into richer app-wide bootstrap and role awareness.
 */

'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { AuthTokens, AuthUser, HealthStatus, LoginInput, SetupInput } from '@nextgenchat/types';

import { apiJson, apiRequest } from '@/lib/api';
import { disconnectChatSocket } from '@/lib/socket';

interface AuthContextValue {
  accessToken: string | null;
  ready: boolean;
  setupRequired: boolean;
  backendError: boolean;
  user: AuthUser | null;
  setup(input: SetupInput): Promise<void>;
  login(input: LoginInput): Promise<void>;
  refresh(): Promise<boolean>;
  logout(): Promise<void>;
  retryInit(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function applySession(
  tokens: AuthTokens,
  setAccessToken: (value: string | null) => void,
  setUser: (value: AuthUser | null) => void,
) {
  setAccessToken(tokens.accessToken);
  setUser(tokens.user);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [backendError, setBackendError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const tokens = await apiJson<AuthTokens>('/auth/refresh', {
        method: 'POST',
      });

      applySession(tokens, setAccessToken, setUser);
      return true;
    } catch {
      setAccessToken(null);
      setUser(null);
      return false;
    }
  }, []);

  const retryInit = useCallback(() => {
    setReady(false);
    setBackendError(false);
    setSetupRequired(false);
    setRetryKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let active = true;

    // Retry the health endpoint with increasing back-off.
    // Total budget: ~30 s — enough for a cold Turbo/TypeScript backend start.
    async function pollHealth(): Promise<HealthStatus> {
      const DELAYS = [500, 1000, 2000, 3000, 5000, 5000, 5000, 5000];
      let lastError: unknown;

      for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
        if (!active) throw new Error('unmounted');

        try {
          return await apiJson<HealthStatus>('/health');
        } catch (err) {
          lastError = err;
          if (attempt < DELAYS.length) {
            await new Promise((resolve) => setTimeout(resolve, DELAYS[attempt]));
          }
        }
      }

      throw lastError;
    }

    async function initialize() {
      const health = await pollHealth();

      if (!active) return;

      setSetupRequired(health.setupRequired);

      if (!health.setupRequired) {
        await refresh();
      }

      if (active) {
        setReady(true);
      }
    }

    initialize().catch(() => {
      if (active) {
        // Backend never responded — surface an error rather than silently
        // falling through to the login page (which would be confusing on a
        // fresh install where setup hasn't been done yet).
        setBackendError(true);
        setReady(true);
      }
    });

    return () => {
      active = false;
    };
  }, [refresh, retryKey]);

  const setup = useCallback(async (input: SetupInput) => {
    const tokens = await apiJson<AuthTokens>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify(input),
    });

    setSetupRequired(false);
    applySession(tokens, setAccessToken, setUser);
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    const tokens = await apiJson<AuthTokens>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });

    applySession(tokens, setAccessToken, setUser);
  }, []);

  const logout = useCallback(async () => {
    await apiRequest('/auth/logout', { method: 'POST' });
    disconnectChatSocket();
    setAccessToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      accessToken,
      ready,
      setupRequired,
      backendError,
      user,
      setup,
      login,
      refresh,
      logout,
      retryInit,
    }),
    [accessToken, backendError, login, logout, ready, refresh, retryInit, setup, setupRequired, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }

  return context;
}
