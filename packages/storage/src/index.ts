import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient } from 'pg';

/** Identifiers are checked before interpolation. Application values always use parameters. */
export const collections = [
  'tenants', 'platforms', 'applications', 'connections', 'registrations', 'app_registrations', 'installations',
  'activations', 'grants', 'transactions', 'handoffs', 'sessions', 'events',
  'continuations', 'secrets', 'cds_services', 'replays', 'admin_users',
] as const;

export type Collection = typeof collections[number];
export const storageSchemaVersion = 1;
export type StoredRecord = { id: string } & Record<string, unknown>;
export interface RepositorySnapshot {
  schemaVersion: number;
  collections: Record<Collection, StoredRecord[]>;
}

export interface Repository {
  readonly kind: 'sqlite' | 'postgres';
  get<T>(collection: string, id: string): Promise<T | undefined>;
  list<T>(collection: string): Promise<T[]>;
  put<T extends { id: string }>(collection: string, item: T): Promise<T>;
  delete(collection: string, id: string): Promise<void>;
  /** Atomic delete-and-return. Exactly one caller receives the record. */
  consume<T>(collection: string, id: string): Promise<T | undefined>;
  /** PostgreSQL uses a transaction-scoped advisory lock across service instances. */
  withLock<T>(key: string, work: () => Promise<T>): Promise<T>;
  /** Offline maintenance: take one consistent snapshot, including encrypted vault records. */
  snapshot(): Promise<RepositorySnapshot>;
  /** Atomically import into an empty repository; never replaces an existing deployment. */
  restoreSnapshot(snapshot: RepositorySnapshot): Promise<void>;
  /** Atomically replace only a previously verified vault generation. */
  replaceSecrets(expected: StoredRecord[], replacement: StoredRecord[], auditEvent?: StoredRecord): Promise<void>;
  close(): Promise<void>;
}

/** Every supported storage migration has a stable identifier and an immutable version. */
const migrationName = 'initial-versioned-collections';
function validateMigrationRows(rows: { version: unknown; name: unknown }[]) {
  if (rows.some(row => Number(row.version) > storageSchemaVersion)) throw new Error('The database schema is newer than this SMART Flint release. Use a compatible binary or restore a verified backup.');
  if (rows.length > 1 || rows.some(row => Number(row.version) !== 1 || row.name !== migrationName)) throw new Error('The storage migration history is invalid. Restore a verified backup.');
}

export function validateRepositorySnapshot(snapshot: unknown): asserts snapshot is RepositorySnapshot {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid repository snapshot');
  const source = snapshot as RepositorySnapshot;
  if (Object.keys(source).sort().join(',') !== 'collections,schemaVersion' || source.schemaVersion !== storageSchemaVersion
    || !source.collections || typeof source.collections !== 'object' || Array.isArray(source.collections)
    || Object.keys(source.collections).sort().join(',') !== [...collections].sort().join(',')) throw new Error('Unsupported repository snapshot schema');
  let count = 0;
  for (const name of collections) {
    const values = source.collections[name];
    if (!Array.isArray(values)) throw new Error('Invalid repository snapshot collection');
    const ids = new Set<string>();
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid repository snapshot record');
      record(value);
      if (ids.has(value.id) || ++count > 1_000_000) throw new Error('Duplicate record or oversized repository snapshot');
      ids.add(value.id);
    }
  }
}

