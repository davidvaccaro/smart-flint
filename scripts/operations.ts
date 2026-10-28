import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, projectRoot } from '../apps/server/src/config.js';
import { openRepository, SecretVault, validateRepositorySnapshot,
  type Repository, type RepositorySnapshot, type StoredRecord } from '../packages/storage/src/index.js';

export class OperationsError extends Error {}
const maximumBackupBytes = 256 * 1024 * 1024;
const maximumPayloadBytes = 128 * 1024 * 1024;
const backupAAD = Buffer.from('smart-flint:encrypted-backup:v1');
interface BackupPayload { format: 'smart-flint-backup'; version: 1; createdAt: string; source: Repository['kind']; snapshot: RepositorySnapshot }

function keyBytes(value: string | Buffer) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'base64');
  if (key.length !== 32 || (typeof value === 'string' && key.toString('base64') !== value)) throw new OperationsError('Use the deployment’s exact base64-encoded 32-byte encryption key.');
  return key;
}
function requireOffline(offline: boolean) {
  if (offline !== true) throw new OperationsError('Stop EVERY SMART Flint instance sharing this database, then supply --offline to confirm.');
}
async function verifyVault(snapshot: RepositorySnapshot, key: string | Buffer) {
  const check = await openRepository({ sqlitePath: ':memory:' });
  try {
    for (const record of snapshot.collections.secrets) await check.put('secrets', record);
    const vault = new SecretVault(check, key);
    for (const record of snapshot.collections.secrets) await vault.get(record.id);
  } finally { await check.close(); }
}
function summary(payload: BackupPayload) {
  return { schemaVersion: payload.snapshot.schemaVersion, source: payload.source, createdAt: payload.createdAt,
    records: Object.values(payload.snapshot.collections).reduce((total, records) => total + records.length, 0) };
}
async function decodeBackup(content: string, key: string | Buffer): Promise<BackupPayload> {
  if (Buffer.byteLength(content) > maximumBackupBytes) throw new OperationsError('The backup exceeds the 256 MiB maintenance-file limit.');
  const secret = keyBytes(key);
  let plaintext: Buffer | undefined;
  try {
    const envelope = JSON.parse(content) as Record<string, unknown>;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).sort().join(',') !== 'ciphertext,format,iv,tag,version'
      || envelope.format !== 'smart-flint-encrypted-backup' || envelope.version !== 1
      || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') throw new Error();
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64'), ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > maximumPayloadBytes
      || iv.toString('base64') !== envelope.iv || tag.toString('base64') !== envelope.tag || ciphertext.toString('base64') !== envelope.ciphertext) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAAD(backupAAD); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as BackupPayload;
    if (!payload || Object.keys(payload).sort().join(',') !== 'createdAt,format,snapshot,source,version'
      || payload.format !== 'smart-flint-backup' || payload.version !== 1 || !['sqlite', 'postgres'].includes(payload.source)
      || typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt))) throw new Error();
    validateRepositorySnapshot(payload.snapshot);
    await verifyVault(payload.snapshot, secret);
    return payload;
  } catch { throw new OperationsError('Backup verification failed. Check the original encryption key, file integrity, and supported schema version. No restore was performed.'); }
  finally { secret.fill(0); plaintext?.fill(0); }
}

