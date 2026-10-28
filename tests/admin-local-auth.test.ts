import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminUser } from '../packages/contracts/src/index.js';
import { digest, openRepository, type Repository } from '../packages/storage/src/index.js';
import { Bridge } from '../apps/server/src/bridge.js';
import { loadConfig, type Config } from '../apps/server/src/config.js';
import { authenticateAdmin, bootstrapAllowed, registerAdminAuthentication } from '../apps/server/src/admin-auth.js';
import { getLocalPasswordRecord, normalizeUsername, setLocalPassword, validateAdminPassword, verifyLocalPassword } from '../apps/server/src/admin-passwords.js';
import { Problem } from '../apps/server/src/errors.js';

const origin = 'https://flint.example';
const password = 'A long, unique test passphrase 47!';
const nextPassword = 'Another long test passphrase 82!';
const bootstrapToken = 'synthetic-bootstrap-local-auth-test-123456789';
const owned: { apps: FastifyInstance[]; bridge: Bridge; repo: Repository }[] = [];

afterEach(async () => {
  for (const resource of owned.splice(0)) {
    for (const app of resource.apps) await app.close();
    await resource.bridge.http.close(); await resource.repo.close();
  }
});

async function authApp(bridge: Bridge) {
  const app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => error instanceof Problem
    ? reply.code(error.status).send({ code: error.code, message: error.message })
    : reply.code(500).send({ code: 'internal_error' }));
  registerAdminAuthentication(app, bridge);
  app.get('/protected', async (request, reply) => {
    const principal = await authenticateAdmin(bridge, request);
    return principal ? { identity: principal.identity } : reply.code(401).send({ code: 'authentication_required' });
  });
  await app.ready();
  return app;
}

async function setup(overrides: Partial<Config> = {}) {
  const config = loadConfig({ demo: false, adminAuthMode: 'local', baseUrl: origin, consoleUrl: origin, host: '127.0.0.1',
    databaseUrl: undefined, sqlitePath: ':memory:', encryptionKey: randomBytes(32).toString('base64'),
    adminToken: bootstrapToken, adminBootstrapEnabled: true, adminOidc: undefined, ...overrides });
  const repo = await openRepository({ sqlitePath: ':memory:' });
  const bridge = new Bridge(repo, config), app = await authApp(bridge);
  const resources = { apps: [app], bridge, repo }; owned.push(resources);
  return { app, bridge, repo, config, resources };
}

async function provision(bridge: Bridge, overrides: Partial<AdminUser> = {}, secret = password): Promise<AdminUser> {
  const user: AdminUser = { id: 'local-owner', authMethod: 'local', username: 'owner', displayName: 'Local Owner', role: 'platform_admin',
    organizationIds: [], applicationIds: [], disabled: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
  await bridge.repo.withLock('admin:write', async () => { await setLocalPassword(bridge, user.id, secret); await bridge.repo.put('admin_users', user); });
  return user;
}

async function signIn(app: FastifyInstance, username = 'owner', secret = password) {
  return app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { username, password: secret } });
}

function sessionCookie(response: Awaited<ReturnType<typeof signIn>>) {
  const item = response.cookies.find(value => value.name === 'smart_flint_admin');
  expect(item).toBeDefined();
  return `smart_flint_admin=${item!.value}`;
}

describe('local administrative password credentials', () => {
  it('normalizes only ASCII usernames and validates length, Unicode, whitespace and weak passwords without truncation', () => {
    expect(normalizeUsername('  Owner.User-1_  ')).toBe('owner.user-1_');
    for (const value of ['', '_owner', 'owner user', 'jörg', 'K', 'Kevin', '\ud800', 'x'.repeat(65), null]) expect(() => normalizeUsername(value)).toThrow();
    for (const value of ['short', ' '.repeat(20), 'passwordpassword', 'a'.repeat(20), 'x'.repeat(129), '\ud800'.repeat(15)])
      expect(() => validateAdminPassword(value)).toThrow();
    expect(() => validateAdminPassword(`${'🪨'.repeat(14)}!`)).not.toThrow();
    expect(() => validateAdminPassword(' unique phrase with spaces ')).not.toThrow();
    expect(() => validateAdminPassword(`${'界'.repeat(127)}!`)).not.toThrow();
  });

  it('uses independent salted slow hashes in the encrypted vault, preserves password characters and rotates credential versions', async () => {
    const { bridge, repo } = await setup();
    await provision(bridge, {}, ` ${password} `);
    await provision(bridge, { id: 'local-second', username: 'second' }, ` ${password} `);
    const first = await getLocalPasswordRecord(bridge, 'local-owner'), second = await getLocalPasswordRecord(bridge, 'local-second');
    expect(first).toMatchObject({ format: 'scrypt-v1' });
    expect(first!.salt).not.toBe(second!.salt); expect(first!.key).not.toBe(second!.key); expect(first!.version).not.toBe(second!.version);
    expect(await verifyLocalPassword(bridge, 'local-owner', ` ${password} `)).toBe(true);
    expect(await verifyLocalPassword(bridge, 'local-owner', password)).toBe(false);
    const persisted = JSON.stringify({ users: await repo.list('admin_users'), secrets: await repo.list('secrets'), events: await repo.list('events') });
    expect(persisted).not.toContain(password); expect(persisted).not.toContain(first!.key); expect(persisted).not.toContain(first!.salt);
    await setLocalPassword(bridge, 'local-owner', nextPassword);
    expect((await getLocalPasswordRecord(bridge, 'local-owner'))!.version).not.toBe(first!.version);
    await bridge.vault.set('admin-password:local-owner', { ...first!, format: 'scrypt-unknown', N: 2 ** 30 });
    expect(await getLocalPasswordRecord(bridge, 'local-owner')).toBeUndefined();
    expect(await verifyLocalPassword(bridge, 'local-owner', ` ${password} `)).toBe(false);
  });
});

