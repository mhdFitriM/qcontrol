/**
 * Tiny fetch wrapper. All API calls are credentialed (cookie carries the
 * auth token after login). On 401 we redirect to /login.
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new Error('unauthorized');
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body });
    return body as T;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return text as unknown as T;
}

export const api = {
  get:  <T = any>(path: string) => call<T>(path),
  post: <T = any>(path: string, data?: any) => call<T>(path, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  put:  <T = any>(path: string, data?: any) => call<T>(path, { method: 'PUT',  body: JSON.stringify(data ?? {}) }),
  text: async (path: string) => {
    const res = await fetch(`/api${path}`, { credentials: 'include' });
    if (res.status === 401) {
      if (!location.pathname.startsWith('/login')) location.href = '/login';
      throw new Error('unauthorized');
    }
    return res.text();
  },
};
