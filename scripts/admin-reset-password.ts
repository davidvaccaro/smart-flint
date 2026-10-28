import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { AdminUser } from '../packages/contracts/src/index.js';
import { digest, openRepository, type Repository } from '../packages/storage/src/index.js';
import { Bridge } from '../apps/server/src/bridge.js';
import { configuredAdminMode, loadConfig, type Config } from '../apps/server/src/config.js';
import { normalizeUsername, setLocalPassword, validateAdminPassword } from '../apps/server/src/admin-passwords.js';

/** Messages from this class are fixed operator guidance and never include input or driver errors. */
export class AdminRecoveryError extends Error {}

export interface AdminRecoveryOptions {
  config: Config;
  username: string;
  password: string;
  /** Operator attestation: every service instance using this database has been stopped. */
  offline: boolean;
  /** Supplied repositories remain owned by their caller, useful for isolated tests. */
  repository?: Repository;
}

export async function resetLocalAdminPassword(options: AdminRecoveryOptions): Promise<{ userId: string; username: string }> {
  if (options.offline !== true)
    throw new AdminRecoveryError('Stop every SMART Flint instance using this database, then supply --offline to confirm.');
  if (configuredAdminMode(options.config) !== 'local')
    throw new AdminRecoveryError('Password recovery requires ADMIN_AUTH_MODE=local. OIDC accounts are managed by their identity provider.');
  let username: string;
  try { username = normalizeUsername(options.username); }
  catch { throw new AdminRecoveryError('Supply an existing local username using letters, digits, periods, underscores, or hyphens.'); }
  try { validateAdminPassword(options.password); }
  catch { throw new AdminRecoveryError('Choose a nontrivial password of 15–128 characters, at most 1024 UTF-8 bytes.'); }

  let repository: Repository | undefined;
  let bridge: Bridge | undefined;
  try {
    repository = options.repository ?? await openRepository({ databaseUrl: options.config.databaseUrl, sqlitePath: options.config.sqlitePath });
    bridge = new Bridge(repository, options.config);
    const service = bridge;
    return await repository.withLock('admin:write', async () => {
      const users = await service.repo.list<AdminUser>('admin_users');
      const matches = users.filter(user => user.authMethod === 'local' && typeof user.username === 'string'
        && user.username.trim().toLowerCase() === username);
      if (matches.length !== 1)
        throw new AdminRecoveryError('An unambiguous existing local account is required. Recovery never creates accounts or changes OIDC identities.');
      const user = matches[0]!;
      // The random credential version invalidates all earlier local sessions, including those on other instances.
      // Role, assignments, disabled state, and identity metadata are deliberately left untouched.
      await setLocalPassword(service, user.id, options.password);
      await service.repo.delete('replays', `admin-login:${digest(username)}`);
      await service.repo.delete('replays', `admin-password-change:${digest(user.id)}`);
      await service.audit('admin.password_reset', 'A local administrative password was reset by an offline operator; earlier local sessions were invalidated.', {
        outcome: 'success',
        actor: { id: 'local-recovery', displayName: 'Local recovery operator', kind: 'bootstrap', role: 'platform_admin' },
        resource: { type: 'admin_users', id: user.id },
      });
      return { userId: user.id, username };
    });
  } catch (error) {
    if (error instanceof AdminRecoveryError) throw error;
    throw new AdminRecoveryError('Password recovery failed. Check the deployment configuration, encryption key, and database access.');
  } finally {
    try { await bridge?.http.close(); }
    finally { if (!options.repository) await repository?.close(); }
  }
}

