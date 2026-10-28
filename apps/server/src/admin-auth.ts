import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { AdminIdentity, AdminSessionStatus, AdminUser } from '../../../packages/contracts/src/index.js';
import { digest, randomId } from '../../../packages/storage/src/index.js';
import { Bridge, later, validUntil } from './bridge.js';
import { configuredAdminMode } from './config.js';
import { getLocalPasswordRecord, normalizeUsername, setLocalPassword, validateAdminPassword, verifyLocalPassword } from './admin-passwords.js';
import { assert } from './errors.js';
import { readJson } from './network.js';

const cookieName = 'smart_flint_admin';
const cookiePath = '/api/admin';
const callbackPath = '/api/admin/oidc/callback';
const algorithms = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
export interface AdminPrincipal { identity: AdminIdentity; authentication: 'cookie' | 'bearer'; sessionId?: string }
interface AdminSession { id: string; expiresAt: string; kind: AdminIdentity['kind']; userId?: string; passwordVersion?: string }
interface LoginAttempts { id: string; attempts: number; expiresAt: string }
interface Discovery {
  issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string;
  response_types_supported?: string[]; code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[]; id_token_signing_alg_values_supported?: string[];
}
interface LoginTransaction { id: string; kind: 'admin_oidc'; browserBinding: string; expiresAt: string }
interface LoginSecret { verifier: string; nonce: string; clientId: string; issuer: string; discovery: Discovery }

const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const local = (ip: string) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const secureCookie = (bridge: Bridge) => !bridge.config.demo || new URL(bridge.config.consoleUrl).protocol === 'https:';
const actor = (identity: AdminIdentity) => ({ id: identity.id, displayName: identity.displayName, kind: identity.kind, role: identity.role });
const operatorIdentity = (kind: 'demo' | 'bootstrap'): AdminIdentity => ({
  id: kind === 'demo' ? 'local-demo' : 'bootstrap', displayName: kind === 'demo' ? 'Local developer' : 'Bootstrap administrator',
  kind, role: 'platform_admin', organizationIds: [], applicationIds: [],
});
const userIdentity = (user: AdminUser): AdminIdentity => ({
  id: user.id, displayName: user.displayName, kind: user.authMethod === 'local' ? 'local' : 'oidc', role: user.role,
  ...(user.authMethod === 'local' ? { username: user.username } : {}),
  organizationIds: [...user.organizationIds], applicationIds: [...user.applicationIds],
});

export function allowedAdminOrigin(bridge: Bridge, request: FastifyRequest, required: boolean): void {
  const origin = request.headers.origin;
  assert(!required || typeof origin === 'string', 403, 'origin_required', 'An approved administrative origin is required.');
  if (origin !== undefined) assert(typeof origin === 'string'
    && [new URL(bridge.config.consoleUrl).origin, new URL(bridge.config.baseUrl).origin].includes(origin),
  403, 'origin_not_allowed', 'This administrative origin is not approved.');
}

export async function bootstrapAllowed(bridge: Bridge): Promise<boolean> {
  if (configuredAdminMode(bridge.config) === 'demo') return true;
  if (!bridge.config.adminBootstrapEnabled || bridge.config.adminToken.length < 32) return false;
  for (const user of await bridge.repo.list<AdminUser>('admin_users')) if (await usablePlatformAdmin(bridge, user)) return false;
  return true;
}

/** Missing credentials fail closed: an existing local owner must use offline recovery. */
export async function usablePlatformAdmin(bridge: Bridge, user: AdminUser): Promise<boolean> {
  if (user.disabled || user.role !== 'platform_admin') return false;
  if (configuredAdminMode(bridge.config) === 'local') {
    if (user.authMethod !== 'local') return false;
    try { return normalizeUsername(user.username) === user.username; } catch { return false; }
  }
  return user.authMethod !== 'local' && !!user.subject && !!bridge.config.adminOidc && user.issuer === bridge.config.adminOidc.issuer;
}

