import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminUser, AuditEvent } from '../packages/contracts/src/index.js';
import { digest, openRepository, type Repository } from '../packages/storage/src/index.js';
import { Bridge } from '../apps/server/src/bridge.js';
import { loadConfig, projectRoot, type Config } from '../apps/server/src/config.js';
import { registerAdminAuthentication } from '../apps/server/src/admin-auth.js';
import { getLocalPasswordRecord, setLocalPassword, verifyLocalPassword } from '../apps/server/src/admin-passwords.js';
import { Problem } from '../apps/server/src/errors.js';
import { parseRecoveryArguments, readRecoveryPasswordFile, resetLocalAdminPassword } from '../scripts/admin-reset-password.js';

const origin = 'https://flint.example';
const initialPassword = 'Synthetic recovery starting phrase 3481';
const replacementPassword = 'Synthetic replacement recovery phrase 6529';
const owned: { app: FastifyInstance; bridge: Bridge; repository: Repository }[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) { await item.app.close(); await item.bridge.http.close(); await item.repository.close(); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup(overrides: Partial<AdminUser> = {}) {
  const config = loadConfig({ demo: false, adminAuthMode: 'local', adminOidc: undefined,
    baseUrl: origin, consoleUrl: origin, host: '127.0.0.1', databaseUrl: undefined, sqlitePath: ':memory:',
    encryptionKey: randomBytes(32).toString('base64'), adminToken: '', adminBootstrapEnabled: false });
  const repository = await openRepository({ sqlitePath: ':memory:' });
  const bridge = new Bridge(repository, config);
  const app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof Problem ? error.status : 500)
    .send({ code: error instanceof Problem ? error.code : 'internal_error' }));
  registerAdminAuthentication(app, bridge);
  await app.ready();
  owned.push({ app, bridge, repository });
  const user: AdminUser = { id: 'local-recovery-fixture', authMethod: 'local', username: 'operator', displayName: 'Recovery test operator',
    role: 'platform_admin', organizationIds: ['organization-a'], applicationIds: ['application-a'], disabled: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
  await repository.put('admin_users', user);
  return { app, bridge, repository, config, user };
}

async function privateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'smart-flint-admin-recovery-'));
  directories.push(directory);
  return directory;
}

