import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Historical identifiers belong only in this explicit, offline migration.
const legacyPrefix = 'smartbridge_';
const currentPrefix = 'smart_flint_';
const legacyAAD = 'smartbridge:secret:v1:';
const currentAAD = 'smart-flint:secret:v1:';
const collections = [
  'tenants', 'platforms', 'applications', 'connections', 'registrations', 'app_registrations', 'installations',
  'activations', 'grants', 'transactions', 'handoffs', 'sessions', 'events',
  'continuations', 'secrets', 'cds_services', 'replays',
];

async function regularFile(path) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Migration files must be regular files, without symbolic links.');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function openSecret(record, key, prefix) {
  if (record.version !== 1 || typeof record.id !== 'string') throw new Error('Invalid secret envelope.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAAD(Buffer.from(`${prefix}${record.id}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
}

function sealSecret(record, plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${currentAAD}${record.id}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ...record, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => String(row.name));
}

function assertSchema(db, prefix) {
  // These additive tables were introduced after the branding migration. A
  // read-only rerun accepts only the explicitly supported ledger generation;
  // unknown/newer history must never be mistaken for a completed migration.
  const names = tableNames(db);
  if (prefix === currentPrefix && names.includes(`${currentPrefix}schema_migrations`)) {
    const history = db.prepare(`SELECT version, name FROM ${currentPrefix}schema_migrations ORDER BY version`).all();
    if (history.length !== 1 || history[0].version !== 1 || history[0].name !== 'initial-versioned-collections') {
      throw new Error('Unsupported storage migration history; refusing to assume completion.');
    }
  }
  const tables = names.filter(name => !(prefix === currentPrefix
    && [`${currentPrefix}admin_users`, `${currentPrefix}schema_migrations`].includes(name)));
  const expected = collections.map(name => `${prefix}${name}`).sort();
  if (tables.length !== expected.length || tables.some((name, index) => name !== expected[index])) {
    throw new Error('Unexpected storage schema; refusing to migrate or assume completion.');
  }
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('SQLite integrity validation failed.');
}

function rows(db, prefix, collection) {
  return db.prepare(`SELECT id, data FROM ${prefix}${collection} ORDER BY rowid`).all();
}

function authenticateSecrets(db, key, prefix, aad) {
  for (const row of rows(db, prefix, 'secrets')) {
    const sealed = JSON.parse(String(row.data));
    if (sealed.id !== row.id) throw new Error('Secret ID does not match its storage key.');
    const plaintext = openSecret(sealed, key, aad);
    try { JSON.parse(plaintext.toString('utf8')); }
    finally { plaintext.fill(0); }
  }
}

