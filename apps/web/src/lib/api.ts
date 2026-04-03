/**
 * Typed API Client
 *
 * Phase 1 implementation status:
 * - This file now provides the first working API wrapper used by setup, auth,
 *   bootstrap loading, and chat data fetching.
 * - Current scope keeps access tokens in memory and sends refresh cookies automatically.
 * - Future phases can layer richer error handling and query caching on top of it.
 */

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export async function apiRequest(path: string, init?: RequestInit) {
  return fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    credentials: 'include',
  });
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiRequest(path, init);

  if (!response.ok) {
    let message = 'Request failed.';

    try {
      const payload = (await response.json()) as { message?: string };
      message = payload.message ?? message;
    } catch {
      // Ignore JSON parsing failures for non-JSON responses.
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
