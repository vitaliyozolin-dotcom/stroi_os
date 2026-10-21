import { useEffect, useRef } from 'react';
import { requestApi } from '../../infrastructure/api-http';
import type { RemoteProjectSnapshot } from '../../application';

// SettingsWorkspace is keyed by project. Abort old requests and prevent late
// server snapshots or follow-up access operations from crossing that boundary.
export function useSettingsRequest(projectId: string, onSnapshot?: (snapshot: RemoteProjectSnapshot) => void) {
  const controller = useRef<AbortController | null>(null);
  if (!controller.current) controller.current = new AbortController();
  useEffect(() => {
    if (controller.current?.signal.aborted) controller.current = new AbortController();
    return () => controller.current?.abort();
  }, []);
  return {
    isActive: () => !controller.current?.signal.aborted,
    request: (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = controller.current!.signal;
      if (signal.aborted) return Promise.reject(new DOMException('Настройки проекта закрыты.', 'AbortError'));
      return requestApi(input, { ...init, signal });
    },
    applySnapshot: (snapshot: RemoteProjectSnapshot) => {
      if (!controller.current?.signal.aborted && snapshot.projectId === projectId) onSnapshot?.(snapshot);
    },
  };
}
