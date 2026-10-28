import type {
  AccessMode, ActivationDescriptor, ActivationSession, CredentialResponse,
  LaunchRequest, LaunchStart, OriginalCredentialResponse, RedeemRequest, TokenResponse,
} from '@smart-flint/contracts';

export type { AccessMode, ActivationDescriptor, ActivationSession, CredentialResponse, LaunchStart, OriginalCredentialResponse, TokenResponse };

/** The SDK is optional. These are ordinary HTTP requests against the public API. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Ephemeral browser transaction storage. Never used for access or refresh tokens. */
  storage?: StorageLike;
}
export interface StartOptions {
  installationId: string;
  redirectUri: string;
  mode?: AccessMode;
  launchTicket?: string;
  /** Native/server callers can supply their own PKCE transaction and redeem explicitly. */
  codeChallenge?: string;
  state?: string;
}
export interface FHIRConnection {
  baseUrl: string;
  fhirVersion: string;
  route: 'gateway' | 'direct';
  credentials: {
    getAccessToken(): Promise<string>;
    getAuthorizationHeader(): Promise<string>;
  };
}

export class SMARTFlintError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'SMARTFlintError';
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function createPKCE(): Promise<{ codeVerifier: string; codeChallenge: string; state: string }> {
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return {
    codeVerifier,
    codeChallenge: base64url(new Uint8Array(digest)),
    state: base64url(crypto.getRandomValues(new Uint8Array(24))),
  };
}

interface BrowserTransaction {
  codeVerifier: string;
  applicationId: string;
  redirectUri: string;
  expiresAt: string;
}
const transactionKey = (state: string) => `smart-flint:launch:${state}`;
const callbackParameters = ['code', 'state', 'error', 'error_description'];