export async function authenticateAdmin(bridge: Bridge, request: FastifyRequest): Promise<AdminPrincipal | undefined> {
  const authorization = request.headers.authorization;
  const mode = configuredAdminMode(bridge.config);
  const supplied = typeof authorization === 'string' ? /^Bearer (.+)$/i.exec(authorization)?.[1] : undefined;
  if (supplied && bridge.config.adminToken && equal(supplied, bridge.config.adminToken) && await bootstrapAllowed(bridge))
    return { identity: operatorIdentity(mode === 'demo' ? 'demo' : 'bootstrap'), authentication: 'bearer' };
  const credential = request.cookies[cookieName];
  if (!credential || credential.length > 1024) return undefined;
  const session = await bridge.repo.get<AdminSession>('sessions', `admin:${digest(credential)}`);
  if (!session) return undefined;
  let identity: AdminIdentity | undefined;
  if (validUntil(session.expiresAt)) {
    if (session.kind === 'local' && mode === 'local' && session.userId && session.passwordVersion) {
      const user = await bridge.repo.get<AdminUser>('admin_users', session.userId);
      const password = user?.authMethod === 'local' && !user.disabled ? await getLocalPasswordRecord(bridge, user.id) : undefined;
      if (user && password && equal(session.passwordVersion, password.version)) identity = userIdentity(user);
    } else if (session.kind === 'oidc' && mode !== 'local' && session.userId && bridge.config.adminOidc) {
      const user = await bridge.repo.get<AdminUser>('admin_users', session.userId);
      if (user && user.authMethod !== 'local' && !user.disabled && user.issuer === bridge.config.adminOidc.issuer) identity = userIdentity(user);
    } else if (session.kind === 'demo' && mode === 'demo') identity = operatorIdentity('demo');
    else if (session.kind === 'bootstrap' && mode !== 'demo' && await bootstrapAllowed(bridge)) identity = operatorIdentity('bootstrap');
  }
  if (!identity) { await bridge.repo.delete('sessions', session.id); return undefined; }
  return { identity, authentication: 'cookie', sessionId: session.id };
}

async function createSession(bridge: Bridge, reply: FastifyReply, identity: AdminIdentity, passwordVersion?: string) {
  assert(identity.kind !== 'local' || passwordVersion, 500, 'credential_unavailable', 'The administrative credential is unavailable.');
  const credential = randomId('admin');
  const session: AdminSession = { id: `admin:${digest(credential)}`, expiresAt: later(8 * 60 * 60), kind: identity.kind,
    ...(['oidc', 'local'].includes(identity.kind) ? { userId: identity.id } : {}),
    ...(identity.kind === 'local' ? { passwordVersion } : {}) };
  await bridge.repo.put('sessions', session);
  reply.setCookie(cookieName, credential, { path: cookiePath, httpOnly: true, secure: secureCookie(bridge), sameSite: 'strict', maxAge: 8 * 60 * 60 });
  await bridge.audit('admin.session_started', 'An administrative session was established.', { outcome: 'success', actor: actor(identity) });
}