/** Logical, authenticated encryption of configuration, audit records and the already encrypted vault. */
export async function createBackup(options: { repository: Repository; key: string | Buffer; offline: boolean }): Promise<string> {
  requireOffline(options.offline);
  const key = keyBytes(options.key);
  let bytes: Buffer | undefined;
  try {
    const snapshot = await options.repository.snapshot();
    validateRepositorySnapshot(snapshot);
    await verifyVault(snapshot, key);
    const payload: BackupPayload = { format: 'smart-flint-backup', version: 1, createdAt: new Date().toISOString(), source: options.repository.kind, snapshot };
    bytes = Buffer.from(JSON.stringify(payload));
    if (bytes.length > maximumPayloadBytes) throw new OperationsError('The logical snapshot exceeds 128 MiB. Use a separately verified native database backup procedure.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(backupAAD);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return `${JSON.stringify({ format: 'smart-flint-encrypted-backup', version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })}\n`;
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError('Backup failed. Confirm database access and the encryption key; every stored vault record must authenticate.');
  } finally { key.fill(0); bytes?.fill(0); }
}

export async function verifyBackup(options: { backup: string; key: string | Buffer }) {
  return summary(await decodeBackup(options.backup, options.key));
}

/** Recovery never resumes browser sessions, in-flight authorizations, clinical activations or old refresh grants. */
export async function restoreBackup(options: { repository: Repository; backup: string; key: string | Buffer; offline: boolean }) {
  requireOffline(options.offline);
  const payload = await decodeBackup(options.backup, options.key);
  const restored = structuredClone(payload.snapshot);
  for (const name of ['activations', 'grants', 'transactions', 'handoffs', 'sessions', 'continuations'] as const) restored.collections[name] = [];
  restored.collections.secrets = restored.collections.secrets.filter(record => !/^(activation|grant|transaction):/.test(record.id));
  restored.collections.events.push({ id: `restore_${randomBytes(24).toString('base64url')}`, at: new Date().toISOString(), action: 'operations.backup_restored',
    detail: 'An offline operator restored a verified backup; prior sessions, authorization transactions and activation grants were discarded.', outcome: 'success',
    actor: { id: 'offline-operator', displayName: 'Offline recovery operator', kind: 'bootstrap', role: 'platform_admin' } });
  try { await options.repository.restoreSnapshot(restored); }
  catch { throw new OperationsError('Restore failed. The target must be an empty compatible database. Existing records were not replaced.'); }
  return { ...summary(payload), discardedRuntimeState: true };
}

/** Prepare all replacement envelopes before one atomic compare-and-replace of the existing vault. */
export async function rotateEncryptionKey(options: { repository: Repository; currentKey: string | Buffer; newKey: string | Buffer; offline: boolean }) {
  requireOffline(options.offline);
  const current = keyBytes(options.currentKey), next = keyBytes(options.newKey);
  const staging = await openRepository({ sqlitePath: ':memory:' });
  try {
    if (current.equals(next)) throw new OperationsError('The replacement encryption key must differ from the current key.');
    const original = await options.repository.list<StoredRecord>('secrets');
    if (!original.length) throw new OperationsError('The vault is empty; there is no existing key generation to authenticate or rotate.');
    for (const record of original) await staging.put('secrets', record);
    const oldVault = new SecretVault(staging, current), replacement = new SecretVault(staging, next);
    const decoded: [string, unknown][] = [];
    for (const record of original) decoded.push([record.id, await oldVault.get(record.id)]);
    for (const [id, value] of decoded) await replacement.set(id, value);
    const records = await staging.list<StoredRecord>('secrets');
    for (const [id] of decoded) await replacement.get(id);
    await options.repository.replaceSecrets(original, records, { id: `key_rotation_${randomBytes(24).toString('base64url')}`, at: new Date().toISOString(),
      action: 'operations.encryption_key_rotated', detail: 'An offline operator atomically re-encrypted the existing vault with a replacement master key.', outcome: 'success',
      actor: { id: 'offline-operator', displayName: 'Offline recovery operator', kind: 'bootstrap', role: 'platform_admin' } });
    return { rotatedSecrets: records.length, updateDeploymentKeyBeforeRestart: true };
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError('Key rotation failed. The old key and every stored record must authenticate, and all service instances must remain stopped.');
  } finally { current.fill(0); next.fill(0); await staging.close(); }
}

/** Private files are bounded, regular, owned by the caller and never followed through a final symlink. */
export async function readPrivateOperationsFile(path: string, maximum: number): Promise<string> {
  if (!constants.O_NOFOLLOW || typeof process.getuid !== 'function') throw new OperationsError('Offline maintenance files require POSIX file protections.');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o177) !== 0 || info.size > maximum) throw new Error();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - total));
      const result = await file.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > maximum) throw new Error();
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
  } catch { throw new OperationsError('Use an owned nonsymlink regular file with permissions 0600 or stricter and a supported size.'); }
  finally { await file?.close(); }
}