/** Read a bounded regular file without following its final symlink or ever blocking on a FIFO. */
export async function readRecoveryPasswordFile(path: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 || typeof process.getuid !== 'function')
      throw new AdminRecoveryError('Private password-file recovery requires POSIX file protections. Use the hidden interactive terminal prompt on this platform.');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    const wrongOwner = typeof process.getuid === 'function' && info.uid !== process.getuid();
    // A password file must be owner-readable/writable at most (0600); executable or shared files are refused.
    if (!info.isFile() || wrongOwner || (info.mode & 0o177) !== 0 || info.size > 2048)
      throw new AdminRecoveryError('The password file must be an owned, nonsymlink regular file with permissions 0600 or stricter and at most 2048 bytes.');
    const buffer = Buffer.alloc(2049);
    try {
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > 2048)
        throw new AdminRecoveryError('The password file must contain at most 2048 bytes.');
      const password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
      return password.replace(/\r?\n$/, '');
    } finally { buffer.fill(0); }
  } catch (error) {
    if (error instanceof AdminRecoveryError) throw error;
    throw new AdminRecoveryError('The password file could not be read securely. Use an owned, nonsymlink regular file with permissions 0600 or stricter.');
  } finally { await file?.close(); }
}

async function promptForPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new AdminRecoveryError('An interactive terminal is required. For automation, supply --password-file pointing to a private file.');
  // readline still handles editing and Ctrl-C, while its entire output (including input echo) is discarded.
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  const question = (label: string) => new Promise<string>((complete, reject) => {
    process.stderr.write(label);
    const cleanup = () => { input.off('line', answer); input.off('close', cancelled); input.off('SIGINT', interrupted); };
    const answer = (value: string) => { cleanup(); process.stderr.write('\n'); complete(value); };
    const cancelled = () => { cleanup(); reject(new AdminRecoveryError('Password recovery was cancelled.')); };
    const interrupted = () => { process.stderr.write('\n'); input.close(); };
    input.once('line', answer);
    input.once('close', cancelled);
    input.once('SIGINT', interrupted);
  });
  try {
    const password = await question('New local administrator password (hidden): ');
    const confirmation = await question('Confirm new password (hidden): ');
    if (password !== confirmation) throw new AdminRecoveryError('The password confirmation did not match. No account was changed.');
    return password;
  } finally { input.close(); muted.end(); }
}

export function parseRecoveryArguments(args: string[]): { offline: boolean; username: string; passwordFile?: string; help: boolean } {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { offline: false, username: '', help: true };
  let offline = false;
  let username: string | undefined;
  let passwordFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--offline' && !offline) { offline = true; continue; }
    if ((option === '--username' && username === undefined) || (option === '--password-file' && passwordFile === undefined)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new AdminRecoveryError('Each value option requires exactly one value. See --help.');
      if (option === '--username') username = value;
      else passwordFile = value;
      continue;
    }
    throw new AdminRecoveryError('Unknown or repeated recovery option. Passwords must never be supplied as command arguments. See --help.');
  }
  if (!offline) throw new AdminRecoveryError('Stop every SMART Flint instance using this database, then supply --offline to confirm.');
  if (!username) throw new AdminRecoveryError('Supply the existing local account with --username.');
  return { offline, username, passwordFile, help: false };
}

async function main() {
  try {
    const options = parseRecoveryArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: npm run admin:reset-password -- --offline --username admin [--password-file /secure/file]\nProduction container: node apps/server/dist/scripts/admin-reset-password.js --offline --username admin [--password-file /secure/file]\n\nStop ALL service instances using the database before this command. --offline confirms that you have done so; the command cannot detect remote instances.\nUse the deployment’s ADMIN_AUTH_MODE=local, database configuration, and ENCRYPTION_KEY.\nThe password is entered twice in a hidden terminal prompt, or read from an owned private file (0600 or stricter).\nRecovery changes only an existing local password, revokes prior local sessions, and preserves permissions and disabled state.\n');
      return;
    }
    let config: Config;
    try { config = loadConfig(); }
    catch { throw new AdminRecoveryError('The deployment configuration could not be loaded. Check its authentication mode, encryption key, and database settings.'); }
    if (configuredAdminMode(config) !== 'local')
      throw new AdminRecoveryError('Password recovery requires ADMIN_AUTH_MODE=local. OIDC accounts are managed by their identity provider.');
    const password = options.passwordFile ? await readRecoveryPasswordFile(options.passwordFile) : await promptForPassword();
    await resetLocalAdminPassword({ config, username: options.username, password, offline: options.offline });
    process.stdout.write('Password reset. Earlier local sessions are invalid. Restart SMART Flint before signing in.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof AdminRecoveryError ? error.message : 'Password recovery failed. Check the deployment configuration and database access.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
