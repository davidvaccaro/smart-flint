/** Disposable Docker/PostgreSQL/TLS/Keycloak acceptance. Never reads the saved registry or deployment .env. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Agent, fetch } from 'undici';
import { chromium } from '@playwright/test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = `flint-accept-${randomBytes(5).toString('hex')}`;
const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
const image = process.env.SMART_FLINT_TEST_IMAGE ?? `smart-flint:${prefix}`;
const nodeImage = 'node:24.22.1-bookworm-slim';
const keycloakImage = 'quay.io/keycloak/keycloak:26.8.1';
const containers = [];
let network = false, backupVolume = false, dispatcher, browser, stage = 'setup';
const ownerPassword = `Release owner ${randomBytes(24).toString('base64url')}!`;
const bootstrap = randomBytes(48).toString('base64url');
const oidcClientSecret = randomBytes(32).toString('base64url');
const subject = randomUUID();
let cookie = '';

async function run(command, args, options = {}) {
  try { return (await execute(command, args, { cwd: root, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, BUILDX_CONFIG: process.env.BUILDX_CONFIG ?? join(directory, 'buildx') }, ...options })).stdout.trim(); }
  catch { throw new Error(`Command failed during ${stage}.`); }
}
const docker = (...args) => run('docker', args);
async function wait(check, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise(resolveWait => setTimeout(resolveWait, 500)); }
  throw new Error(`Timed out during ${stage}.`);
}
function progress(value) { stage = value; console.log(`Production acceptance: ${value}`); }
async function container(name, args) { const full = `${prefix}-${name}`; containers.push(full); await docker('run', '--detach', '--name', full, '--network', prefix, '--network-alias', name, ...args); return full; }
async function freePort() {
  const server = net.createServer(); await new Promise((yes, no) => server.once('error', no).listen(0, '127.0.0.1', yes));
  const value = server.address().port; await new Promise(yes => server.close(yes)); return value;
}

try {
  const port = await freePort();
  const origin = `https://flint.production.test:${port}`, issuer = `https://identity.production.test:${port}/realms/flint-release`;
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=SMART Flint isolated acceptance',
    '-addext', 'subjectAltName=DNS:flint.production.test,DNS:identity.production.test', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')]);
  const ca = await readFile(join(directory, 'cert.pem'));
  dispatcher = new Agent({ connect: { ca, lookup(hostname, options, callback) {
    if (!['flint.production.test', 'identity.production.test'].includes(hostname)) return callback(new Error('Unexpected acceptance hostname'), '', 4);
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]); else callback(null, '127.0.0.1', 4);
  } } });
  async function request(path, { method = 'GET', payload, credential = cookie } = {}) {
    const response = await fetch(`${origin}${path}`, { method, dispatcher, redirect: 'manual', headers: { origin,
      ...(credential ? { cookie: credential } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(10_000) });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch {}
    return { response, value, text };
  }
  await copyFile(join(root, 'scripts/production-test-edge.mjs'), join(directory, 'edge.mjs'));
  await writeFile(join(directory, 'realm.json'), JSON.stringify({ realm: 'flint-release', enabled: true, sslRequired: 'external',
    clients: [{ clientId: 'flint-admin', enabled: true, publicClient: false, secret: oidcClientSecret, standardFlowEnabled: true,
      redirectUris: [`${origin}/api/admin/oidc/callback`], webOrigins: [origin], attributes: { 'pkce.code.challenge.method': 'S256' } }],
    users: [{ id: subject, username: 'release-owner', enabled: true, firstName: 'Release', lastName: 'Owner', email: 'owner@example.invalid', emailVerified: true,
      credentials: [{ type: 'password', value: ownerPassword, temporary: false }] }] }), { mode: 0o600 });
  const envFile = join(directory, 'flint.env');
  const baseEnv = { NODE_ENV: 'production', DEMO_MODE: 'false', HOST: '0.0.0.0', PORT: '3001', BASE_URL: origin, CONSOLE_URL: origin,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), ADMIN_TOKEN: bootstrap, ADMIN_BOOTSTRAP_ENABLED: 'true', ADMIN_AUTH_MODE: 'local',
    DATABASE_URL: 'postgresql://flint_test:isolated-postgres-password@postgres:5432/flint_test', OPERATIONS_LOGGING: 'true',
    NODE_EXTRA_CA_CERTS: '/fixture/cert.pem', ALLOW_PRIVATE_NETWORKS: 'true' };
  const saveEnv = async env => writeFile(envFile, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  await saveEnv(baseEnv);
  const composeEnv = join(directory, 'compose.env');
  await writeFile(composeEnv, `${Object.entries({ ...baseEnv, POSTGRES_PASSWORD: 'isolated-compose-password' }).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  const compose = JSON.parse(await docker('compose', '--env-file', composeEnv, '-f', 'compose.yaml', 'config', '--format', 'json'));
  assert.equal(compose.services.flint.environment.DEMO_MODE, 'false');
  assert.equal(compose.services.flint.environment.ADMIN_AUTH_MODE, 'local');
  assert.ok(compose.services.flint.ports.every(value => value.host_ip === '127.0.0.1'));
  progress('build production image');
  if (!process.env.SMART_FLINT_TEST_IMAGE) await docker('build', '--pull', '-f', 'deploy/Dockerfile', '-t', image, '.');
  progress('start isolated PostgreSQL and HTTPS edge');
  await docker('network', 'create', prefix); network = true;
  await container('postgres', ['-e', 'POSTGRES_USER=flint_test', '-e', 'POSTGRES_PASSWORD=isolated-postgres-password', '-e', 'POSTGRES_DB=flint_test', 'postgres:17-bookworm']);
  await wait(async () => { await docker('exec', `${prefix}-postgres`, 'pg_isready', '-U', 'flint_test'); return true; });
  const mount = `${directory}:/fixture:ro`;
  await container('edge', ['--network-alias', 'flint.production.test', '--network-alias', 'identity.production.test', '-p', `127.0.0.1:${port}:${port}`,
    '-e', `TEST_TLS_PORT=${port}`, '-v', mount, nodeImage, 'node', '/fixture/edge.mjs']);
  // Mount only the public trust certificate into the unprivileged service container.
  // Private fixture/environment files remain outside its filesystem.
  await run('chmod', ['644', join(directory, 'cert.pem')]);
  const startFlint = () => container('flint', ['--env-file', envFile, '-v', `${join(directory, 'cert.pem')}:/fixture/cert.pem:ro`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', image]);
  await startFlint();
  await wait(async () => (await request('/ready')).response.status === 200);
  assert.equal((await request('/')).response.status, 200);
  assert.equal((await request('/api/admin/session')).value.localEnabled, true);
  progress('first owner, secure cookie, bootstrap retirement and restart persistence');
  const setup = await request('/api/admin/session', { method: 'POST', payload: { token: bootstrap } });
  assert.equal(setup.response.status, 200); assert.match(setup.response.headers.get('set-cookie'), /;\s*Secure/i); assert.match(setup.response.headers.get('set-cookie'), /;\s*HttpOnly/i);
  cookie = setup.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const created = await request('/api/admin/users', { method: 'POST', payload: { authMethod: 'local', username: 'release-owner', password: ownerPassword,
    displayName: 'Release acceptance owner', role: 'platform_admin', organizationIds: [], applicationIds: [] } });
  assert.equal(created.response.status, 201);
  assert.ok(!created.text.includes(ownerPassword));
  assert.equal((await request('/api/admin/session', { method: 'POST', payload: { token: bootstrap }, credential: '' })).response.status, 401);
  const login = await request('/api/admin/session', { method: 'POST', payload: { username: 'release-owner', password: ownerPassword }, credential: '' });
  assert.equal(login.response.status, 200); cookie = login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  await docker('restart', `${prefix}-flint`);
  await wait(async () => (await request('/ready')).response.status === 200);
  assert.equal((await request('/api/admin/session')).value.authenticated, true);
  assert.equal((await request('/api/admin/users')).value.length, 1);
  progress('readiness failure and bounded redacted diagnostics');
  await docker('stop', `${prefix}-postgres`);
  assert.equal((await request('/ready')).response.status, 503);
  assert.equal((await request('/health')).response.status, 200);
  await docker('start', `${prefix}-postgres`);
  await wait(async () => (await request('/ready')).response.status === 200);
  assert.equal((await request('/api/admin/operations')).response.status, 200);
  const logs = await docker('logs', `${prefix}-flint`);
  assert.ok(!logs.includes(ownerPassword) && !logs.includes(bootstrap) && !logs.includes(baseEnv.ENCRYPTION_KEY));
  await docker('stop', `${prefix}-flint`);
  const cli = await docker('run', '--rm', '--network', prefix, '--env-file', envFile, '-v', mount, image, 'node', 'apps/server/dist/scripts/operations.js', '--help');
  assert.match(cli, /backup|Usage/i);

  progress('compiled production backup, verification and restore into a fresh database');
  await docker('volume', 'create', `${prefix}-backups`); backupVolume = true;
  const maintenance = (...args) => docker('run', '--rm', '--user', '0:0', '--network', prefix, '--env-file', envFile,
    '-v', `${join(directory, 'cert.pem')}:/fixture/cert.pem:ro`, '-v', `${prefix}-backups:/backups`, image, 'node', 'apps/server/dist/scripts/operations.js', ...args);
  await maintenance('backup', '--offline', '--output', '/backups/production.flint-backup');
  await maintenance('verify', '--input', '/backups/production.flint-backup');
  await docker('exec', `${prefix}-postgres`, 'createdb', '-U', 'flint_test', 'flint_restored');
  baseEnv.DATABASE_URL = 'postgresql://flint_test:isolated-postgres-password@postgres:5432/flint_restored';
  await saveEnv(baseEnv);
  await maintenance('restore', '--offline', '--input', '/backups/production.flint-backup');
  await docker('rm', `${prefix}-flint`); await startFlint();
  await wait(async () => (await request('/ready')).response.status === 200);
  assert.equal((await request('/api/admin/session')).value.authenticated, false);
  const recovered = await request('/api/admin/session', { method: 'POST', payload: { username: 'release-owner', password: ownerPassword }, credential: '' });
  assert.equal(recovered.response.status, 200);
  cookie = recovered.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await request('/api/admin/users')).value.length, 1);
  await docker('stop', `${prefix}-flint`);

  progress('real Keycloak provider with HTTPS, S256 PKCE and named-user authorization');
  await container('keycloak', ['--user', '0:0', '-e', `KC_HOSTNAME=${issuer.replace('/realms/flint-release', '')}`, '-e', 'KC_PROXY_HEADERS=xforwarded',
    '-e', 'KC_HTTP_ENABLED=true', '-v', `${join(directory, 'realm.json')}:/opt/keycloak/data/import/flint.json:ro`, keycloakImage, 'start-dev', '--import-realm']);
  await wait(async () => { const response = await fetch(`${issuer}/.well-known/openid-configuration`, { dispatcher, signal: AbortSignal.timeout(5000) }); await response.text(); return response.status === 200; }, 180);
  await docker('rm', `${prefix}-flint`);
  await saveEnv({ ...baseEnv, ADMIN_AUTH_MODE: 'oidc', ADMIN_OIDC_ISSUER: issuer, ADMIN_OIDC_CLIENT_ID: 'flint-admin',
    ADMIN_OIDC_AUTH_METHOD: 'client_secret_basic', ADMIN_OIDC_CLIENT_SECRET: oidcClientSecret });
  await startFlint(); cookie = '';
  await wait(async () => (await request('/ready')).response.status === 200);
  const oidcSetup = await request('/api/admin/session', { method: 'POST', payload: { token: bootstrap } });
  assert.equal(oidcSetup.response.status, 200);
  cookie = oidcSetup.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await request('/api/admin/users', { method: 'POST', payload: { authMethod: 'oidc', issuer, subject,
    displayName: 'Keycloak release owner', role: 'platform_admin', organizationIds: [], applicationIds: [] } })).response.status, 201);
  assert.equal((await request('/api/admin/session', { method: 'POST', payload: { username: 'release-owner', password: ownerPassword }, credential: '' })).response.status, 401);
  const cert = new X509Certificate(ca), spki = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(chrome) ? { executablePath: chrome } : {}),
    args: [`--ignore-certificate-errors-spki-list=${spki}`, '--host-resolver-rules=MAP *.production.test 127.0.0.1', '--no-proxy-server'] });
  const context = await browser.newContext(); const page = await context.newPage();
  progress('redirect to the real Keycloak sign-in page');
  await page.goto(`${origin}/api/admin/oidc/login`);
  assert.equal(new URL(page.url()).origin, new URL(issuer).origin);
  progress('authenticate with Keycloak and validate the signed OIDC callback');
  await page.locator('#username').fill('release-owner'); await page.locator('#password').fill(ownerPassword);
  await Promise.all([page.waitForURL(url => url.origin === origin && !url.pathname.startsWith('/api/'), { timeout: 60_000 }), page.locator('#kc-login').click()]);
  const status = await page.evaluate(async () => (await fetch('/api/admin/session')).json());
  assert.equal(status.authenticated, true); assert.equal(status.identity.kind, 'oidc'); assert.equal(status.identity.role, 'platform_admin');
  assert.equal(status.bootstrapEnabled, false); assert.equal(status.localEnabled, false);
  const sessionCookies = await context.cookies();
  assert.ok(sessionCookies.some(value => value.name === 'smart_flint_admin' && value.secure && value.httpOnly));
  await page.evaluate(async () => fetch('/api/admin/session', { method: 'DELETE' }));
  assert.equal((await page.evaluate(async () => (await fetch('/api/admin/session')).json())).authenticated, false);
  console.log('Production acceptance passed: Compose configuration, clean compiled container/PostgreSQL, TLS, owner setup, persistence, failed-database readiness, actual encrypted backup/restore, redacted logs, and real Keycloak SSO.');
} catch (error) {
  console.error(`Production acceptance failed at: ${stage}. No credentials or provider responses are printed.`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch {}
  try { await dispatcher?.close(); } catch {}
  for (const name of [...new Set(containers)].reverse()) { try { await docker('rm', '--force', name); } catch {} }
  if (network) { try { await docker('network', 'rm', prefix); } catch {} }
  if (backupVolume) { try { await docker('volume', 'rm', `${prefix}-backups`); } catch {} }
  if (!process.env.SMART_FLINT_TEST_IMAGE) { try { await docker('image', 'rm', image); } catch {} }
  await rm(directory, { recursive: true, force: true });
}
