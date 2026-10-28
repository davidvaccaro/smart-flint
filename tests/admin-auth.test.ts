import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { Response } from 'undici';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdminUser } from '../packages/contracts/src/index.js';
import { digest, openRepository, type Repository } from '../packages/storage/src/index.js';
import { Bridge } from '../apps/server/src/bridge.js';
import { loadConfig, type Config } from '../apps/server/src/config.js';
import { registerAdminAuthentication } from '../apps/server/src/admin-auth.js';
import { Problem } from '../apps/server/src/errors.js';

const issuer = 'https://identity.example/tenant';
const origin = 'https://flint.example';
const clientId = 'smart-flint-administration';
const bootstrapToken = 'synthetic-bootstrap-token-for-auth-tests-only-123456';
const owned: { app: FastifyInstance; bridge: Bridge; repo: Repository }[] = [];
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let otherPair: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  pair = await generateKeyPair('ES256', { extractable: true });
  otherPair = await generateKeyPair('ES256');
  publicKey = { ...await exportJWK(pair.publicKey), kid: 'test-signing-key', alg: 'ES256' };
});
afterEach(async () => {
  for (const resource of owned.splice(0)) { await resource.app.close(); await resource.bridge.http.close(); await resource.repo.close(); }
  vi.restoreAllMocks();
});

async function setup(overrides: Partial<Config> = {}, withUser = true) {
  const config = loadConfig({ demo: false, baseUrl: origin, consoleUrl: origin, host: '127.0.0.1', databaseUrl: undefined, sqlitePath: ':memory:',
    encryptionKey: randomBytes(32).toString('base64'), adminToken: bootstrapToken, adminBootstrapEnabled: true,
    adminOidc: { issuer, clientId, authMethod: 'none', allowedOrigins: ['https://identity.example'], label: 'Company sign-in' }, ...overrides });
  const repo = await openRepository({ sqlitePath: ':memory:' });
  const bridge = new Bridge(repo, config);
  const app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Problem) return reply.code(error.status).send({ code: error.code });
    return reply.code(500).send({ code: 'internal_error' });
  });
  registerAdminAuthentication(app, bridge);
  await app.ready();
  const user: AdminUser = { id: 'admin-person-a', issuer, subject: 'subject-a', displayName: 'Administrator A',
    role: 'platform_admin', organizationIds: [], applicationIds: [], disabled: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (withUser) await repo.put('admin_users', user);
  owned.push({ app, bridge, repo });
  return { app, bridge, repo, user, config };
}

function provider(bridge: Bridge, options: { claims?: Partial<JWTPayload>; wrongSignature?: boolean; discovery?: Record<string, unknown> } = {}) {
  let nonce: string | undefined;
  let exchangeCount = 0;
  const requests = vi.spyOn(bridge.http, 'request').mockImplementation(async (url, _origins, init) => {
    if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      id_token_signing_alg_values_supported: ['ES256'], ...options.discovery,
    }));
    if (url === `${issuer}/token`) {
      exchangeCount++;
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('redirect_uri')).toBe(`${origin}/api/admin/oidc/callback`);
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const time = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ iss: issuer, aud: clientId, sub: 'subject-a', iat: time, exp: time + 300, nonce, ...options.claims })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-signing-key' }).sign(options.wrongSignature ? otherPair.privateKey : pair.privateKey);
      return new Response(JSON.stringify({ id_token: idToken, access_token: 'synthetic-provider-access-token' }));
    }
    if (url === `${issuer}/jwks`) return new Response(JSON.stringify({ keys: [publicKey] }));
    throw new Error('Unexpected endpoint');
  });
  return { requests, setNonce(value: string) { nonce = value; }, exchanges: () => exchangeCount };
}

async function start(app: FastifyInstance, fake: ReturnType<typeof provider>) {
  const login = await app.inject({ url: '/api/admin/oidc/login' });
  expect(login.statusCode).toBe(302);
  const authorize = new URL(login.headers.location!);
  fake.setNonce(authorize.searchParams.get('nonce')!);
  const state = authorize.searchParams.get('state')!;
  const binding = login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
  return { login, authorize, state, binding, callback: `/api/admin/oidc/callback?${new URLSearchParams({ code: 'synthetic-code', state })}` };
}

