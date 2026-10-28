import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { collections, openRepository, SecretVault, storageSchemaVersion, type Repository } from '../packages/storage/src/index.js';
import { createBackup, readPrivateOperationsFile, restoreBackup, rotateEncryptionKey, verifyBackup, writePrivateOperationsFile } from '../scripts/operations.js';

const key = randomBytes(32).toString('base64');
const otherKey = randomBytes(32).toString('base64');
const repositories: Repository[] = [];
const directories: string[] = [];
async function memory() {
  const repository = await openRepository({ sqlitePath: ':memory:' });
  repositories.push(repository); return repository;
}
async function directory() { const path = await mkdtemp(join(tmpdir(), 'flint-operations-')); directories.push(path); return path; }
async function seed(repository: Repository) {
  const vault = new SecretVault(repository, key);
  await repository.put('tenants', { id: 'org', name: 'Private organization metadata' });
  await repository.put('admin_users', { id: 'local-owner', authMethod: 'local', username: 'admin', role: 'platform_admin', disabled: false });
  await repository.put('registrations', { id: 'client', secretRef: 'registration:client:secret' });
  await repository.put('sessions', { id: 'old-browser-session', kind: 'local', expiresAt: new Date(Date.now() + 999999).toISOString() });
  await repository.put('activations', { id: 'old-patient', status: 'active' });
  await repository.put('grants', { id: 'old-patient', generation: 4 });
  await repository.put('transactions', { id: 'old-login' });
  await repository.put('handoffs', { id: 'old-code' });
  await vault.set('registration:client:secret', 'Private OAuth client secret');
  await vault.set('admin-password:local-owner', { version: 'unchanged-password-generation', key: 'slow-password-hash' });
  await vault.set('activation:old-patient', { patient: 'sensitive clinical content' });
  await vault.set('grant:old-patient', { access_token: 'upstream-access', refresh_token: 'upstream-refresh' });
  await vault.set('transaction:old-login', { verifier: 'private-pkce' });
}
afterEach(async () => {
  await Promise.all(repositories.splice(0).map(repo => repo.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('offline deployment recovery', () => {
  it('encrypts the complete logical backup, verifies every vault record and restores static identity while discarding runtime credentials', async () => {
    const source = await memory(), target = await memory();
    await seed(source);
    const original = await source.snapshot();
    const backup = await createBackup({ repository: source, key, offline: true });
    for (const text of ['Private organization metadata', 'Private OAuth', 'sensitive clinical', 'local-owner', 'upstream-refresh', key]) expect(backup).not.toContain(text);
    expect(await verifyBackup({ backup, key })).toMatchObject({ schemaVersion: storageSchemaVersion, source: 'sqlite', records: 13 });
    expect(await restoreBackup({ repository: target, key, backup, offline: true })).toMatchObject({ discardedRuntimeState: true });
    expect(await target.get('tenants', 'org')).toEqual(await source.get('tenants', 'org'));
    expect(await target.get('admin_users', 'local-owner')).toEqual(await source.get('admin_users', 'local-owner'));
    expect(await new SecretVault(target, key).get('registration:client:secret')).toBe('Private OAuth client secret');
    expect(await new SecretVault(target, key).get('admin-password:local-owner')).toEqual({ version: 'unchanged-password-generation', key: 'slow-password-hash' });
    for (const name of ['sessions', 'activations', 'grants', 'transactions', 'handoffs', 'continuations']) expect(await target.list(name)).toEqual([]);
    expect((await target.list<{ id: string }>('secrets')).map(value => value.id).sort()).toEqual(['admin-password:local-owner', 'registration:client:secret']);
    expect((await target.list<{ action: string }>('events')).map(value => value.action)).toContain('operations.backup_restored');
    expect(await source.snapshot()).toEqual(original);
  });

  it('requires offline attestation and refuses wrong keys, modified backups and nonempty restore targets without partial writes', async () => {
    const source = await memory(), target = await memory(); await seed(source);
    await expect(createBackup({ repository: source, key, offline: false })).rejects.toThrow('EVERY');
    const backup = await createBackup({ repository: source, key, offline: true });
    const empty = await target.snapshot();
    await expect(restoreBackup({ repository: target, key: otherKey, backup, offline: true })).rejects.toThrow('verification failed');
    expect(await target.snapshot()).toEqual(empty);
    const tampered = JSON.parse(backup); tampered.ciphertext = `${tampered.ciphertext[0] === 'A' ? 'B' : 'A'}${tampered.ciphertext.slice(1)}`;
    await expect(verifyBackup({ backup: JSON.stringify(tampered), key })).rejects.toThrow('verification failed');
    await expect(restoreBackup({ repository: target, key, backup, offline: false })).rejects.toThrow('EVERY');
    await target.put('tenants', { id: 'keep', name: 'existing deployment' }); const before = await target.snapshot();
    await expect(restoreBackup({ repository: target, key, backup, offline: true })).rejects.toThrow('empty compatible');
    expect(await target.snapshot()).toEqual(before);
  });

  it('rotates all secret envelopes atomically while preserving records, password generations and pre-rotation backup recoverability', async () => {
    const source = await memory(); await seed(source);
    const before = await source.snapshot(), backup = await createBackup({ repository: source, key, offline: true });
    expect(await rotateEncryptionKey({ repository: source, currentKey: key, newKey: otherKey, offline: true })).toEqual({ rotatedSecrets: 5, updateDeploymentKeyBeforeRestart: true });
    const after = await source.snapshot();
    for (const name of collections.filter(value => !['secrets', 'events'].includes(value))) expect(after.collections[name]).toEqual(before.collections[name]);
    expect(after.collections.events).toHaveLength(before.collections.events.length + 1);
    expect(after.collections.events.at(-1)).toMatchObject({ action: 'operations.encryption_key_rotated', actor: { id: 'offline-operator' } });
    expect(after.collections.secrets.map(value => value.id)).toEqual(before.collections.secrets.map(value => value.id));
    expect(after.collections.secrets).not.toEqual(before.collections.secrets);
    expect(await new SecretVault(source, otherKey).get('admin-password:local-owner')).toEqual({ version: 'unchanged-password-generation', key: 'slow-password-hash' });
    await expect(new SecretVault(source, key).get('registration:client:secret')).rejects.toThrow('authentication failed');
    expect(await verifyBackup({ backup, key })).toMatchObject({ records: 13 });
    await expect(verifyBackup({ backup, key: otherKey })).rejects.toThrow('verification failed');
  });

  it('leaves the entire vault unchanged when any envelope fails authentication or its generation changes', async () => {
    const source = await memory(); await seed(source);
    const before = await source.snapshot();
    await expect(rotateEncryptionKey({ repository: source, currentKey: otherKey, newKey: key, offline: true })).rejects.toThrow('rotation failed');
    expect(await source.snapshot()).toEqual(before);
    const broken = { ...before.collections.secrets[0]!, tag: randomBytes(16).toString('base64') };
    await source.put('secrets', broken); const damaged = await source.snapshot();
    await expect(createBackup({ repository: source, key, offline: true })).rejects.toThrow('must authenticate');
    await expect(rotateEncryptionKey({ repository: source, currentKey: key, newKey: otherKey, offline: true })).rejects.toThrow('rotation failed');
    expect(await source.snapshot()).toEqual(damaged);
    const current = await memory(); await seed(current);
    const expected = (await current.snapshot()).collections.secrets;
    await new SecretVault(current, key).set('concurrent-secret', 'changed');
    const changed = await current.snapshot();
    await expect(current.replaceSecrets(expected, expected)).rejects.toThrow('vault changed');
    expect(await current.snapshot()).toEqual(changed);
    const protectedRepository = await memory(); await seed(protectedRepository);
    await protectedRepository.put('events', { id: 'audit-conflict', action: 'existing' });
    const protectedBefore = await protectedRepository.snapshot();
    const replacement = protectedBefore.collections.secrets.map(record => ({ ...record, tag: randomBytes(16).toString('base64') }));
    await expect(protectedRepository.replaceSecrets(protectedBefore.collections.secrets, replacement, { id: 'audit-conflict' })).rejects.toThrow();
    expect(await protectedRepository.snapshot()).toEqual(protectedBefore);
  });

  it('atomically publishes private files without overwriting existing files or following final symlinks', async () => {
    const dir = await directory(), file = join(dir, 'backup');
    await writePrivateOperationsFile(file, 'encrypted content');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readPrivateOperationsFile(file, 100)).toBe('encrypted content');
    await expect(writePrivateOperationsFile(file, 'overwrite')).rejects.toThrow('never overwritten');
    expect(await readFile(file, 'utf8')).toBe('encrypted content');
    const alias = join(dir, 'alias'); await symlink(file, alias);
    await expect(readPrivateOperationsFile(alias, 100)).rejects.toThrow('nonsymlink');
    await expect(writePrivateOperationsFile(alias, 'overwrite')).rejects.toThrow('never overwritten');
    await chmod(file, 0o644);
    await expect(readPrivateOperationsFile(file, 100)).rejects.toThrow('0600');
    await chmod(file, 0o600);
    await expect(readPrivateOperationsFile(file, 5)).rejects.toThrow('supported size');
    await chmod(dir, 0o777);
    await expect(writePrivateOperationsFile(join(dir, 'shared-directory'), 'private')).rejects.toThrow('non-shared-writable');
  });

  it('adopts an unversioned SQLite registry once, preserves original records and refuses newer or altered migration histories', async () => {
    const dir = await directory(), path = join(dir, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec('CREATE TABLE smart_flint_tenants (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    legacy.prepare('INSERT INTO smart_flint_tenants VALUES (?, ?)').run('org', JSON.stringify({ id: 'org', name: 'preserve legacy configuration' }));
    legacy.close();
    const first = await openRepository({ sqlitePath: path });
    expect(await first.get('tenants', 'org')).toEqual({ id: 'org', name: 'preserve legacy configuration' }); await first.close();
    const second = await openRepository({ sqlitePath: path });
    expect((await second.snapshot()).schemaVersion).toBe(1); await second.close();
    const future = new DatabaseSync(path);
    expect(future.prepare('SELECT COUNT(*) AS n FROM smart_flint_schema_migrations').get()?.n).toBe(1);
    future.prepare('INSERT INTO smart_flint_schema_migrations VALUES (?, ?, ?)').run(99, 'future-release', new Date().toISOString()); future.close();
    await expect(openRepository({ sqlitePath: path })).rejects.toThrow('newer than');
    const damaged = new DatabaseSync(path); damaged.exec('DELETE FROM smart_flint_schema_migrations WHERE version=99');
    damaged.exec("UPDATE smart_flint_schema_migrations SET name='altered-history'"); damaged.close();
    await expect(openRepository({ sqlitePath: path })).rejects.toThrow('history is invalid');
  });

  it('rejects unknown collection/schema/duplicate records before restoring anything', async () => {
    const source = await memory(), target = await memory(); await seed(source);
    const snapshot = await source.snapshot(); snapshot.schemaVersion = 99;
    await expect(target.restoreSnapshot(snapshot)).rejects.toThrow('snapshot schema');
    snapshot.schemaVersion = storageSchemaVersion;
    snapshot.collections.tenants.push(snapshot.collections.tenants[0]!);
    await expect(target.restoreSnapshot(snapshot)).rejects.toThrow('Duplicate record');
    expect((await target.snapshot()).collections.tenants).toEqual([]);
  });

  it('runs the real CLI for backup, verify, empty-target restore and key rotation without printing credentials', async () => {
    const dir = await directory(), sourcePath = join(dir, 'source.sqlite'), targetPath = join(dir, 'recovered.sqlite');
    const backup = join(dir, 'deployment.backup'), beforeRotation = join(dir, 'before-rotation.backup'), newKeyFile = join(dir, 'new.key');
    const source = await openRepository({ sqlitePath: sourcePath }); await seed(source); await source.close();
    await writeFile(newKeyFile, `${otherKey}\n`, { mode: 0o600 });
    const environment = { ...process.env, DEMO_MODE: 'false', NODE_ENV: 'production', ADMIN_AUTH_MODE: 'local',
      BASE_URL: 'https://operations.example', CONSOLE_URL: 'https://operations.example', ENCRYPTION_KEY: key,
      ADMIN_BOOTSTRAP_ENABLED: 'false', SQLITE_PATH: sourcePath, DATABASE_URL: '' };
    const run = async (args: string[], env = environment) => {
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/operations.ts', ...args], { cwd: process.cwd(), env });
      for (const secret of [key, otherKey, 'Private organization metadata', 'Private OAuth client secret', 'upstream-refresh']) expect(result.stdout + result.stderr).not.toContain(secret);
      return result.stdout;
    };
    expect(await run(['backup', '--offline', '--output', backup])).toContain('created and verified');
    expect(await run(['verify', '--input', backup])).toContain('No database was opened');
    expect(await run(['restore', '--offline', '--input', backup], { ...environment, SQLITE_PATH: targetPath })).toContain('Previous sessions');
    expect(await run(['rotate-key', '--offline', '--new-key-file', newKeyFile, '--output', beforeRotation])).toContain('BEFORE restarting');
    const rotated = await openRepository({ sqlitePath: sourcePath });
    try { expect(await new SecretVault(rotated, otherKey).get('registration:client:secret')).toBe('Private OAuth client secret'); }
    finally { await rotated.close(); }
    await expect(run(['backup', '--output', join(dir, 'refused.backup')])).rejects.toThrow('EVERY');
  });
});

describe.skipIf(!process.env.SMART_FLINT_TEST_DATABASE_URL)('PostgreSQL offline operations', () => {
  async function isolated() {
    const admin = new Pool({ connectionString: process.env.SMART_FLINT_TEST_DATABASE_URL });
    const schema = `ops_${randomBytes(12).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.SMART_FLINT_TEST_DATABASE_URL!); url.searchParams.set('options', `-c search_path=${schema}`);
    const repository = await openRepository({ databaseUrl: url.href });
    return { repository, admin, schema, url: url.href, async close() { await repository.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
  }

  it('restores SQLite snapshots into an empty PostgreSQL database and refuses an occupied target without partial changes', async () => {
    const source = await memory(); await seed(source);
    const pg = await isolated();
    try {
      const backup = await createBackup({ repository: source, key, offline: true });
      await restoreBackup({ repository: pg.repository, key, backup, offline: true });
      expect(await pg.repository.get('tenants', 'org')).toEqual(await source.get('tenants', 'org'));
      expect(await new SecretVault(pg.repository, key).get('registration:client:secret')).toBe('Private OAuth client secret');
      const before = await pg.repository.snapshot();
      await expect(restoreBackup({ repository: pg.repository, key, backup, offline: true })).rejects.toThrow('empty compatible');
      expect(await pg.repository.snapshot()).toEqual(before);
    } finally { await pg.close(); }
  });

  it('produces portable snapshots and rotates the shared vault with old-key failure and independent-pool verification', async () => {
    const pg = await isolated(); let second: Repository | undefined;
    try {
      await seed(pg.repository);
      const backup = await createBackup({ repository: pg.repository, key, offline: true });
      expect(await verifyBackup({ backup, key })).toMatchObject({ source: 'postgres', records: 13 });
      const local = await memory(); await restoreBackup({ repository: local, key, backup, offline: true });
      expect(await new SecretVault(local, key).get('registration:client:secret')).toBe('Private OAuth client secret');
      const before = await pg.repository.snapshot();
      await expect(rotateEncryptionKey({ repository: pg.repository, currentKey: otherKey, newKey: key, offline: true })).rejects.toThrow('rotation failed');
      expect(await pg.repository.snapshot()).toEqual(before);
      await pg.repository.put('events', { id: 'audit-conflict', action: 'existing' });
      const protectedBefore = await pg.repository.snapshot();
      const replacement = protectedBefore.collections.secrets.map(record => ({ ...record, tag: randomBytes(16).toString('base64') }));
      await expect(pg.repository.replaceSecrets(protectedBefore.collections.secrets, replacement, { id: 'audit-conflict' })).rejects.toThrow();
      expect(await pg.repository.snapshot()).toEqual(protectedBefore);
      await rotateEncryptionKey({ repository: pg.repository, currentKey: key, newKey: otherKey, offline: true });
      second = await openRepository({ databaseUrl: pg.url });
      expect(await new SecretVault(second, otherKey).get('grant:old-patient')).toEqual({ access_token: 'upstream-access', refresh_token: 'upstream-refresh' });
      await expect(new SecretVault(second, key).get('grant:old-patient')).rejects.toThrow('authentication failed');
    } finally { await second?.close(); await pg.close(); }
  });

  it('refuses a future PostgreSQL schema before initializing collections', async () => {
    const pg = await isolated();
    try {
      await pg.admin.query(`INSERT INTO ${pg.schema}.smart_flint_schema_migrations VALUES (99, 'future-release', $1)`, [new Date().toISOString()]);
      await expect(openRepository({ databaseUrl: pg.url })).rejects.toThrow('newer than');
    } finally { await pg.close(); }
  });
});
