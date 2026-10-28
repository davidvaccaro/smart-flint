import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../apps/server/src/bridge.js';
import type { Config } from '../apps/server/src/config.js';
import { registerAdmin } from '../apps/server/src/admin.js';
import { seedDemo } from '../apps/server/src/seed.js';
import { migrateRegistry } from '../apps/server/src/registry.js';
import { Problem } from '../apps/server/src/errors.js';
import { digest, openRepository, type Repository } from '../packages/storage/src/index.js';

const owned: { app: FastifyInstance; bridge: Bridge; repo: Repository }[] = [];
const origin = 'http://localhost:3010';
const adminToken = 'admin-credential-for-automated-tests-only-123456';

async function setup(seed = false) {
  const repo = await openRepository({ sqlitePath: ':memory:' });
  const config: Config = {
    port: 3001, host: '127.0.0.1', baseUrl: 'http://localhost:3001', consoleUrl: origin, demo: true,
    adminToken, encryptionKey: randomBytes(32).toString('base64'), sqlitePath: ':memory:', allowPrivateNetworks: false,
    mockEhrUrl: 'http://localhost:4010', secureCookies: false, retentionHours: 24,
  };
  const bridge = new Bridge(repo, config);
  const app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Problem) return reply.code(error.status).send({ code: error.code, message: error.message });
    return reply.code(500).send({ code: 'internal_error' });
  });
  registerAdmin(app, bridge);
  if (seed) await seedDemo(bridge);
  await migrateRegistry(repo);
  await app.ready();
  owned.push({ app, bridge, repo });
  return { app, bridge, repo, headers: { authorization: `Bearer ${adminToken}` } };
}

afterEach(async () => {
  for (const resource of owned.splice(0)) {
    await resource.app.close(); await resource.bridge.http.close(); await resource.repo.close();
  }
});