/** Publish a completely written, fsynced private file atomically and without overwriting any destination. */
export async function writePrivateOperationsFile(path: string, content: string): Promise<void> {
  if (typeof process.getuid !== 'function') throw new OperationsError('Offline maintenance files require POSIX file protections.');
  const target = resolve(path), parent = dirname(target);
  let temporary: string | undefined;
  try {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) throw new Error();
    temporary = join(parent, `.smart-flint-backup-${randomBytes(24).toString('hex')}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, target);
    await unlink(temporary); temporary = undefined;
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { throw new OperationsError('The output could not be created safely. Choose a nonexistent file in an owned, non-shared-writable directory. Existing files are never overwritten.'); }
  finally { if (temporary) await unlink(temporary).catch(() => undefined); }
}

const help = `Usage: npm run ops -- <command> [options]
Production container: node apps/server/dist/scripts/operations.js <command> [options]

backup     --offline --output /private/deployment.flint-backup
verify     --input /private/deployment.flint-backup
restore    --offline --input /private/deployment.flint-backup
rotate-key --offline --new-key-file /private/new.key --output /private/before-rotation.flint-backup

All commands use the deployment database and ENCRYPTION_KEY; --key-file may instead select an existing private key file.
Stop EVERY service instance before backup, restore, or rotation. --offline is your attestation, not automatic detection.
Restore requires an EMPTY target database and discards saved sessions, authorizations, activations and refresh grants.
Rotation first writes a verified backup encrypted with the OLD key. Update deployment ENCRYPTION_KEY to the new key BEFORE restarting.
Protect backup/key files as secrets (owned regular files, permissions 0600 or stricter). Keys and decrypted records are never printed.
This portable logical backup is bounded to 128 MiB of plaintext; larger deployments need verified native database backup tooling.
`;

async function main() {
  let repository: Repository | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { process.stdout.write(help); return; }
    const command = args.shift();
    if (!command || !['backup', 'verify', 'restore', 'rotate-key'].includes(command)) throw new OperationsError('Choose backup, verify, restore, or rotate-key. See --help.');
    const values = new Map<string, string>();
    let offline = false;
    const permitted = command === 'backup' ? ['--output', '--key-file'] : command === 'rotate-key' ? ['--output', '--new-key-file', '--key-file'] : ['--input', '--key-file'];
    while (args.length) {
      const option = args.shift()!;
      if (option === '--offline' && command !== 'verify' && !offline) { offline = true; continue; }
      if (!permitted.includes(option) || values.has(option)) throw new OperationsError('Unknown or repeated operation option. See --help.');
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new OperationsError('Each value option needs one value. See --help.');
      values.set(option, value);
    }
    if (command !== 'verify') requireOffline(offline);
    if (['backup', 'rotate-key'].includes(command) && !values.has('--output')) throw new OperationsError('Supply --output pointing to a new private backup file.');
    if (['verify', 'restore'].includes(command) && !values.has('--input')) throw new OperationsError('Supply --input pointing to an existing private backup file.');
    if (command === 'rotate-key' && !values.has('--new-key-file')) throw new OperationsError('Supply --new-key-file pointing to an existing private base64-encoded key file.');
    const key = values.has('--key-file') ? (await readPrivateOperationsFile(values.get('--key-file')!, 1024)).trim()
      : process.env.ENCRYPTION_KEY || (await readPrivateOperationsFile(join(projectRoot, '.data/encryption.key'), 1024)).trim();
    keyBytes(key).fill(0);
    if (command === 'verify') {
      const backup = await readPrivateOperationsFile(values.get('--input')!, maximumBackupBytes);
      const result = await verifyBackup({ backup, key });
      process.stdout.write(`Backup verified: schema ${result.schemaVersion}; ${result.records} records. No database was opened.\n`);
      return;
    }
    const backup = command === 'restore' ? await readPrivateOperationsFile(values.get('--input')!, maximumBackupBytes) : undefined;
    if (backup) await verifyBackup({ backup, key }); // Authenticate before touching even an empty target.
    const config = loadConfig({ encryptionKey: key });
    repository = await openRepository({ databaseUrl: config.databaseUrl, sqlitePath: config.sqlitePath });
    if (command === 'backup') {
      const output = await createBackup({ repository, key, offline });
      await verifyBackup({ backup: output, key });
      await writePrivateOperationsFile(values.get('--output')!, output);
      process.stdout.write('Encrypted backup created and verified. Retain its encryption key separately and perform a restore drill.\n');
    } else if (command === 'restore') {
      const result = await restoreBackup({ repository, key, backup: backup!, offline });
      process.stdout.write(`Backup restored into the empty target (schema ${result.schemaVersion}). Previous sessions and clinical grants were discarded; launch applications afresh.\n`);
    } else {
      const newKey = (await readPrivateOperationsFile(values.get('--new-key-file')!, 1024)).trim();
      keyBytes(newKey).fill(0);
      if (key === newKey) throw new OperationsError('The replacement encryption key must differ from the current key.');
      const output = await createBackup({ repository, key, offline });
      await verifyBackup({ backup: output, key });
      await writePrivateOperationsFile(values.get('--output')!, output);
      await rotateEncryptionKey({ repository, currentKey: key, newKey, offline });
      process.stdout.write('Vault key rotated atomically. Update deployment ENCRYPTION_KEY to the new key BEFORE restarting every instance. The backup still requires the OLD key.\n');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof OperationsError ? error.message : 'Maintenance failed. Check private files, deployment configuration, database access, and the encryption key. Driver details and credentials are omitted.'}\n`);
    process.exitCode = 1;
  } finally { await repository?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
