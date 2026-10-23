import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppConfigPublic } from '@comfy-mobile/shared';
import { ApiError, api, getToken, setToken } from './api';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

interface AppContextValue {
  config: AppConfigPublic | null;
  loadingConfig: boolean;
  authRequired: boolean;
  refreshConfig: () => Promise<AppConfigPublic | null>;
  login: (token: string) => Promise<boolean>;
  logout: () => void;
  toasts: Toast[];
  showToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfigPublic | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);

  const loadConfig = useCallback(async (): Promise<AppConfigPublic | null> => {
    try {
      const next = await api.getConfig();
      setConfig(next);
      setAuthRequired(false);
      return next;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthRequired(true);
        return null;
      }
      throw error;
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig().catch(() => {
      setLoadingConfig(false);
    });
  }, [loadConfig]);

  const dismissToast = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, kind: Toast['kind'] = 'info') => {
      const id = nextToast.current++;
      setToasts((items) => [...items.slice(-3), { id, message, kind }]);
      window.setTimeout(() => dismissToast(id), kind === 'error' ? 5200 : 2800);
    },
    [dismissToast],
  );

  const login = useCallback(
    async (token: string): Promise<boolean> => {
      setToken(token.trim());
      try {
        const next = await api.getConfig();
        setConfig(next);
        setAuthRequired(false);
        return true;
      } catch {
        setToken('');
        setAuthRequired(true);
        return false;
      }
    },
    [],
  );

  const logout = useCallback(() => {
    setToken('');
    setConfig(null);
    setAuthRequired(true);
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      return await loadConfig();
    } catch {
      return config;
    }
  }, [config, loadConfig]);

  // Keep the browser cookie in sync if the page was reloaded without one.
  useEffect(() => {
    if (getToken()) {
      // setToken also rewrites the cookie.
      setToken(getToken());
    }
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      config,
      loadingConfig,
      authRequired,
      refreshConfig,
      login,
      logout,
      toasts,
      showToast,
      dismissToast,
    }),
    [
      config,
      loadingConfig,
      authRequired,
      refreshConfig,
      login,
      logout,
      toasts,
      showToast,
      dismissToast,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
