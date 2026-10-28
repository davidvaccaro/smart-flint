import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createLocalHTTPSProxy, setupLocalCertificates } from './local-https.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** Reject ambiguous production/database settings before starting any development service. */
export async function validateDevelopmentEnvironment(root, environment = process.env) {
  let local = {};
  try { local = parseEnv(await readFile(join(root, '.env'), 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw new Error('The project .env could not be safely read.'); }
  if (local.NODE_ENV === 'production' || environment.NODE_ENV === 'production'
    || local.DEMO_MODE === 'false' || environment.DEMO_MODE === 'false'
    || local.DATABASE_URL?.trim() || environment.DATABASE_URL?.trim()) {
    throw new Error('The local HTTPS demo profile refuses production .env settings or a configured DATABASE_URL. Use a separate development checkout with its local SQLite database.');
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0' || local.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Remove NODE_TLS_REJECT_UNAUTHORIZED=0 before using trusted local HTTPS.');
  }
  const configuredSQLite = environment.SQLITE_PATH ?? local.SQLITE_PATH;
  if (configuredSQLite && !isAbsolute(configuredSQLite)) throw new Error('For this profile, SQLITE_PATH must be an absolute path inside the project .data directory.');
  const dataDirectory = resolve(root, '.data');
  const sqlitePath = configuredSQLite ? resolve(configuredSQLite) : join(dataDirectory, 'smart-flint.sqlite');
  const suffix = relative(dataDirectory, sqlitePath);
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('The local HTTPS profile only uses a SQLite file inside the project .data directory.');
  let checked = dataDirectory;
  for (const part of ['', ...suffix.split('/')]) {
    if (part) checked = join(checked, part);
    try { if ((await lstat(checked)).isSymbolicLink()) throw new Error('The local development data path must not contain symbolic links.'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return { sqlitePath, extraCAPath: environment.NODE_EXTRA_CA_CERTS ?? local.NODE_EXTRA_CA_CERTS };
}

/** Preserve an operator's extra public CA bundle without ever copying private-key material. */
export async function prepareNodeCABundle(certificates, configuredPath) {
  if (!configuredPath || resolve(configuredPath) === certificates.caCertPath) return certificates.caCertPath;
  const metadata = await lstat(configuredPath);
  if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) throw new Error('NODE_EXTRA_CA_CERTS must name a bounded PEM certificate bundle.');
  const existing = await readFile(configuredPath, 'utf8');
  const blocks = existing.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const remainder = existing.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').replace(/^\s*#.*$/gm, '');
  if (!blocks.length || remainder.trim()) throw new Error('NODE_EXTRA_CA_CERTS may contain only public PEM certificates and comments.');
  for (const block of blocks) new X509Certificate(block);
  const combinedPath = join(certificates.directory, 'combined-ca.pem');
  try { if ((await lstat(combinedPath)).isSymbolicLink()) throw new Error('The combined CA bundle must not be a symbolic link.'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const handle = await open(combinedPath, 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${blocks.join('\n')}\n${await readFile(certificates.caCertPath, 'utf8')}`);
  } finally { await handle.close(); }
  return combinedPath;
}

async function requireFreePort(port) {
  const probe = net.createServer();
  await new Promise((resolveProbe, rejectProbe) => {
    probe.once('error', () => rejectProbe(new Error(`Local development port ${port} is already in use. Stop only your existing SMART Flint development command, then retry; no process was stopped automatically.`)));
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(error => error ? rejectProbe(error) : resolveProbe()));
  });
}

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}
async function stopGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 5_000;
  while (groupExists(pid) && Date.now() < deadline) await delay(50);
  if (groupExists(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
}

export async function startLocalHTTPSDevelopment() {
  if (process.platform === 'win32') throw new Error('This local HTTPS launcher currently requires macOS or Linux for development process-group cleanup.');
  const { sqlitePath, extraCAPath } = await validateDevelopmentEnvironment(projectRoot);
  // A conflict is reported before a new stack is spawned. Existing listeners are never stopped.
  for (const port of [3010, 3001, 4010, 4100, 4101, 4102, 3443]) await requireFreePort(port);
  const certificates = await setupLocalCertificates(join(projectRoot, '.data/https'));
  const caPath = await prepareNodeCABundle(certificates, extraCAPath);
  const proxy = await createLocalHTTPSProxy({ ...certificates, host: '127.0.0.1', port: 3443, targetOrigin: 'http://127.0.0.1:3001' });
  const environment = {
    ...process.env, NODE_ENV: 'development', DEMO_MODE: 'true', HOST: '127.0.0.1', PORT: '3001',
    BASE_URL: proxy.origin, VITE_SMART_FLINT_URL: proxy.origin, SMART_FLINT_URL: proxy.origin,
    CONSOLE_URL: 'http://127.0.0.1:3010', SAMPLE_PATIENT_URL: 'http://127.0.0.1:4100',
    SAMPLE_CDS_URL: 'http://127.0.0.1:4101', SAMPLE_FHIR_URL: 'http://127.0.0.1:4102',
    MOCK_EHR_URL: 'http://127.0.0.1:4010', MOCK_EHR_HOST: '127.0.0.1', MOCK_EHR_PORT: '4010',
    CDS_SAMPLE_HOST: '127.0.0.1', CDS_SAMPLE_PORT: '4101', FHIR_SAMPLE_HOST: '127.0.0.1', FHIR_SAMPLE_PORT: '4102',
    SQLITE_PATH: sqlitePath, NODE_EXTRA_CA_CERTS: caPath,
  };
  let child;
  let requestedSignal;
  let stopping;
  const shutdown = () => stopping ??= Promise.all([stopGroup(child?.pid), proxy.close()]);
  const onSignal = signal => { requestedSignal = signal; void shutdown().catch(() => undefined); };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try {
    process.stdout.write(`Local HTTPS API: ${proxy.origin}\nConsole: http://127.0.0.1:3010\nPatient app: http://127.0.0.1:4100\nBrowser trust must be configured separately with npm run https:setup. No public tunnel is started.\n`);
    child = spawn('npm', ['run', 'dev'], { cwd: projectRoot, env: environment, stdio: 'inherit', detached: true });
    const code = await new Promise((resolveExit, rejectExit) => {
      child.once('error', () => rejectExit(new Error('The development stack could not be started.')));
      child.once('exit', exitCode => resolveExit(exitCode ?? 1));
    });
    return requestedSignal ? requestedSignal === 'SIGINT' ? 130 : 143 : code;
  } finally {
    await shutdown();
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await startLocalHTTPSDevelopment(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'The local HTTPS profile could not start.'}\n`);
    process.exitCode = 1;
  }
}