export class SMARTFlintClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly suppliedStorage?: StorageLike;

  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new SMARTFlintError('insecure_base_url', 'SMART Flint requires HTTPS outside localhost.');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new SMARTFlintError('invalid_base_url', 'The base URL must not contain credentials, query parameters, or a fragment.');
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.suppliedStorage = options.storage;
  }

  private storage(): StorageLike {
    if (this.suppliedStorage) return this.suppliedStorage;
    if (typeof window !== 'undefined') return window.sessionStorage;
    throw new SMARTFlintError('browser_storage_required', 'Supply codeChallenge and state, then use redeem(), outside a browser.');
  }

  /** Starts authorization. The caller navigates the system browser to launchUrl. */
  async start(options: StartOptions): Promise<LaunchStart> {
    const callback = new URL(options.redirectUri);
    if (callbackParameters.some(key => callback.searchParams.has(key)) || callback.hash) {
      throw new SMARTFlintError('invalid_redirect_uri', 'The callback cannot contain reserved authorization parameters or a fragment.');
    }
    if (Boolean(options.codeChallenge) !== Boolean(options.state)) {
      throw new SMARTFlintError('incomplete_transaction', 'Supply both codeChallenge and state.');
    }
    const automatic = !options.codeChallenge;
    const storage = automatic ? this.storage() : undefined;
    const pkce = automatic ? await createPKCE() : undefined;
    const body: LaunchRequest = {
      installationId: options.installationId,
      redirectUri: options.redirectUri,
      mode: options.mode,
      ...(options.launchTicket ? { launchTicket: options.launchTicket } : {}),
      codeChallenge: options.codeChallenge ?? pkce!.codeChallenge,
      state: options.state ?? pkce!.state,
    };
    const result = await this.request<LaunchStart>('/api/launches', { method: 'POST', body: JSON.stringify(body) });
    if (storage && pkce) {
      const applicationId = (result as LaunchStart & { applicationId?: string }).applicationId;
      if (!applicationId) throw new SMARTFlintError('invalid_launch_response', 'The launch response did not identify the application.');
      storage.setItem(transactionKey(pkce.state), JSON.stringify({
        codeVerifier: pkce.codeVerifier, applicationId,
        redirectUri: options.redirectUri, expiresAt: result.expiresAt,
      } satisfies BrowserTransaction));
    }
    return result;
  }

  /** Binds an EHR-initiated launch to this app's own browser transaction. */
  async resumeEHRLaunch(input?: string): Promise<LaunchStart> {
    const callback = new URL(input ?? (typeof window !== 'undefined' ? window.location.href : 'about:blank'));
    const tickets = callback.searchParams.getAll('smart_flint_launch');
    if (tickets.length !== 1 || !tickets[0]) throw new SMARTFlintError('invalid_launch_ticket', 'Exactly one EHR launch ticket is required.');
    const ticket = tickets[0];
    const bootstrap = await this.request<{ installationId: string; applicationId: string; expiresAt: string }>(`/api/launches/bootstrap/${encodeURIComponent(ticket)}`);
    callback.searchParams.delete('smart_flint_launch');
    if (typeof window !== 'undefined' && (input === undefined || input === window.location.href)) window.history.replaceState(null, '', callback.href);
    return this.start({ installationId: bootstrap.installationId, redirectUri: callback.href, launchTicket: ticket });
  }

  /** Browser helper: checks and consumes the initiating transaction before code redemption. */
  async completeRedirect(input?: string): Promise<ActivationSession> {
    const callback = new URL(input ?? (typeof window !== 'undefined' ? window.location.href : 'about:blank'));
    for (const key of callbackParameters) {
      if (callback.searchParams.getAll(key).length > 1) {
        throw new SMARTFlintError('ambiguous_callback', 'The callback contains duplicate authorization parameters.');
      }
    }
    const state = callback.searchParams.get('state');
    if (!state) throw new SMARTFlintError('missing_state', 'The callback is missing its browser transaction state.');
    const storage = this.storage();
    const stored = storage.getItem(transactionKey(state));
    if (!stored) throw new SMARTFlintError('invalid_state', 'This launch was not initiated in this browser tab or has already been completed.');
    let transaction: BrowserTransaction;
    try { transaction = JSON.parse(stored) as BrowserTransaction; }
    catch { throw new SMARTFlintError('invalid_transaction', 'The browser launch transaction is invalid.'); }
    const clean = new URL(callback);
    callbackParameters.forEach(key => clean.searchParams.delete(key));
    if (clean.href !== new URL(transaction.redirectUri).href) {
      throw new SMARTFlintError('callback_mismatch', 'The callback does not match the initiating application destination.');
    }
    storage.removeItem(transactionKey(state));
    if (typeof window !== 'undefined' && callback.href === window.location.href) {
      window.history.replaceState(null, '', clean.href);
    }
    if (!Number.isFinite(Date.parse(transaction.expiresAt)) || Date.parse(transaction.expiresAt) <= Date.now()) {
      throw new SMARTFlintError('launch_expired', 'The launch transaction expired. Start a new launch.');
    }
    const error = callback.searchParams.get('error');
    if (error) {
      const message = error === 'invalid_launch_token'
        ? 'The EHR rejected the launch token. Start a fresh launch from the EHR. If this repeats, ask the integration administrator to check the client ID and EHR environment.'
        : error === 'invalid_grant'
        ? 'The EHR could not validate the authorization grant (invalid_grant). Start a fresh launch from the EHR. If the same test user keeps failing, ask the integration administrator to check the launch and test-user configuration.'
        : 'Authorization did not complete. Start a new launch to try again.';
      throw new SMARTFlintError(error, message);
    }
    const code = callback.searchParams.get('code');
    if (!code) throw new SMARTFlintError('missing_code', 'The callback is missing its activation code.');
    return this.redeem({ code, codeVerifier: transaction.codeVerifier, applicationId: transaction.applicationId, redirectUri: transaction.redirectUri });
  }

  /** Native and server callers bind state in their own transaction before calling this API. */
  redeem(request: RedeemRequest): Promise<ActivationSession> {
    return this.request('/api/activations/redeem', { method: 'POST', body: JSON.stringify(request) });
  }

  session(activationId: string, sessionToken: string): ActivatedSession {
    if (!activationId || !sessionToken) throw new SMARTFlintError('missing_session', 'An activation ID and its session credential are required.');
    return new ActivatedSession(this, activationId, sessionToken);
  }

  async request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers, cache: 'no-store', redirect: 'error' });
    if (!response.ok) {
      let problem: { code?: string; message?: string } = {};
      try { problem = await response.json() as typeof problem; } catch { /* HTTP status remains useful for non-JSON upstream failures. */ }
      throw new SMARTFlintError(problem.code ?? 'request_failed', problem.message ?? `SMART Flint request failed (${response.status}).`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

export class ActivatedSession {
  readonly credentials: {
    current: () => Promise<CredentialResponse>;
    original: () => Promise<OriginalCredentialResponse>;
    handoff: () => Promise<CredentialResponse>;
  };

  constructor(private readonly client: SMARTFlintClient, readonly activationId: string, private readonly sessionToken: string) {
    this.credentials = {
      current: () => this.call('/credentials'),
      original: () => this.call('/credentials/original'),
      handoff: () => this.call('/credentials/handoff', { method: 'POST' }),
    };
  }

  private call<T>(suffix = '', init?: RequestInit): Promise<T> {
    return this.client.request(`/api/activations/${encodeURIComponent(this.activationId)}${suffix}`, init, this.sessionToken);
  }

  descriptor(): Promise<ActivationDescriptor> { return this.call(); }

  async getFHIRConnection(options: { route?: 'gateway' | 'direct' } = {}): Promise<FHIRConnection> {
    const activation = await this.descriptor();
    const route = options.route ?? (activation.mode === 'gateway' ? 'gateway' : 'direct');
    if (route === 'gateway') {
      return {
        baseUrl: activation.gateway.baseUrl, fhirVersion: activation.upstream.fhirVersion, route,
        credentials: {
          getAccessToken: async () => this.sessionToken,
          getAuthorizationHeader: async () => `Bearer ${this.sessionToken}`,
        },
      };
    }
    return {
      baseUrl: activation.upstream.baseUrl, fhirVersion: activation.upstream.fhirVersion, route,
      credentials: {
        getAccessToken: async () => (await this.credentials.current()).accessToken,
        getAuthorizationHeader: async () => {
          const credential = await this.credentials.current();
          return `${credential.tokenType} ${credential.accessToken}`;
        },
      },
    };
  }

  close(): Promise<void> { return this.call('', { method: 'DELETE' }); }

  /** Keeps credentials out of accidental JSON/debug serialization. */
  toJSON(): { activationId: string } { return { activationId: this.activationId }; }
}
