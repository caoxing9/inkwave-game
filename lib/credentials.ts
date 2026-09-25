import { getConfig } from './request';

export interface ConnectionToken {
  accessToken: string;
  provider: string;
  credentialId: string;
  alias: string;
}

export class ConnectionError extends Error {
  constructor(
    message: string,
    /**
     * 'not_granted' → the app has no grant under this alias; 'reauth_required' → the owner
     * must reconnect; 'no_token' → the connection is managed (Composio) and has no access
     * token by design — use callConnection(alias, …) for it instead.
     */
    public readonly code: 'not_granted' | 'reauth_required' | 'no_token' | 'unknown',
    public readonly alias: string,
    /** The server's own error code (e.g. CONNECTION_HAS_NO_TOKEN), verbatim, when it sent one. */
    public readonly serverCode?: string
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** Where Teable puts a business error code: `data.code` on a validation error, else the top-level code. */
function serverCodeOf(body: { code?: string; data?: { code?: string } }): string | undefined {
  return body.data?.code ?? body.code;
}

/**
 * Get a valid access token for a connection granted to this app, e.g.
 * `const { accessToken } = await getConnectionToken('GOOGLE_SHEET')`.
 *
 * Server-side only. Call it per request and never cache the token: Teable refreshes the
 * underlying OAuth credential for you and tokens expire. A `reauth_required` error means
 * the connection's owner has to reconnect it in Settings › Integrations — the grant itself
 * stays valid; do not ask for a new grant.
 */
export async function getConnectionToken(alias: string): Promise<ConnectionToken> {
  const { baseUrl, token, appId } = getConfig();
  const response = await fetch(
    `${baseUrl}/api/credential/resource/app/${appId}/connection-token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ alias }),
      cache: 'no-store',
    }
  );
  if (response.ok) return (await response.json()) as ConnectionToken;
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
    code?: string;
    data?: { code?: string };
  };
  const serverCode = serverCodeOf(body);
  const code =
    response.status === 404
      ? 'not_granted'
      : serverCode === 'CONNECTION_REAUTH_REQUIRED'
        ? 'reauth_required'
        : serverCode === 'CONNECTION_HAS_NO_TOKEN'
          ? 'no_token'
          : 'unknown';
  throw new ConnectionError(
    body.message ?? `Connection ${alias}: HTTP ${response.status}`,
    code,
    alias,
    serverCode
  );
}

export interface ConnectionCallResult<T = unknown> {
  data: T;
  error: string | null;
  /** Handle for the call in the provider's dashboard, when the source reports one. */
  logId?: string;
}

/**
 * Use a connection whose credential Teable never receives (Composio-managed), by asking
 * the server to make the call and sign it.
 *
 * Two ways to say what you want, e.g. for a connection granted as `NOTION`:
 *
 *   // the provider's own API, by path — the full HTTP surface
 *   await callConnection('NOTION', { endpoint: '/v1/search', method: 'POST', body: { page_size: 20 } })
 *
 *   // or a predefined tool, when one covers the task
 *   await callConnection('NOTION', { toolSlug: 'NOTION_SEARCH_NOTION_PAGE', arguments: { query: '' } })
 *
 * Server-side only. `getConnectionToken` throws `CONNECTION_HAS_NO_TOKEN` for these
 * connections — that is not a broken grant, it means the call belongs here instead.
 */
export async function callConnection<T = unknown>(
  alias: string,
  request:
    | { endpoint: string; method?: string; body?: unknown; parameters?: Array<{ name: string; value: string; in: string }> }
    | { toolSlug: string; arguments?: Record<string, unknown> }
): Promise<ConnectionCallResult<T>> {
  const { baseUrl, token, appId } = getConfig();
  const response = await fetch(
    `${baseUrl}/api/credential/resource/app/${appId}/composio-call`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ alias, ...request }),
      cache: 'no-store',
    }
  );
  if (response.ok) return (await response.json()) as ConnectionCallResult<T>;
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  throw new ConnectionError(
    body.message ?? `Connection ${alias}: HTTP ${response.status}`,
    response.status === 404 ? 'not_granted' : 'unknown',
    alias,
    serverCodeOf(body)
  );
}