/** Run with all service processes stopped. No credentials or decrypted records are returned or logged. */
export async function migrateStorage(options = {}) {
  if (options.offline !== true) throw new Error('Stop all service processes, then explicitly confirm offline migration with --offline.');
  const root = resolve(options.root ?? fileURLToPath(new URL('../', import.meta.url)));
  const sourcePath = resolve(options.sourcePath ?? join(root, '.data', 'smartbridge.sqlite'));
  const targetPath = resolve(options.targetPath ?? join(root, '.data', 'smart-flint.sqlite'));
  const keyPath = resolve(options.keyPath ?? join(root, '.data', 'encryption.key'));
  const backupDirectory = resolve(options.backupDirectory ?? join(root, '.data', 'backups'));
  if (sourcePath === targetPath) throw new Error('Source and target database paths must differ.');
  if (!(await regularFile(keyPath))) throw new Error('The existing encryption key file is required.');
  const key = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64');
  if (key.length !== 32) throw new Error('The existing encryption key must contain exactly 32 bytes.');
  let source;
  let staged;
  let stagingPath;
  let published = false;
  try {
    const sourceExists = await regularFile(sourcePath);
    const targetExists = await regularFile(targetPath);
    if (targetExists) {
      if (sourceExists) throw new Error('Both old and new database paths exist; refusing to overwrite or guess which is authoritative.');
      const target = new DatabaseSync(targetPath, { readOnly: true });
      try {
        assertSchema(target, currentPrefix);
        authenticateSecrets(target, key, currentPrefix, currentAAD);
        return { status: 'already_migrated', targetPath };
      } finally { target.close(); }
    }
    if (!sourceExists) throw new Error('The legacy database does not exist.');
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}`;
    const backupPath = join(backupDirectory, `before-smart-flint-${suffix}.sqlite`);
    stagingPath = `${targetPath}.migration-${suffix}`;
    source = new DatabaseSync(sourcePath, { readOnly: true });
    assertSchema(source, legacyPrefix);
    // SQLite backup includes committed WAL frames. Never copy a live .sqlite file by itself.
    await backup(source, backupPath);
    await chmod(backupPath, 0o600);
    await backup(source, stagingPath);
    await chmod(stagingPath, 0o600);
    staged = new DatabaseSync(stagingPath);
    staged.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
    const counts = {};
    try {
      for (const collection of collections) {
        staged.exec(`ALTER TABLE ${legacyPrefix}${collection} RENAME TO ${currentPrefix}${collection}`);
        const before = rows(source, legacyPrefix, collection);
        counts[collection] = before.length;
        if (collection !== 'secrets') continue;
        const update = staged.prepare(`UPDATE ${currentPrefix}secrets SET data = ? WHERE id = ?`);
        for (const row of before) {
          const sealed = JSON.parse(String(row.data));
          if (sealed.id !== row.id) throw new Error('Secret ID does not match its storage key.');
          const plaintext = openSecret(sealed, key, legacyAAD);
          let verified;
          try {
            JSON.parse(plaintext.toString('utf8'));
            const replacement = sealSecret(sealed, plaintext, key);
            update.run(JSON.stringify(replacement), row.id);
            const stored = staged.prepare(`SELECT data FROM ${currentPrefix}secrets WHERE id = ?`).get(row.id);
            verified = openSecret(JSON.parse(String(stored.data)), key, currentAAD);
            if (plaintext.length !== verified.length || !timingSafeEqual(plaintext, verified)) throw new Error('Secret round-trip verification failed.');
          } finally { plaintext.fill(0); verified?.fill(0); }
        }
      }
      // Public JSON is byte-for-byte preserved; all foreign IDs and ordering stay unchanged.
      for (const collection of collections) {
        const before = rows(source, legacyPrefix, collection);
        const after = rows(staged, currentPrefix, collection);
        if (before.length !== after.length || before.some((row, index) => row.id !== after[index].id
          || (collection !== 'secrets' && row.data !== after[index].data))) throw new Error('Stored record verification failed.');
      }
      assertSchema(staged, currentPrefix);
      authenticateSecrets(staged, key, currentPrefix, currentAAD);
      staged.exec('COMMIT; PRAGMA journal_mode = DELETE;');
    } catch (error) {
      try { staged.exec('ROLLBACK;'); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
    staged.close(); staged = undefined;
    source.close(); source = undefined;
    // Atomic no-overwrite publication. The verified historical backup retains the old database.
    await link(stagingPath, targetPath);
    published = true;
    await unlink(stagingPath); stagingPath = undefined;
    await unlink(sourcePath);
    for (const suffix of ['-wal', '-shm']) {
      try { await unlink(`${sourcePath}${suffix}`); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    return { status: 'migrated', targetPath, backupPath, counts, verifiedSecrets: counts.secrets };
  } catch {
    // Never print an underlying crypto exception, record, token, or private key.
    throw new Error(published
      ? 'Migration target was verified and published, but legacy cleanup did not finish. Preserve both databases and inspect their paths before restarting.'
      : 'Storage migration failed safely. The source database was not changed; check schema, key, permissions, and destination paths.');
  } finally {
    staged?.close(); source?.close(); key.fill(0);
    if (stagingPath) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { await unlink(`${stagingPath}${suffix}`); }
        catch (error) { if (error?.code !== 'ENOENT') throw new Error('Private migration staging cleanup failed.'); }
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some(argument => argument !== '--offline')) {
    process.stderr.write('Usage: node scripts/rebrand-storage.mjs --offline\n');
    process.exitCode = 1;
  } else {
    try { process.stdout.write(`${JSON.stringify(await migrateStorage({ offline: arguments_.includes('--offline') }))}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