function loginCookie(state: string) { return `smart_flint_oidc_${digest(state).slice(0, 24)}`; }
function failDestination(bridge: Bridge, code: 'sign_in_failed' | 'access_not_granted') {
  const destination = new URL(bridge.config.consoleUrl);
  destination.searchParams.set('admin_error', code);
  return destination.href;
}
async function discovery(bridge: Bridge): Promise<Discovery> {
  const provider = bridge.config.adminOidc!;
  const response = await bridge.http.request(`${provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, provider.allowedOrigins);
  assert(response.ok, 502, 'admin_provider_unavailable', 'The administrative identity provider could not be reached.');
  const metadata = await readJson<Discovery>(response);
  assert(metadata.issuer === provider.issuer, 502, 'admin_provider_invalid', 'The administrative identity provider did not match its configured issuer.');
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
    assert(typeof endpoint === 'string', 502, 'admin_provider_invalid', 'The administrative identity provider metadata is incomplete.');
    bridge.http.validate(endpoint, provider.allowedOrigins);
  }
  assert(!metadata.response_types_supported || metadata.response_types_supported.includes('code'), 502, 'admin_provider_invalid', 'The identity provider must support authorization code flow.');
  assert(!metadata.code_challenge_methods_supported || metadata.code_challenge_methods_supported.includes('S256'), 502, 'admin_provider_invalid', 'The identity provider must support S256 PKCE.');
  assert(!metadata.token_endpoint_auth_methods_supported || metadata.token_endpoint_auth_methods_supported.includes(provider.authMethod), 502, 'admin_provider_invalid', 'The configured OIDC client authentication is not supported.');
  return metadata;
}

export function registerAdminAuthentication(app: FastifyInstance, bridge: Bridge): void {
  app.get('/api/admin/session', async (request, reply): Promise<AdminSessionStatus> => {
    reply.header('Cache-Control', 'no-store');
    allowedAdminOrigin(bridge, request, false);
    const principal = await authenticateAdmin(bridge, request);
    const mode = configuredAdminMode(bridge.config), oidcEnabled = mode !== 'local' && !!bridge.config.adminOidc;
    return { authenticated: !!principal, demo: bridge.config.demo, authMode: mode, localEnabled: mode === 'local', oidcEnabled,
      ...(oidcEnabled ? { oidcLoginUrl: `${bridge.config.baseUrl}/api/admin/oidc/login`, oidcLabel: bridge.config.adminOidc!.label } : {}),
      bootstrapEnabled: await bootstrapAllowed(bridge), ...(principal ? { identity: principal.identity } : {}) };
  });

  app.post('/api/admin/session', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    allowedAdminOrigin(bridge, request, false);
    const body = request.body ?? {};
    assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_request', 'Supply username and password, or a bootstrap token.');
    const values = body as Record<string, unknown>, keys = Object.keys(values);
    const native = keys.includes('username') || keys.includes('password');
    let identity: AdminIdentity;
    if (native) {
      assert(keys.length === 2 && keys.every(key => ['username', 'password'].includes(key))
        && typeof values.username === 'string' && values.username.length <= 256
        && typeof values.password === 'string' && values.password.length <= 1024 && Buffer.byteLength(values.password, 'utf8') <= 1024
        && !/[\uD800-\uDFFF]/u.test(values.password), 400, 'invalid_request', 'Supply only a valid username and password.');
      allowedAdminOrigin(bridge, request, true);
      assert(configuredAdminMode(bridge.config) === 'local', 401, 'authentication_required', 'The username or password is incorrect.');
      const suppliedUsername = values.username, username = suppliedUsername.trim().toLowerCase(), password = values.password;
      // Hash attempted names in persistent throttle keys; raw failed credentials never enter audit records.
      const attemptId = `admin-login:${digest(username)}`;
      const result = await bridge.repo.withLock('admin:write', async () => {
        const previous = await bridge.repo.get<LoginAttempts>('replays', attemptId);
        const attempts = previous && validUntil(previous.expiresAt) ? previous : { id: attemptId, attempts: 0, expiresAt: later(900) };
        if (attempts.attempts >= 5) return { throttled: true } as const;
        let normalized: string | undefined;
        try { normalized = normalizeUsername(suppliedUsername); } catch { /* Invalid names take the same dummy KDF path as unknown names. */ }
        const users = normalized ? (await bridge.repo.list<AdminUser>('admin_users')).filter(user => user.authMethod === 'local' && user.username === normalized) : [];
        const user = users.length === 1 ? users[0] : undefined;
        const verified = await verifyLocalPassword(bridge, user?.id, password);
        if (!user || user.disabled || !verified) {
          await bridge.repo.put('replays', { ...attempts, attempts: attempts.attempts + 1 });
          await bridge.audit('admin.sign_in_failed', 'Administrative username and password sign-in failed.', { outcome: 'failure' });
          return { denied: true } as const;
        }
        const credential = await getLocalPasswordRecord(bridge, user.id);
        if (!credential) return { denied: true } as const;
        await bridge.repo.delete('replays', attemptId);
        const identity = userIdentity(user);
        await createSession(bridge, reply, identity, credential.version);
        return { identity } as const;
      });
      // Throw after the lock commits so failed-attempt counters also persist on PostgreSQL.
      if ('throttled' in result) reply.header('Retry-After', '900');
      assert(!('throttled' in result), 429, 'authentication_throttled', 'Too many sign-in attempts. Try again in 15 minutes.');
      assert('identity' in result && result.identity, 401, 'authentication_required', 'The username or password is incorrect.');
      identity = result.identity;
    } else {
      assert(keys.every(key => key === 'token'), 400, 'invalid_request', 'Supply only the bootstrap token.');
      const token = values.token ?? '';
      assert(typeof token === 'string' && token.length <= 16384, 400, 'invalid_request', 'The bootstrap token is invalid.');
      const result = await bridge.repo.withLock('admin:write', async () => {
        const mode = configuredAdminMode(bridge.config);
        const demoLogin = mode === 'demo' && !token && local(request.ip) && request.headers.origin === new URL(bridge.config.consoleUrl).origin;
        const tokenLogin = !!token && !!bridge.config.adminToken && equal(token, bridge.config.adminToken) && await bootstrapAllowed(bridge);
        if (!demoLogin && !tokenLogin) return undefined;
        const identity = operatorIdentity(mode === 'demo' ? 'demo' : 'bootstrap');
        await createSession(bridge, reply, identity);
        return identity;
      });
      assert(result, 401, 'authentication_required', 'Use the configured sign-in method or the explicitly enabled bootstrap credential.');
      identity = result;
    }
    reply.header('Cache-Control', 'no-store');
    return { authenticated: true, demo: bridge.config.demo, authMode: configuredAdminMode(bridge.config), identity };
  });

  // Deliberately outside configuration-policy wrappers: viewers may change their own password.
  app.post('/api/admin/password', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    assert(configuredAdminMode(bridge.config) === 'local', 404, 'admin_local_unavailable', 'Local password sign-in is not enabled.');
    allowedAdminOrigin(bridge, request, true);
    const values = request.body as Record<string, unknown> | undefined;
    assert(values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length === 2
      && Object.keys(values).every(key => ['currentPassword', 'newPassword'].includes(key))
      && typeof values.currentPassword === 'string' && values.currentPassword.length <= 1024
      && Buffer.byteLength(values.currentPassword, 'utf8') <= 1024 && !/[\uD800-\uDFFF]/u.test(values.currentPassword),
    400, 'invalid_request', 'Supply the current password and a new password.');
    const currentPassword = values.currentPassword;
    validateAdminPassword(values.newPassword);
    const newPassword = values.newPassword;
    const result = await bridge.repo.withLock('admin:write', async () => {
      const principal = await authenticateAdmin(bridge, request);
      assert(principal?.identity.kind === 'local' && principal.authentication === 'cookie', 401, 'authentication_required', 'Sign in with a local account to change its password.');
      const attemptId = `admin-password-change:${digest(principal.identity.id)}`;
      const previous = await bridge.repo.get<LoginAttempts>('replays', attemptId);
      const attempts = previous && validUntil(previous.expiresAt) ? previous : { id: attemptId, attempts: 0, expiresAt: later(900) };
      if (attempts.attempts >= 5) return { throttled: true } as const;
      if (!await verifyLocalPassword(bridge, principal.identity.id, currentPassword)) {
        await bridge.repo.put('replays', { ...attempts, attempts: attempts.attempts + 1 });
        await bridge.audit('admin.password_change_failed', 'An administrative password change failed current-password verification.',
          { outcome: 'failure', actor: actor(principal.identity), resource: { type: 'admin_users', id: principal.identity.id } });
        return { denied: true } as const;
      }
      await setLocalPassword(bridge, principal.identity.id, newPassword);
      await bridge.repo.delete('replays', attemptId);
      if (principal.identity.username) await bridge.repo.delete('replays', `admin-login:${digest(principal.identity.username)}`);
      if (principal.sessionId) await bridge.repo.delete('sessions', principal.sessionId);
      await bridge.audit('admin.password_changed', 'An administrative password was changed and previous password sessions were revoked.',
        { outcome: 'success', actor: actor(principal.identity), resource: { type: 'admin_users', id: principal.identity.id } });
      return { changed: true } as const;
    });
    if ('throttled' in result) reply.header('Retry-After', '900');
    assert(!('throttled' in result), 429, 'authentication_throttled', 'Too many verification attempts. Try again in 15 minutes.');
    assert('changed' in result, 401, 'password_verification_failed', 'The current password is incorrect.');
    reply.clearCookie(cookieName, { path: cookiePath, httpOnly: true, secure: secureCookie(bridge), sameSite: 'strict' });
    return { changed: true, reauthenticationRequired: true };
  });

  app.delete('/api/admin/session', async (request, reply) => {
    const principal = await authenticateAdmin(bridge, request);
    assert(principal, 401, 'authentication_required', 'An administrative session is required.');
    allowedAdminOrigin(bridge, request, principal.authentication === 'cookie');
    if (principal.sessionId) await bridge.repo.delete('sessions', principal.sessionId);
    reply.clearCookie(cookieName, { path: cookiePath, httpOnly: true, secure: secureCookie(bridge), sameSite: 'strict' });
    reply.header('Cache-Control', 'no-store');
    await bridge.audit('admin.session_ended', 'An administrative session was closed.', { outcome: 'success', actor: actor(principal.identity) });
    return { authenticated: false, demo: bridge.config.demo };
  });

  app.get('/api/admin/oidc/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    assert(configuredAdminMode(bridge.config) !== 'local' && bridge.config.adminOidc, 404, 'admin_oidc_unconfigured', 'Organization sign-in is not configured.');
    let transactionId: string | undefined;
    try {
      const provider = bridge.config.adminOidc;
      const metadata = await discovery(bridge);
      const state = randomBytes(32).toString('base64url'), browserBinding = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
      transactionId = `admin_oidc:${digest(state)}`;
      await bridge.vault.set(`transaction:${transactionId}`, { verifier, nonce, clientId: provider.clientId, issuer: provider.issuer, discovery: metadata } satisfies LoginSecret);
      await bridge.repo.put<LoginTransaction>('transactions', { id: transactionId, kind: 'admin_oidc', browserBinding: digest(browserBinding), expiresAt: later(300) });
      reply.setCookie(loginCookie(state), browserBinding, { path: callbackPath, httpOnly: true, secure: new URL(bridge.config.baseUrl).protocol === 'https:', sameSite: 'lax', maxAge: 300 });
      const authorize = new URL(metadata.authorization_endpoint);
      for (const [name, value] of Object.entries({ response_type: 'code', client_id: provider.clientId, redirect_uri: `${bridge.config.baseUrl}${callbackPath}`,
        scope: 'openid profile email', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) authorize.searchParams.set(name, value);
      return reply.redirect(authorize.href);
    } catch {
      if (transactionId) { await bridge.repo.delete('transactions', transactionId); await bridge.vault.delete(`transaction:${transactionId}`); }
      await bridge.audit('admin.sign_in_failed', 'Administrative identity-provider discovery or authorization setup failed.', { outcome: 'failure' });
      return reply.redirect(failDestination(bridge, 'sign_in_failed'));
    }
  });

  app.get('/api/admin/oidc/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const provider = configuredAdminMode(bridge.config) !== 'local' ? bridge.config.adminOidc : undefined;
    assert(provider, 404, 'admin_oidc_unconfigured', 'Organization sign-in is not configured.');
    const query = request.query as Record<string, unknown>;
    let consumed: string | undefined;
    let failure: 'sign_in_failed' | 'access_not_granted' = 'sign_in_failed';
    try {
      const state = query.state;
      assert(typeof state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(state), 401, 'admin_state_invalid', 'Start a fresh organization sign-in.');
      const id = `admin_oidc:${digest(state)}`;
      const existing = await bridge.repo.get<LoginTransaction>('transactions', id);
      const binding = request.cookies[loginCookie(state)];
      assert(existing?.kind === 'admin_oidc' && validUntil(existing.expiresAt) && typeof binding === 'string' && equal(digest(binding), existing.browserBinding), 401, 'admin_state_invalid', 'Start a fresh organization sign-in.');
      const transaction = await bridge.repo.consume<LoginTransaction>('transactions', id);
      assert(transaction && transaction.kind === 'admin_oidc' && validUntil(transaction.expiresAt), 401, 'admin_state_invalid', 'Start a fresh organization sign-in.');
      consumed = id;
      reply.clearCookie(loginCookie(state), { path: callbackPath, httpOnly: true, secure: new URL(bridge.config.baseUrl).protocol === 'https:', sameSite: 'lax' });
      const secret = await bridge.vault.get<LoginSecret>(`transaction:${id}`);
      await bridge.vault.delete(`transaction:${id}`);
      assert(secret && secret.issuer === provider.issuer && secret.clientId === provider.clientId, 401, 'admin_state_invalid', 'Start a fresh organization sign-in.');
      assert(query.error === undefined && typeof query.code === 'string' && query.code.length > 0 && query.code.length <= 16384, 401, 'admin_authorization_failed', 'Organization sign-in did not complete.');
      assert(query.iss === undefined || query.iss === provider.issuer, 401, 'admin_issuer_invalid', 'Organization sign-in did not complete.');
      const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
      const params = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: `${bridge.config.baseUrl}${callbackPath}`, code_verifier: secret.verifier, client_id: provider.clientId });
      if (provider.authMethod === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret!)}`).toString('base64')}`;
      else if (provider.authMethod === 'client_secret_post') params.set('client_secret', provider.clientSecret!);
      const tokenResponse = await bridge.http.request(secret.discovery.token_endpoint, provider.allowedOrigins, { method: 'POST', headers, body: params.toString() });
      assert(tokenResponse.ok, 401, 'admin_authorization_failed', 'Organization sign-in did not complete.');
      const tokens = await readJson<{ id_token?: unknown; access_token?: unknown }>(tokenResponse);
      assert(typeof tokens.id_token === 'string' && tokens.id_token.length <= 65536, 401, 'admin_identity_invalid', 'Organization sign-in did not complete.');
      const jwksResponse = await bridge.http.request(secret.discovery.jwks_uri, provider.allowedOrigins);
      assert(jwksResponse.ok, 502, 'admin_provider_unavailable', 'The identity-provider signing keys could not be retrieved.');
      const jwks = await readJson<JSONWebKeySet>(jwksResponse);
      const accepted = algorithms.filter(alg => !secret.discovery.id_token_signing_alg_values_supported || secret.discovery.id_token_signing_alg_values_supported.includes(alg));
      const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { issuer: provider.issuer, audience: provider.clientId,
        algorithms: accepted, requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce'], clockTolerance: 5, maxTokenAge: '6m' });
      const claims = verified.payload;
      assert(typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 512
        && typeof claims.nonce === 'string' && equal(claims.nonce, secret.nonce)
        && (claims.azp === undefined || claims.azp === provider.clientId)
        && (!Array.isArray(claims.aud) || claims.aud.length === 1 || claims.azp === provider.clientId), 401, 'admin_identity_invalid', 'Organization sign-in did not complete.');
      if (claims.at_hash !== undefined) {
        const hash = `sha${verified.protectedHeader.alg.slice(-3)}`;
        assert(typeof claims.at_hash === 'string' && typeof tokens.access_token === 'string', 401, 'admin_identity_invalid', 'Organization sign-in did not complete.');
        const bytes = createHash(hash).update(tokens.access_token).digest();
        assert(equal(claims.at_hash, bytes.subarray(0, bytes.length / 2).toString('base64url')), 401, 'admin_identity_invalid', 'Organization sign-in did not complete.');
      }
      const users = (await bridge.repo.list<AdminUser>('admin_users')).filter(user => user.authMethod !== 'local' && user.issuer === provider.issuer && user.subject === claims.sub);
      failure = 'access_not_granted';
      assert(users.length === 1 && !users[0]!.disabled, 403, 'admin_access_not_granted', 'Ask your platform administrator to grant access to this identity.');
      await createSession(bridge, reply, userIdentity(users[0]!));
      return reply.redirect(bridge.config.consoleUrl);
    } catch {
      if (consumed) await bridge.vault.delete(`transaction:${consumed}`);
      await bridge.audit('admin.sign_in_failed', failure === 'access_not_granted' ? 'A verified administrative identity has no active access assignment.' : 'Administrative organization sign-in failed validation.', { outcome: 'failure' });
      return reply.redirect(failDestination(bridge, failure));
    }
  });
}
