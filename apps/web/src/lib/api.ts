import { useAuth } from './auth';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Thrown when there is no network (real or simulated). Field flows queue instead of failing. */
export class OfflineError extends Error {
  constructor() {
    super('You are offline');
  }
}

export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const { token, forceOffline, logout } = useAuth.getState();
  if (forceOffline) throw new OfflineError();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new OfflineError();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) logout();
    // A proxy/gateway error means the API is unreachable: treat like offline.
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new OfflineError();
    throw new ApiError(res.status, data.code ?? 'ERROR', data.message ?? res.statusText, data.details);
  }
  return data as T;
}