describe('offline local administrative password recovery', () => {
  it('rotates the encrypted credential, revokes prior sessions, and preserves the account and its assignments', async () => {
    const { app, bridge, repository, config, user } = await setup();
    await setLocalPassword(bridge, user.id, initialPassword);
    const previous = await getLocalPasswordRecord(bridge, user.id);
    const login = await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { username: user.username, password: initialPassword } });
    expect(login.statusCode).toBe(200);
    const sessionCookie = login.cookies.find(item => item.name === 'smart_flint_admin')!;
    expect(sessionCookie).toBeDefined();
    const headers = { cookie: `smart_flint_admin=${sessionCookie.value}` };
    expect((await app.inject({ url: '/api/admin/session', headers })).json().authenticated).toBe(true);
    const loginCounter = `admin-login:${digest(user.username!)}`;
    const changeCounter = `admin-password-change:${digest(user.id)}`;
    for (const id of [loginCounter, changeCounter]) await repository.put('replays', { id, expiresAt: new Date(Date.now() + 900_000).toISOString(), count: 5 });
    const lock = vi.spyOn(repository, 'withLock');
    const result = await resetLocalAdminPassword({ config, username: ' Operator ', password: replacementPassword, offline: true, repository });
    expect(result).toEqual({ userId: user.id, username: 'operator' });
    expect(lock).toHaveBeenCalledWith('admin:write', expect.any(Function));
    const current = await getLocalPasswordRecord(bridge, user.id);
    expect(current?.version).toBeTruthy();
    expect(current?.version).not.toBe(previous?.version);
    expect(await verifyLocalPassword(bridge, user.id, initialPassword)).toBe(false);
    expect(await verifyLocalPassword(bridge, user.id, replacementPassword)).toBe(true);
    expect(await repository.get('admin_users', user.id)).toEqual(user);
    expect(await repository.get('replays', loginCounter)).toBeUndefined();
    expect(await repository.get('replays', changeCounter)).toBeUndefined();
    expect((await app.inject({ url: '/api/admin/session', headers })).json().authenticated).toBe(false);
    const newLogin = await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { username: user.username, password: replacementPassword } });
    expect(newLogin.statusCode).toBe(200);
    const events = await repository.list<AuditEvent>('events');
    expect(events.find(event => event.action === 'admin.password_reset')).toMatchObject({
      outcome: 'success', actor: { id: 'local-recovery', displayName: 'Local recovery operator', kind: 'bootstrap', role: 'platform_admin' },
      resource: { type: 'admin_users', id: user.id },
    });
    const protectedStorage = JSON.stringify({ users: await repository.list('admin_users'), events, secrets: await repository.list('secrets') });
    const stored = JSON.stringify({ protectedStorage, sessions: await repository.list('sessions') });
    for (const secret of [initialPassword, replacementPassword, sessionCookie.value]) expect(stored).not.toContain(secret);
    expect(protectedStorage).not.toContain(current!.version);
  }, 15_000);

  it('keeps a disabled account disabled without changing its role or assigned resources', async () => {
    const { app, bridge, repository, config, user } = await setup({ disabled: true, role: 'viewer' });
    await setLocalPassword(bridge, user.id, initialPassword);
    await resetLocalAdminPassword({ config, username: user.username!, password: replacementPassword, offline: true, repository });
    expect(await repository.get('admin_users', user.id)).toEqual(user);
    expect(await verifyLocalPassword(bridge, user.id, replacementPassword)).toBe(true);
    const login = await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin }, payload: { username: user.username, password: replacementPassword } });
    expect(login.statusCode).toBe(401);
    expect(await repository.list('sessions')).toEqual([]);
  }, 10_000);

  it('requires offline attestation and local mode, and cannot create an account or reset an OIDC identity', async () => {
    const { repository, config, user } = await setup();
    const reset = (options: Partial<{ config: Config; username: string; password: string; offline: boolean }> = {}) =>
      resetLocalAdminPassword({ config, username: user.username!, password: replacementPassword, offline: true, repository, ...options });
    await expect(reset({ offline: false })).rejects.toThrow('Stop every SMART Flint instance');
    await expect(reset({ config: { ...config, adminAuthMode: 'oidc' } })).rejects.toThrow('ADMIN_AUTH_MODE=local');
    await expect(reset({ config: { ...config, demo: true, adminAuthMode: undefined } })).rejects.toThrow('ADMIN_AUTH_MODE=local');
    await expect(reset({ username: 'missing-operator' })).rejects.toThrow('existing local account');
    await expect(reset({ username: 'bad username!' })).rejects.toThrow('existing local username');
    await expect(reset({ password: 'short' })).rejects.toThrow('15–128');
    await repository.put('admin_users', { ...user, authMethod: 'oidc', issuer: 'https://identity.example', subject: 'subject-a' });
    await expect(reset()).rejects.toThrow('existing local account');
    expect(await repository.list('secrets')).toEqual([]);
    expect(await repository.list('events')).toEqual([]);
    expect(await repository.list('admin_users')).toHaveLength(1);
  });

  it('refuses ambiguous local usernames without modifying either credential', async () => {
    const { repository, config, user } = await setup();
    await repository.put('admin_users', { ...user, id: 'duplicate', username: 'OPERATOR' });
    await expect(resetLocalAdminPassword({ config, username: 'operator', password: replacementPassword, offline: true, repository }))
      .rejects.toThrow('unambiguous existing local account');
    expect(await repository.list('secrets')).toEqual([]);
    expect(await repository.list('events')).toEqual([]);
  });

  it('sanitizes database and encryption failures without exposing raw driver details', async () => {
    const { repository, config, user } = await setup();
    vi.spyOn(repository, 'list').mockRejectedValueOnce(new Error('synthetic-driver-credential-detail'));
    await expect(resetLocalAdminPassword({ config, username: user.username!, password: replacementPassword, offline: true, repository }))
      .rejects.toThrow('Check the deployment configuration, encryption key, and database access.');
  });

  it('runs the CLI against an offline temporary database and requires a private file when no terminal is available', async () => {
    const directory = await privateDirectory();
    const sqlitePath = join(directory, 'recovery.sqlite');
    const passwordFile = join(directory, 'replacement-password');
    const encryptionKey = randomBytes(32).toString('base64');
    const config = loadConfig({ demo: false, adminAuthMode: 'local', adminOidc: undefined,
      baseUrl: origin, consoleUrl: origin, host: '127.0.0.1', databaseUrl: undefined, sqlitePath,
      encryptionKey, adminToken: '', adminBootstrapEnabled: false });
    const user: AdminUser = { id: 'cli-recovery-operator', authMethod: 'local', username: 'operator', displayName: 'CLI recovery fixture',
      role: 'platform_admin', organizationIds: [], applicationIds: [], disabled: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const initialRepository = await openRepository({ sqlitePath });
    const initialBridge = new Bridge(initialRepository, config);
    try { await initialRepository.put('admin_users', user); await setLocalPassword(initialBridge, user.id, initialPassword); }
    finally { await initialBridge.http.close(); await initialRepository.close(); }
    await writeFile(passwordFile, `${replacementPassword}\n`, { mode: 0o600 });
    const env = { ...process.env, DEMO_MODE: 'false', ADMIN_AUTH_MODE: 'local', BASE_URL: origin, CONSOLE_URL: origin,
      HOST: '127.0.0.1', ENCRYPTION_KEY: encryptionKey, SQLITE_PATH: sqlitePath, DATABASE_URL: '', RETENTION_HOURS: '24',
      ADMIN_BOOTSTRAP_ENABLED: 'false', ADMIN_TOKEN: '', ADMIN_OIDC_ISSUER: '', ADMIN_OIDC_CLIENT_ID: '', ADMIN_OIDC_CLIENT_SECRET: '' };
    const args = ['--import', 'tsx', 'scripts/admin-reset-password.ts', '--offline', '--username', user.username!];
    const noninteractive = spawnSync(process.execPath, args, { cwd: projectRoot, env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(noninteractive.status).toBe(1);
    expect(noninteractive.stderr).toContain('An interactive terminal is required');
    const result = spawnSync(process.execPath, [...args, '--password-file', passwordFile], { cwd: projectRoot, env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Password reset. Earlier local sessions are invalid.');
    expect(`${result.stdout}${result.stderr}`).not.toContain(replacementPassword);
    const repository = await openRepository({ sqlitePath });
    const bridge = new Bridge(repository, config);
    try {
      expect(await verifyLocalPassword(bridge, user.id, initialPassword)).toBe(false);
      expect(await verifyLocalPassword(bridge, user.id, replacementPassword)).toBe(true);
      expect(await repository.get('admin_users', user.id)).toEqual(user);
      expect((await repository.list<AuditEvent>('events')).find(event => event.action === 'admin.password_reset')?.actor?.id).toBe('local-recovery');
    } finally { await bridge.http.close(); await repository.close(); }
  }, 15_000);
});

describe('recovery password input', () => {
  it('preserves password whitespace and removes only one optional final line ending', async () => {
    const directory = await privateDirectory();
    const path = join(directory, 'password');
    for (const [input, expected] of [['  synthetic pass phrase  \r\n', '  synthetic pass phrase  '], ['  synthetic pass phrase  ', '  synthetic pass phrase  '], ['\uFEFFsynthetic pass phrase\n', '\uFEFFsynthetic pass phrase'], ['synthetic pass phrase\n\n', 'synthetic pass phrase\n']]) {
      await writeFile(path, input!, { mode: 0o600 });
      expect(await readRecoveryPasswordFile(path)).toBe(expected);
    }
    await chmod(path, 0o400);
    expect(await readRecoveryPasswordFile(path)).toBe('synthetic pass phrase\n');
  });

  it('refuses shared, executable, symlink, nonregular, oversized, and invalid UTF-8 files', async () => {
    const directory = await privateDirectory();
    const path = join(directory, 'password');
    await writeFile(path, replacementPassword, { mode: 0o644 });
    await expect(readRecoveryPasswordFile(path)).rejects.toThrow('0600');
    await chmod(path, 0o700);
    await expect(readRecoveryPasswordFile(path)).rejects.toThrow('0600');
    await chmod(path, 0o600);
    const symbolic = join(directory, 'link');
    await symlink(path, symbolic);
    await expect(readRecoveryPasswordFile(symbolic)).rejects.toThrow('nonsymlink');
    const subdirectory = join(directory, 'directory');
    await mkdir(subdirectory, { mode: 0o700 });
    await expect(readRecoveryPasswordFile(subdirectory)).rejects.toThrow('regular file');
    await writeFile(path, Buffer.alloc(2049));
    await expect(readRecoveryPasswordFile(path)).rejects.toThrow('2048');
    await writeFile(path, Buffer.from([0xc3, 0x28]));
    await expect(readRecoveryPasswordFile(path)).rejects.toThrow('read securely');
  });

  it('accepts only explicit offline recovery arguments and never accepts a password argument', () => {
    expect(parseRecoveryArguments(['--offline', '--username', 'operator', '--password-file', '/private/password']))
      .toEqual({ offline: true, username: 'operator', passwordFile: '/private/password', help: false });
    expect(parseRecoveryArguments(['--help']).help).toBe(true);
    expect(() => parseRecoveryArguments(['--username', 'operator'])).toThrow('Stop every SMART Flint instance');
    expect(() => parseRecoveryArguments(['--offline'])).toThrow('--username');
    expect(() => parseRecoveryArguments(['--offline', '--username', '--password-file'])).toThrow('exactly one value');
    expect(() => parseRecoveryArguments(['--offline', '--username', 'operator', '--password', replacementPassword])).toThrow('must never be supplied');
    expect(() => parseRecoveryArguments(['--offline', '--offline', '--username', 'operator'])).toThrow('repeated');
  });
});
