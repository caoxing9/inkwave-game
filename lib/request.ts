interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  params?: Record<string, unknown>;
}

export function getConfig() {
  const baseUrl = process.env.TEABLE_API_URL;
  const token = process.env.TEABLE_APP_TOKEN;
  const appId = process.env.TEABLE_APP_ID ?? '';
  const baseId = process.env.TEABLE_BASE_ID ?? '';
  if (!baseUrl) throw new Error('TEABLE_API_URL environment variable is not set');
  if (!token) throw new Error('TEABLE_APP_TOKEN environment variable is not set');
  return { baseUrl, token, appId, baseId };
}

export async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { baseUrl, token } = getConfig();
  const { method = 'GET', body, params } = options;

  let url = `${baseUrl}/api${endpoint}`;
  if (params && Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.set(key, String(value));
      }
    });
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(`Teable API Error [${response.status}]: ${error.message || 'Unknown error'}`);
  }

  if (response.status === 204) return undefined as T;
  return response.json();
}