describe('administrative session boundary', () => {
  it('requires authentication and prevents origin-free or remote demo auto-login', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/admin/dashboard' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/session' })).json()).toEqual({ authenticated: false, demo: true, authMode: 'demo', localEnabled: false, oidcEnabled: false, bootstrapEnabled: true });
    expect((await app.inject({ method: 'POST', url: '/api/admin/session', payload: { token: '' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/admin/session', remoteAddress: '198.51.100.4', headers: { origin }, payload: { token: '' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin: 'https://untrusted.example' }, payload: { token: adminToken } })).statusCode).toBe(403);
  });

  it('stores only the hash of an HttpOnly session and requires origin on cookie mutations', async () => {
    const { app, repo } = await setup();
    const login = await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { token: '' } });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict'); expect(setCookie).toContain('Path=/api/admin');
    const cookieValue = setCookie.split(';')[0]!;
    const rawToken = cookieValue.split('=')[1]!;
    const rows = await repo.list<{ id: string; role: string }>('sessions');
    expect(rows[0]?.id).toBe(`admin:${digest(rawToken)}`);
    expect(JSON.stringify(rows)).not.toContain(rawToken);
    expect((await app.inject({ url: '/api/admin/dashboard', headers: { cookie: cookieValue } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/dashboard', headers: { cookie: cookieValue, origin: 'https://registered-app.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/tenants', headers: { cookie: cookieValue }, payload: { name: 'Example' } })).statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/admin/tenants', headers: { cookie: cookieValue, origin }, payload: { name: 'Example' } });
    expect(created.statusCode).toBe(201);
    const logout = await app.inject({ method: 'DELETE', url: '/api/admin/session', headers: { cookie: cookieValue, origin } });
    expect(logout.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/dashboard', headers: { cookie: cookieValue } })).statusCode).toBe(401);
  });

  it('does not accept an application session as an administrative session', async () => {
    const { app, repo } = await setup();
    const raw = 'application-session';
    await repo.put('sessions', { id: `admin:${digest(raw)}`, activationId: 'act_elsewhere', expiresAt: new Date(Date.now() + 10000).toISOString() });
    expect((await app.inject({ url: '/api/admin/dashboard', headers: { cookie: `sb_admin=${raw}` } })).statusCode).toBe(401);
  });
});

describe('configuration API', () => {
  it('rejects caller-supplied record IDs and atomically enforces tenant slugs', async () => {
    const { app, headers } = await setup();
    const override = await app.inject({ method: 'POST', url: '/api/admin/tenants', headers, payload: { id: 'overwrite', name: 'Hospital' } });
    expect(override.statusCode).toBe(400);
    const results = await Promise.all(Array.from({ length: 2 }, () => app.inject({ method: 'POST', url: '/api/admin/tenants', headers, payload: { name: 'Hospital', slug: 'hospital' } })));
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
  });

  it('validates callbacks and installation tenant/scope relationships', async () => {
    const { app, headers } = await setup(true);
    expect((await app.inject({ method: 'POST', url: '/api/admin/applications', headers, payload: { name: 'Invalid', callbackUrls: ['javascript:alert(1)'] } })).statusCode).toBe(400);
    const body = { name: 'Cross-tenant', applicationId: 'app_clinical', tenantId: 'tenant_harbor', connectionId: 'conn_northstar', registrationId: 'reg_demo', scopes: ['patient/Patient.rs', 'patient/Observation.rs'] };
    expect((await app.inject({ method: 'POST', url: '/api/admin/installations', headers, payload: body })).statusCode).toBe(409);
    const missingScope = await app.inject({ method: 'POST', url: '/api/admin/installations', headers, payload: { ...body, tenantId: 'tenant_northstar', scopes: ['patient/Patient.rs'] } });
    expect(missingScope.statusCode).toBe(400);
    expect(missingScope.json().code).toBe('required_scope_missing');
    const direct = await app.inject({ method: 'POST', url: '/api/admin/installations', headers, payload: { ...body, tenantId: 'tenant_northstar', mode: 'direct' } });
    expect(direct.statusCode).toBe(201); expect(direct.json().allowTokenExport).toBe(true);
    const complementary = await app.inject({ method: 'POST', url: '/api/admin/installations', headers, payload: { ...body, tenantId: 'tenant_northstar', scopes: ['patient/Patient.r', 'patient/Patient.s', 'patient/Observation.r', 'patient/Observation.s'] } });
    expect(complementary.statusCode).toBe(201);
  });

  it('encrypts credentials and exposes only public registration keys', async () => {
    const { app, bridge, repo, headers } = await setup();
    const clientSecret = 'sensitive-upstream-client-secret';
    const registration = await app.inject({ method: 'POST', url: '/api/admin/registrations', headers, payload: { name: 'Confidential', clientId: 'client', authMethod: 'client_secret_post', secret: clientSecret } });
    expect(registration.statusCode).toBe(201); expect(registration.body).not.toContain(clientSecret);
    expect(JSON.stringify(await repo.list('secrets'))).not.toContain(clientSecret);
    expect(await bridge.vault.get(registration.json().secretRef)).toBe(clientSecret);
    const asymmetric = await app.inject({ method: 'POST', url: '/api/admin/registrations', headers, payload: { name: 'Backend', clientId: 'backend', authMethod: 'private_key_jwt' } });
    expect(asymmetric.statusCode).toBe(201);
    const jwks = await app.inject({ url: `/.well-known/jwks/${asymmetric.json().id}` });
    expect(jwks.statusCode).toBe(200); expect(jwks.json().keys[0].alg).toBe('ES384'); expect(jwks.json().keys[0].d).toBeUndefined();
    expect(jwks.body).not.toContain('privateKey');
    const suppliedKey = { ...await bridge.signingKey(), custom_secret: 'must-not-be-published' };
    const imported = await app.inject({ method: 'POST', url: '/api/admin/registrations', headers, payload: { name: 'Imported', clientId: 'imported', authMethod: 'private_key_jwt', privateKey: suppliedKey } });
    expect(imported.statusCode).toBe(201);
    const importedJwks = await app.inject({ url: `/.well-known/jwks/${imported.json().id}` });
    expect(importedJwks.body).not.toContain('must-not-be-published');
  });

  it('rotates application API credentials with one-time delivery', async () => {
    const { app, bridge, headers } = await setup(true);
    const first = await app.inject({ method: 'POST', url: '/api/admin/applications/app_service/credentials', headers });
    const second = await app.inject({ method: 'POST', url: '/api/admin/applications/app_service/credentials', headers });
    expect(first.statusCode).toBe(200); expect(second.json().apiKey).not.toBe(first.json().apiKey);
    expect(await bridge.vault.get('application-key:app_service')).toBe(second.json().apiKey);
    const dashboard = await app.inject({ url: '/api/admin/dashboard', headers });
    expect(dashboard.body).not.toContain(second.json().apiKey);
  });

  it('keeps discovery readiness separate from a launch and generates exact registration URLs', async () => {
    const { app, bridge, headers } = await setup(true);
    const discover = vi.spyOn(bridge, 'discover').mockResolvedValue({ token_endpoint: 'http://localhost:4010/epic/northstar/oauth/token', capabilities: ['launch-ehr'] });
    const verified = await app.inject({ method: 'POST', url: '/api/admin/connections/conn_northstar/verify', headers });
    expect(verified.statusCode).toBe(200); expect(verified.json().status).toBe('verified');
    expect(discover.mock.calls[0]?.[1]?.clientId).toBe('smart-flint-demo');
    const worksheet = (await app.inject({ url: '/api/admin/installations/inst_northstar/worksheet', headers })).json();
    expect(worksheet.launchUrl).toBe('http://localhost:3001/launch/inst_northstar');
    expect(worksheet.redirectUri).toBe('http://localhost:3001/oauth/callback/conn_northstar');
    const dashboard = (await app.inject({ url: '/api/admin/dashboard', headers })).json();
    expect(dashboard.activations).toHaveLength(0);
  });
});

it('redacts clinical context and identity from the administrative dashboard', async () => {
  const { app, bridge, headers } = await setup(true);
  await bridge.establish('inst_northstar', {
    access_token: 'upstream-secret-token', token_type: 'Bearer', expires_in: 600, scope: 'patient/Patient.rs patient/Observation.rs',
    patient: 'sensitive-patient', encounter: 'sensitive-encounter', appContext: 'sensitive-cds-context', smart_style_url: 'https://ehr.example/sensitive-style',
  }, 'http://localhost:4010/epic/northstar/oauth/token', 'gateway', 'interactive', { issuer: 'issuer', subject: 'sensitive-subject' });
  const dashboard = await app.inject({ url: '/api/admin/dashboard', headers });
  expect(dashboard.statusCode).toBe(200);
  expect(dashboard.json().activations[0].context).toEqual({ extensions: {} });
  for (const sensitive of ['upstream-secret-token', 'sensitive-patient', 'sensitive-encounter', 'sensitive-cds-context', 'sensitive-subject', 'sensitive-style']) expect(dashboard.body).not.toContain(sensitive);
});