describe('local administrative sign-in boundary', () => {
  it('cuts off bootstrap as soon as the first mode-matching owner exists, including with a missing credential', async () => {
    const { app, bridge, repo } = await setup();
    expect(await bootstrapAllowed(bridge)).toBe(true);
    const bootstrap = await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { token: bootstrapToken } });
    expect(bootstrap.statusCode).toBe(200);
    const oldCookie = sessionCookie(bootstrap);
    await repo.put('admin_users', { id: 'other-mode-owner', issuer: 'https://identity.example', subject: 'owner', displayName: 'SSO Owner',
      role: 'platform_admin', organizationIds: [], applicationIds: [], disabled: false, createdAt: '', updatedAt: '' });
    expect(await bootstrapAllowed(bridge)).toBe(true);
    await provision(bridge);
    expect(await bootstrapAllowed(bridge)).toBe(false);
    expect((await app.inject({ url: '/api/admin/session', headers: { cookie: oldCookie } })).json().authenticated).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { token: bootstrapToken } })).statusCode).toBe(401);
    await bridge.vault.delete('admin-password:local-owner');
    expect(await bootstrapAllowed(bridge)).toBe(false);
  });

  it('uses a version-bound HttpOnly session and reads current roles, assignments and account status on every request', async () => {
    const { app, bridge, repo } = await setup();
    const user = await provision(bridge, { username: 'kevin' });
    expect((await signIn(app, 'Kevin')).statusCode).toBe(401);
    const result = await signIn(app, '  KEVIN  ');
    expect(result.statusCode).toBe(200);
    expect(result.json().identity).toMatchObject({ kind: 'local', username: 'kevin', id: user.id });
    const cookie = sessionCookie(result);
    expect(String(result.headers['set-cookie'])).toMatch(/HttpOnly/); expect(String(result.headers['set-cookie'])).toMatch(/Secure/);
    expect(String(result.headers['set-cookie'])).toMatch(/SameSite=Strict/);
    const sessions = await repo.list<{ id: string; passwordVersion: string }>('sessions');
    expect(sessions[0]!.passwordVersion).toBe((await getLocalPasswordRecord(bridge, user.id))!.version);
    expect(JSON.stringify(sessions)).not.toContain(cookie.split('=')[1]!);
    await repo.put('admin_users', { ...user, role: 'viewer', applicationIds: ['app-a'] });
    expect((await app.inject({ url: '/protected', headers: { cookie } })).json().identity).toMatchObject({ role: 'viewer', applicationIds: ['app-a'] });
    await repo.put('admin_users', { ...user, disabled: true });
    expect((await app.inject({ url: '/protected', headers: { cookie } })).statusCode).toBe(401);
  });

  it('returns the same fixed failure for wrong passwords, unknown accounts and disabled accounts without retaining attempted secrets', async () => {
    const { app, bridge, repo } = await setup();
    const user = await provision(bridge);
    const wrong = await signIn(app, 'owner', 'wrong-but-long-password');
    const unknown = await signIn(app, 'does-not-exist', 'wrong-but-long-password');
    await repo.put('admin_users', { ...user, disabled: true });
    const disabled = await signIn(app);
    expect(wrong.statusCode).toBe(401); expect(unknown.statusCode).toBe(401); expect(disabled.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json()); expect(wrong.json()).toEqual(disabled.json());
    expect(await repo.list('sessions')).toHaveLength(0);
    const audit = JSON.stringify(await repo.list('events'));
    expect(audit).not.toContain('does-not-exist'); expect(audit).not.toContain('wrong-but-long-password'); expect(audit).not.toContain(password);
    expect((await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { username: 'owner', password, token: bootstrapToken } })).statusCode).toBe(400);
    expect((await signIn(app, 'owner', password)).headers['set-cookie']).toBeUndefined();
  });

  it('suppresses passwordless demo access and OIDC endpoints when local mode is explicitly selected with demo data', async () => {
    const { app, bridge, repo } = await setup({ demo: true, adminOidc: { issuer: 'https://identity.example', clientId: 'console', authMethod: 'none', allowedOrigins: ['https://identity.example'], label: 'SSO' } });
    await provision(bridge);
    const status = (await app.inject({ url: '/api/admin/session' })).json();
    expect(status).toMatchObject({ authMode: 'local', localEnabled: true, demo: true, oidcEnabled: false, bootstrapEnabled: false });
    expect((await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { token: '' } })).statusCode).toBe(401);
    await repo.put('sessions', { id: `admin:${digest('old-demo')}`, kind: 'demo', expiresAt: new Date(Date.now() + 60000).toISOString() });
    expect((await app.inject({ url: '/protected', headers: { cookie: 'smart_flint_admin=old-demo' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/oidc/login' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/admin/oidc/callback' })).statusCode).toBe(404);
    expect((await signIn(app)).statusCode).toBe(200);
  });

  it('rejects native credentials, existing native sessions and password changes after selecting OIDC mode', async () => {
    const { app, bridge } = await setup();
    await provision(bridge);
    const cookie = sessionCookie(await signIn(app));
    bridge.config.adminAuthMode = 'oidc';
    bridge.config.adminOidc = { issuer: 'https://identity.example', clientId: 'console', authMethod: 'none', allowedOrigins: ['https://identity.example'], label: 'SSO' };
    expect((await signIn(app)).statusCode).toBe(401);
    expect((await app.inject({ url: '/protected', headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/admin/password', headers: { cookie, origin }, payload: { currentPassword: password, newPassword: nextPassword } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/admin/session' })).json()).toMatchObject({ authMode: 'oidc', localEnabled: false, oidcEnabled: true });
  });

  it('persists normalized account throttling across handler instances and clears the expired window on successful sign-in', async () => {
    const { app, bridge, repo, resources } = await setup();
    await provision(bridge);
    for (let attempt = 0; attempt < 3; attempt++) expect((await signIn(app, 'OWNER', 'wrong password attempt')).statusCode).toBe(401);
    const secondApp = await authApp(bridge); resources.apps.push(secondApp);
    for (let attempt = 0; attempt < 2; attempt++) expect((await signIn(secondApp, ' owner ', 'wrong password attempt')).statusCode).toBe(401);
    const throttled = await signIn(secondApp);
    expect(throttled.statusCode).toBe(429); expect(throttled.headers['retry-after']).toBe('900');
    const attempts = await repo.get<{ id: string; attempts: number; expiresAt: string }>('replays', `admin-login:${digest('owner')}`);
    expect(attempts!.attempts).toBe(5); expect(JSON.stringify(attempts)).not.toContain('owner');
    await repo.put('replays', { ...attempts!, expiresAt: new Date(Date.now() - 1).toISOString() });
    expect((await signIn(secondApp)).statusCode).toBe(200);
    expect(await repo.get('replays', attempts!.id)).toBeUndefined();
  });
});

