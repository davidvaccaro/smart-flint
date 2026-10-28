import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { collections, openRepository, SecretVault } from '../packages/storage/src/index.js';
import { migrateStorage } from '../scripts/rebrand-storage.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'smart-flint-rebrand-'));
  roots.push(root);
  const key = randomBytes(32);
  const data = join(root, '.data');
  await mkdir(data, { mode: 0o700 });
  await writeFile(join(data, 'encryption.key'), key.toString('base64'), { mode: 0o600 });
  const sourcePath = join(data, 'smartbridge.sqlite');
  const targetPath = join(data, 'smart-flint.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec('PRAGMA journal_mode = WAL;');
  for (const collection of collections.filter(name => name !== 'admin_users')) {
    source.exec(`CREATE TABLE smartbridge_${collection} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`);
  }
  const records = {
    tenants: { id: 'tenant-a', name: 'SMARTBridge original display name', slug: 'existing-org' },
    applications: { id: 'app-existing', name: 'Health Compass', callbackUrls: ['https://127.0.0.1:3443/samples/patient/callback'] },
    connections: { id: 'conn-existing', tenantId: 'tenant-a', fhirBaseUrl: 'https://ehr.example/FHIR/R4' },
    installations: { id: 'inst-existing', applicationId: 'app-existing', tenantId: 'tenant-a', connectionId: 'conn-existing' },
  };
  for (const [collection, record] of Object.entries(records)) {
    source.prepare(`INSERT INTO smartbridge_${collection} (id, data) VALUES (?, ?)`).run(record.id, JSON.stringify(record));
  }
  const secrets = {
    'grant:existing': { access_token: 'synthetic-sensitive-token', refresh_token: 'synthetic-renewal-token' },
    'bridge-signing': { privateKey: 'synthetic-private-key-value', kid: 'existing-signing-key' },
  };
  for (const [id, value] of Object.entries(secrets)) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`smartbridge:secret:v1:${id}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const sealed = { id, version: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    source.prepare('INSERT INTO smartbridge_secrets (id, data) VALUES (?, ?)').run(id, JSON.stringify(sealed));
  }
  return { root, key, data, sourcePath, targetPath, source, records, secrets };
}

describe('offline storage rebrand', () => {
  it('preserves records and secret values, captures WAL in the backup, and safely validates reruns', async () => {
    const f = await fixture();
    // Keep this read-only observer open so committed fixture rows remain in WAL during backup.
    try {
      expect(existsSync(`${f.sourcePath}-wal`)).toBe(true);
      const result = await migrateStorage({ root: f.root, offline: true });
      expect(result).toMatchObject({ status: 'migrated', verifiedSecrets: 2 });
      expect(existsSync(f.sourcePath)).toBe(false);
      expect(existsSync(f.targetPath)).toBe(true);
      const repo = await openRepository({ sqlitePath: f.targetPath });
      try {
        for (const [collection, record] of Object.entries(f.records)) expect(await repo.get(collection, record.id)).toEqual(record);
        const vault = new SecretVault(repo, f.key);
        for (const [id, secret] of Object.entries(f.secrets)) expect(await vault.get(id)).toEqual(secret);
        const sealed = await repo.get<{ ciphertext: string }>('secrets', 'grant:existing');
        expect(sealed?.ciphertext).not.toContain('synthetic-sensitive-token');
      } finally { await repo.close(); }
      const historical = new DatabaseSync(result.backupPath!, { readOnly: true });
      try {
        expect(historical.prepare('SELECT COUNT(*) AS n FROM smartbridge_installations').get()?.n).toBe(1);
        const envelope = JSON.parse(String(historical.prepare('SELECT data FROM smartbridge_secrets WHERE id = ?').get('grant:existing')?.data));
        const decipher = createDecipheriv('aes-256-gcm', f.key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from('smartbridge:secret:v1:grant:existing'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
        expect(JSON.parse(plaintext.toString('utf8'))).toEqual(f.secrets['grant:existing']);
      } finally { historical.close(); }
      const state = await readFile(f.targetPath);
      expect(await migrateStorage({ root: f.root, offline: true })).toEqual({ status: 'already_migrated', targetPath: f.targetPath });
      expect(await readFile(f.targetPath)).toEqual(state);
      expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-token');
    } finally { f.source.close(); }
  });

  it('fails closed with a wrong encryption key, retaining original records and leaving no target or staging database', async () => {
    const f = await fixture();
    f.source.close();
    const original = await readFile(f.sourcePath);
    await writeFile(join(f.data, 'encryption.key'), randomBytes(32).toString('base64'));
    await expect(migrateStorage({ root: f.root, offline: true })).rejects.toThrow('source database was not changed');
    expect(await readFile(f.sourcePath)).toEqual(original);
    expect(existsSync(f.targetPath)).toBe(false);
    expect((await readdir(f.data)).filter(name => name.includes('.migration-'))).toEqual([]);
    const source = new DatabaseSync(f.sourcePath, { readOnly: true });
    try { expect(source.prepare('SELECT COUNT(*) AS n FROM smartbridge_secrets').get()?.n).toBe(2); }
    finally { source.close(); }
  });

  it('requires explicit offline confirmation and refuses to overwrite an existing target', async () => {
    const f = await fixture();
    f.source.close();
    await expect(migrateStorage({ root: f.root })).rejects.toThrow('--offline');
    const target = Buffer.from('an unrelated existing destination');
    await writeFile(f.targetPath, target);
    await expect(migrateStorage({ root: f.root, offline: true })).rejects.toThrow('source database was not changed');
    expect(await readFile(f.targetPath)).toEqual(target);
    expect(existsSync(f.sourcePath)).toBe(true);
    expect(existsSync(join(f.data, 'backups'))).toBe(false);
  });

  it('refuses a future migration ledger on a read-only rerun without changing the verified target', async () => {
    const f = await fixture(); f.source.close();
    await migrateStorage({ root: f.root, offline: true });
    const repository = await openRepository({ sqlitePath: f.targetPath }); await repository.close();
    const future = new DatabaseSync(f.targetPath);
    future.prepare('INSERT INTO smart_flint_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(99, 'future-release', new Date().toISOString());
    future.close();
    const before = await readFile(f.targetPath);
    await expect(migrateStorage({ root: f.root, offline: true })).rejects.toThrow('source database was not changed');
    expect(await readFile(f.targetPath)).toEqual(before);
    expect(existsSync(f.sourcePath)).toBe(false);
  });
});