describe('administrative OIDC authorization', () => {
  it('uses S256 PKCE, cookie-bound state and signed identity to establish a hashed local session without retaining provider tokens', async () => {
    const { app, bridge, repo } = await setup();
    const fake = provider(bridge);
    const flow = await start(app, fake);
    expect(flow.authorize.origin).toBe('https://identity.example');
    expect(flow.authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(flow.login.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(flow.login.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(String(flow.login.headers['set-cookie'])).toContain('Secure');
    const result = await app.inject({ url: flow.callback, headers: { cookie: flow.binding } });
    expect(result.statusCode).toBe(302); expect(result.headers.location).toBe(origin);
    const sessionCookie = result.cookies.find(item => item.name === 'smart_flint_admin')!;
    expect(sessionCookie).toBeDefined();
    const rows = await repo.list<{ id: string; userId?: string }>('sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `admin:${digest(sessionCookie.value)}`, userId: 'admin-person-a', kind: 'oidc' });
    expect((await repo.list('transactions')).length).toBe(0); expect((await repo.list('secrets')).length).toBe(0);
    expect(JSON.stringify(rows)).not.toContain(sessionCookie.value);
    const cookie = `smart_flint_admin=${sessionCookie.value}`;
    const status = await app.inject({ url: '/api/admin/session', headers: { cookie } });
    expect(status.json()).toMatchObject({ authenticated: true, identity: { id: 'admin-person-a', role: 'platform_admin', kind: 'oidc' } });
    expect(JSON.stringify(await repo.list('events'))).not.toContain('synthetic-provider-access-token');
    expect((await repo.list<{ actor?: { id: string } }>('events')).find(event => event.actor)?.actor?.id).toBe('admin-person-a');
    expect(fake.exchanges()).toBe(1);
    const replay = await app.inject({ url: flow.callback, headers: { cookie: flow.binding } });
    expect(replay.headers.location).toBe(`${origin}/?admin_error=sign_in_failed`); expect(fake.exchanges()).toBe(1);
    const logout = await app.inject({ method: 'DELETE', url: '/api/admin/session', headers: { cookie, origin } });
    expect(logout.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/session', headers: { cookie } })).json().authenticated).toBe(false);
  });

  it.each([
    ['nonce', { nonce: 'wrong-nonce' }], ['issuer', { iss: 'https://attacker.example' }], ['audience', { aud: 'other-client' }],
    ['authorized party', { azp: 'other-client' }], ['multiple audiences without authorized party', { aud: [clientId, 'other-client'] }],
    ['expired identity', { exp: 1 }], ['future issued identity', { iat: Math.floor(Date.now() / 1000) + 3600 }],
  ])('rejects %s without creating a session', async (_name, claims) => {
    const { app, bridge, repo } = await setup(); const fake = provider(bridge, { claims: claims as Partial<JWTPayload> });
    const flow = await start(app, fake);
    const response = await app.inject({ url: flow.callback, headers: { cookie: flow.binding } });
    expect(response.headers.location).toBe(`${origin}/?admin_error=sign_in_failed`);
    expect(await repo.list('sessions')).toEqual([]); expect(await repo.list('transactions')).toEqual([]); expect(await repo.list('secrets')).toEqual([]);
  });

  it('rejects an invalid signature and does not trust email or provider role/group claims', async () => {
    const { app, bridge, repo } = await setup(); const fake = provider(bridge, { wrongSignature: true });
    const flow = await start(app, fake);
    expect((await app.inject({ url: flow.callback, headers: { cookie: flow.binding } })).headers.location).toBe(`${origin}/?admin_error=sign_in_failed`);
    expect(await repo.list('sessions')).toEqual([]);
    fake.requests.mockRestore();
    const other = provider(bridge, { claims: { sub: 'unprovisioned-subject', email: 'admin@example.org', groups: ['platform_admin'], role: 'platform_admin' } });
    const second = await start(app, other);
    expect((await app.inject({ url: second.callback, headers: { cookie: second.binding } })).headers.location).toBe(`${origin}/?admin_error=access_not_granted`);
    expect(await repo.list('sessions')).toEqual([]);
  });

  it('requires the originating browser cookie before consuming state and ignores untrusted error descriptions', async () => {
    const { app, bridge, repo } = await setup(); const fake = provider(bridge); const flow = await start(app, fake);
    expect((await app.inject({ url: flow.callback })).headers.location).toBe(`${origin}/?admin_error=sign_in_failed`);
    expect(fake.exchanges()).toBe(0); expect(await repo.list('transactions')).toHaveLength(1);
    const denied = `/api/admin/oidc/callback?${new URLSearchParams({ state: flow.state, error: 'access_denied', error_description: 'synthetic-secret-description' })}`;
    const response = await app.inject({ url: denied, headers: { cookie: flow.binding } });
    expect(response.headers.location).toBe(`${origin}/?admin_error=sign_in_failed`);
    expect(JSON.stringify(await repo.list('events'))).not.toContain('synthetic-secret-description');
    expect(await repo.list('transactions')).toEqual([]); expect(await repo.list('secrets')).toEqual([]);
  });

  it('rejects unapproved discovery endpoints before requesting them', async () => {
    const { app, bridge, repo } = await setup(); const fake = provider(bridge, { discovery: { token_endpoint: 'https://attacker.example/token' } });
    const response = await app.inject({ url: '/api/admin/oidc/login' });
    expect(response.headers.location).toBe(`${origin}/?admin_error=sign_in_failed`);
    expect(fake.requests).toHaveBeenCalledTimes(1); expect(await repo.list('transactions')).toEqual([]);
  });

  it.each(['client_secret_basic', 'client_secret_post'] as const)('supports %s without retaining its configured secret or provider tokens', async authMethod => {
    const secret = 'synthetic client:secret+with/encoding';
    const { app, bridge, repo } = await setup({ adminOidc: { issuer, clientId, authMethod, clientSecret: secret, allowedOrigins: ['https://identity.example'], label: 'Sign in' } });
    const fake = provider(bridge); const flow = await start(app, fake);
    const response = await app.inject({ url: flow.callback, headers: { cookie: flow.binding } });
    expect(response.headers.location).toBe(origin);
    const exchange = fake.requests.mock.calls.find(call => call[0] === `${issuer}/token`)!;
    const parameters = new URLSearchParams(String(exchange[2]?.body));
    if (authMethod === 'client_secret_basic') {
      expect(exchange[2]?.headers?.Authorization).toBe(`Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`);
      expect(parameters.has('client_secret')).toBe(false);
    } else expect(parameters.get('client_secret')).toBe(secret);
    expect(JSON.stringify(await repo.list('events'))).not.toContain(secret);
    expect(JSON.stringify(await repo.list('sessions'))).not.toContain(secret);
    expect(await repo.list('secrets')).toEqual([]);
  });

  it('rejects an expired transaction without exchanging its authorization code', async () => {
    const { app, bridge, repo } = await setup(); const fake = provider(bridge); const flow = await start(app, fake);
    const id = `admin_oidc:${digest(flow.state)}`;
    const row = await repo.get<{ id: string; expiresAt: string }>('transactions', id);
    await repo.put('transactions', { ...row!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const response = await app.inject({ url: flow.callback, headers: { cookie: flow.binding } });
    expect(response.headers.location).toBe(`${origin}/?admin_error=sign_in_failed`);
    expect(fake.exchanges()).toBe(0); expect(await repo.list('sessions')).toEqual([]);
  });

  it('loads current assignments for every request and immediately rejects disabled users and obsolete sessions', async () => {
    const { app, bridge, repo, user } = await setup(); const fake = provider(bridge); const flow = await start(app, fake);
    const response = await app.inject({ url: flow.callback, headers: { cookie: flow.binding } });
    const raw = response.cookies.find(item => item.name === 'smart_flint_admin')!.value;
    const cookie = `smart_flint_admin=${raw}`;
    await repo.put('admin_users', { ...user, role: 'viewer', organizationIds: ['org-1'], applicationIds: ['app-1'] });
    expect((await app.inject({ url: '/api/admin/session', headers: { cookie } })).json().identity).toMatchObject({ role: 'viewer', organizationIds: ['org-1'], applicationIds: ['app-1'] });
    await repo.put('admin_users', { ...user, disabled: true });
    expect((await app.inject({ url: '/api/admin/session', headers: { cookie } })).json().authenticated).toBe(false);
    await repo.put('sessions', { id: `admin:${digest('legacy-cookie')}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), role: 'admin' });
    expect((await app.inject({ url: '/api/admin/session', headers: { cookie: 'smart_flint_admin=legacy-cookie' } })).json().authenticated).toBe(false);
    expect((await app.inject({ url: '/api/admin/session', headers: { cookie: 'sb_admin=legacy-cookie' } })).json().authenticated).toBe(false);
  });
});

describe('controlled production bootstrap', () => {
  it('requires explicit bootstrap enablement and retires token and bootstrap sessions when an owner exists', async () => {
    const { app, repo, user } = await setup({}, false);
    const login = await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { token: bootstrapToken } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    expect((await app.inject({ url: '/api/admin/session', headers: { cookie } })).json().identity.kind).toBe('bootstrap');
    await repo.put('admin_users', user);
    expect((await app.inject({ url: '/api/admin/session', headers: { cookie } })).json().authenticated).toBe(false);
    expect((await app.inject({ url: '/api/admin/session', headers: { authorization: `Bearer ${bootstrapToken}` } })).json().authenticated).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { token: bootstrapToken } })).statusCode).toBe(401);
    const second = await setup({ adminBootstrapEnabled: false }, false);
    expect((await second.app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { token: bootstrapToken } })).statusCode).toBe(401);
  });

  it('keeps origin-bound local demo login and blocks cross-origin cookie mutations', async () => {
    const { app } = await setup({ demo: true });
    expect((await app.inject({ method: 'POST', url: '/api/admin/session', payload: {} })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: {} });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/session', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/session', headers: { cookie, origin: 'https://attacker.example' } })).statusCode).toBe(403);
  });

  it('rejects unsafe or incomplete production identity configuration', () => {
    const base = { demo: false, baseUrl: origin, consoleUrl: origin, encryptionKey: randomBytes(32).toString('base64'), adminToken: bootstrapToken };
    expect(() => loadConfig({ ...base, adminBootstrapEnabled: false, adminOidc: undefined })).toThrow('Configure administrative OIDC');
    expect(() => loadConfig({ ...base, adminBootstrapEnabled: true, adminOidc: { issuer: 'http://identity.example', clientId, authMethod: 'none', allowedOrigins: [], label: '' } })).toThrow('HTTPS');
    expect(() => loadConfig({ ...base, adminBootstrapEnabled: true, adminOidc: { issuer, clientId, authMethod: 'client_secret_basic', allowedOrigins: [], label: '' } })).toThrow('CLIENT_SECRET');
  });
});