describe('local administrative self-service password change', () => {
  it('lets a viewer change their own password after current-password verification and revokes every prior local session', async () => {
    const { app, bridge, repo } = await setup();
    const user = await provision(bridge, { role: 'viewer' });
    const cookie = sessionCookie(await signIn(app)), otherCookie = sessionCookie(await signIn(app));
    const change = (currentPassword: string, newPassword = nextPassword, suppliedOrigin: string | null = origin) => app.inject({ method: 'POST',
      url: '/api/admin/password', headers: { cookie, ...(suppliedOrigin ? { origin: suppliedOrigin } : {}) }, payload: { currentPassword, newPassword } });
    expect((await change(password, nextPassword, null)).statusCode).toBe(403);
    expect((await change(password, nextPassword, 'https://unapproved.example')).statusCode).toBe(403);
    expect((await change('wrong current password')).statusCode).toBe(401);
    expect((await change(password, 'too short')).statusCode).toBe(400);
    expect((await app.inject({ url: '/protected', headers: { cookie } })).statusCode).toBe(200);
    await repo.put('replays', { id: `admin-login:${digest('owner')}`, attempts: 5, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const changed = await change(password);
    expect(changed.statusCode).toBe(200); expect(changed.json()).toEqual({ changed: true, reauthenticationRequired: true });
    expect(String(changed.headers['set-cookie'])).toContain('Max-Age=0');
    expect(await repo.get('replays', `admin-login:${digest('owner')}`)).toBeUndefined();
    for (const old of [cookie, otherCookie]) expect((await app.inject({ url: '/protected', headers: { cookie: old } })).statusCode).toBe(401);
    expect((await signIn(app)).statusCode).toBe(401);
    expect((await signIn(app, 'owner', nextPassword)).statusCode).toBe(200);
    const events = await repo.list<{ action: string; actor?: { id: string; kind: string }; resource?: { id: string } }>('events');
    expect(events.find(event => event.action === 'admin.password_changed')).toMatchObject({ actor: { id: user.id, kind: 'local' }, resource: { id: user.id } });
    expect(JSON.stringify(events)).not.toContain(password); expect(JSON.stringify(events)).not.toContain(nextPassword);
  });
});
