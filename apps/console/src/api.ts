export class ApiError extends Error {
  constructor(message: string, public code?: string, public status?: number) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers }
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(problem.message || problem.error?.message || `Request failed (${response.status})`, problem.code, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const post = <T>(path: string, data: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });

export function relativeTime(value: string): string {
  const difference = Math.max(0, Date.now() - new Date(value).getTime());
  if (difference < 60_000) return 'Just now';
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m ago`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const splitLines = (value: string) => value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
export const splitScopes = (value: string) => value.split(/\s+/).filter(Boolean);
export const modeLabel = (mode: string) => ({ gateway: 'Managed gateway', direct: 'Managed direct', handoff: 'Credential handoff' }[mode] || mode);