function sameRecords(a: StoredRecord[], b: StoredRecord[]) {
  const canonical = (values: StoredRecord[]) => JSON.stringify(values.map(value => [value.id, stableValue(value)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  return canonical(a) === canonical(b);
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

function table(collection: string): string {
  if (!(collections as readonly string[]).includes(collection)) {
    throw new Error('Unknown repository collection');
  }
  return `smart_flint_${collection}`;
}

function record<T extends { id: string }>(item: T): string {
  if (!item || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 512) {
    throw new Error('A nonempty record ID of at most 512 characters is required');
  }
  return JSON.stringify(item);
}

class SqliteRepository implements Repository {
  readonly kind = 'sqlite' as const;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly db: DatabaseSync) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS smart_flint_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      const applied = db.prepare('SELECT version, name FROM smart_flint_schema_migrations ORDER BY version').all();
      validateMigrationRows(applied as { version: unknown; name: unknown }[]);
      if (!applied.length) {
        for (const name of collections) db.exec(`CREATE TABLE IF NOT EXISTS ${table(name)} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`);
        db.prepare('INSERT INTO smart_flint_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, migrationName, new Date().toISOString());
      }
      for (const name of collections) db.prepare(`SELECT id, data FROM ${table(name)} LIMIT 0`).all();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    const row = this.db.prepare(`SELECT data FROM ${table(collection)} WHERE id = ?`).get(id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }

  async list<T>(collection: string): Promise<T[]> {
    return this.db.prepare(`SELECT data FROM ${table(collection)} ORDER BY rowid`).all()
      .map(row => JSON.parse(String(row.data)) as T);
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const data = record(item);
    this.db.prepare(`INSERT INTO ${table(collection)} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(item.id, data);
    return structuredClone(item);
  }

  async delete(collection: string, id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${table(collection)} WHERE id = ?`).run(id);
  }

  async consume<T>(collection: string, id: string): Promise<T | undefined> {
    const row = this.db.prepare(`DELETE FROM ${table(collection)} WHERE id = ? RETURNING data`).get(id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }

  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async close(): Promise<void> { this.db.close(); }

  async snapshot(): Promise<RepositorySnapshot> {
    this.db.exec('BEGIN');
    try {
      const result = { schemaVersion: storageSchemaVersion, collections: Object.fromEntries(collections.map(name => [name,
        this.db.prepare(`SELECT data FROM ${table(name)} ORDER BY id`).all().map(row => JSON.parse(String(row.data)) as StoredRecord)])) as RepositorySnapshot['collections'] };
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async restoreSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    validateRepositorySnapshot(snapshot);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const name of collections) if (this.db.prepare(`SELECT id FROM ${table(name)} LIMIT 1`).get()) throw new Error('Restore requires an empty target database');
      for (const name of collections) for (const item of snapshot.collections[name]) this.db.prepare(`INSERT INTO ${table(name)} (id, data) VALUES (?, ?)`).run(item.id, record(item));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async replaceSecrets(expected: StoredRecord[], replacement: StoredRecord[], auditEvent?: StoredRecord): Promise<void> {
    if (expected.length !== replacement.length || expected.some(value => !replacement.some(item => item.id === value.id))) throw new Error('Vault record identities must be preserved');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare(`SELECT data FROM ${table('secrets')} ORDER BY id`).all().map(row => JSON.parse(String(row.data)) as StoredRecord);
      if (!sameRecords(current, expected)) throw new Error('The vault changed during offline maintenance. Stop every service instance and retry.');
      for (const item of replacement) this.db.prepare(`UPDATE ${table('secrets')} SET data = ? WHERE id = ?`).run(record(item), item.id);
      if (auditEvent) this.db.prepare(`INSERT INTO ${table('events')} (id, data) VALUES (?, ?)`).run(auditEvent.id, record(auditEvent));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

class PostgresRepository implements Repository {
  readonly kind = 'postgres' as const;
  private readonly transaction = new AsyncLocalStorage<{ client: PoolClient; pending: Promise<void> }>();

  constructor(private readonly pool: Pool) {}

  private query(text: string, values: unknown[] = []) {
    const context = this.transaction.getStore();
    if (!context) return this.pool.query(text, values);
    // Callers may use Promise.all; a PostgreSQL transaction still has one wire connection.
    const result = context.pending.then(() => context.client.query(text, values));
    context.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('smart-flint:schema-migrations', 0))");
      await client.query('CREATE TABLE IF NOT EXISTS smart_flint_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      const applied = await client.query('SELECT version, name FROM smart_flint_schema_migrations ORDER BY version');
      validateMigrationRows(applied.rows);
      if (!applied.rows.length) {
        for (const name of collections) await client.query(`CREATE TABLE IF NOT EXISTS ${table(name)} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
        await client.query('INSERT INTO smart_flint_schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [1, migrationName, new Date().toISOString()]);
      }
      for (const name of collections) await client.query(`SELECT id, data FROM ${table(name)} LIMIT 0`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    const result = await this.query(`SELECT data FROM ${table(collection)} WHERE id = $1`, [id]);
    return result.rows[0]?.data as T | undefined;
  }

  async list<T>(collection: string): Promise<T[]> {
    const result = await this.query(`SELECT data FROM ${table(collection)} ORDER BY id`);
    return result.rows.map(row => row.data as T);
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const data = record(item);
    await this.query(`INSERT INTO ${table(collection)} (id, data) VALUES ($1, $2::jsonb) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [item.id, data]);
    return structuredClone(item);
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.query(`DELETE FROM ${table(collection)} WHERE id = $1`, [id]);
  }

  async consume<T>(collection: string, id: string): Promise<T | undefined> {
    const result = await this.query(`DELETE FROM ${table(collection)} WHERE id = $1 RETURNING data`, [id]);
    return result.rows[0]?.data as T | undefined;
  }

  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const lock = createHash('sha256').update(key).digest().readBigInt64BE(0).toString();
    const existing = this.transaction.getStore();
    if (existing) {
      await this.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
      return work();
    }
    const client = await this.pool.connect();
    const context = { client, pending: Promise.resolve() };
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
      const result = await this.transaction.run(context, work);
      await context.pending;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await context.pending;
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async snapshot(): Promise<RepositorySnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = { schemaVersion: storageSchemaVersion, collections: {} as RepositorySnapshot['collections'] };
      for (const name of collections) result.collections[name] = (await client.query(`SELECT data FROM ${table(name)} ORDER BY id`)).rows.map(row => row.data as StoredRecord);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async restoreSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    validateRepositorySnapshot(snapshot);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`LOCK TABLE ${collections.map(table).join(', ')} IN ACCESS EXCLUSIVE MODE`);
      for (const name of collections) if ((await client.query(`SELECT id FROM ${table(name)} LIMIT 1`)).rows.length) throw new Error('Restore requires an empty target database');
      for (const name of collections) for (const item of snapshot.collections[name]) await client.query(`INSERT INTO ${table(name)} (id, data) VALUES ($1, $2::jsonb)`, [item.id, record(item)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async replaceSecrets(expected: StoredRecord[], replacement: StoredRecord[], auditEvent?: StoredRecord): Promise<void> {
    if (expected.length !== replacement.length || expected.some(value => !replacement.some(item => item.id === value.id))) throw new Error('Vault record identities must be preserved');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`LOCK TABLE ${table('secrets')} IN ACCESS EXCLUSIVE MODE`);
      const current = (await client.query(`SELECT data FROM ${table('secrets')} ORDER BY id`)).rows.map(row => row.data as StoredRecord);
      if (!sameRecords(current, expected)) throw new Error('The vault changed during offline maintenance. Stop every service instance and retry.');
      for (const item of replacement) await client.query(`UPDATE ${table('secrets')} SET data = $1::jsonb WHERE id = $2`, [record(item), item.id]);
      if (auditEvent) await client.query(`INSERT INTO ${table('events')} (id, data) VALUES ($1, $2::jsonb)`, [auditEvent.id, record(auditEvent)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

export async function openRepository(options: { databaseUrl?: string; sqlitePath?: string } = {}): Promise<Repository> {
  if (options.databaseUrl) {
    const parsed = new URL(options.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
    }
    const pool = new Pool({ connectionString: options.databaseUrl, max: 10, connectionTimeoutMillis: 5000,
      query_timeout: 15000, statement_timeout: 15000, idle_in_transaction_session_timeout: 60000 });
    // pg removes failed idle clients before emitting this event. A database
    // outage must make readiness fail, not crash Node through an unhandled
    // EventEmitter error. Driver errors can contain connection credentials;
    // never forward their raw values to logs or responses.
    pool.on('error', () => undefined);
    const repo = new PostgresRepository(pool);
    try { await repo.initialize(); }
    catch (error) { await repo.close(); throw error; }
    return repo;
  }
  const path = options.sqlitePath ?? '.data/smart-flint.sqlite';
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') await chmod(path, 0o600);
  try { return new SqliteRepository(db); }
  catch (error) { db.close(); throw error; }
}

interface SealedSecret {
  id: string;
  version: 1;
  iv: string;
  ciphertext: string;
  tag: string;
}

/** Token/private-key values belong here; public configuration belongs in ordinary collections. */
export class SecretVault {
  private readonly key: Buffer;

  constructor(private readonly repo: Repository, key: Buffer | string) {
    this.key = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(key, 'base64');
    if (this.key.length !== 32) throw new Error('The encryption key must contain exactly 32 bytes');
  }

  async set(id: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Secret values must be JSON serializable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`smart-flint:secret:v1:${id}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
    await this.repo.put<SealedSecret>('secrets', {
      id, version: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    });
  }

  async get<T>(id: string): Promise<T | undefined> {
    const sealed = await this.repo.get<SealedSecret>('secrets', id);
    if (!sealed) return undefined;
    try {
      if (sealed.id !== id || sealed.version !== 1) throw new Error('Invalid secret envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(Buffer.from(`smart-flint:secret:v1:${id}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch { throw new Error('Secret authentication failed'); }
  }

  async delete(id: string): Promise<void> { await this.repo.delete('secrets', id); }
}

export function randomId(prefix = 'id'): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(prefix)) throw new Error('Invalid identifier prefix');
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('base64url'); }
export function pkceChallenge(verifier: string): string { return digest(verifier); }
