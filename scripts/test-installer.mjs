/** Public installer acceptance with disposable directories, projects and synthetic identities. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Agent, fetch } from 'undici';
import { setupLocalCertificates, createLocalHTTPSProxy } from './local-https.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'smart-flint-installer-acceptance-'));
const execute = promisify(execFile);
const installations = [];
const generatedImages = [];
const imageSuffix = randomBytes(6).toString('hex');
const productionImage = process.env.SMART_FLINT_INSTALLER_TEST_IMAGE ?? `smart-flint:installer-accept-${imageSuffix}`;
const sandboxImage = process.env.SMART_FLINT_INSTALLER_SANDBOX_IMAGE ?? `smart-flint-sandbox:installer-accept-${imageSuffix}`;
const reserved = new Set([3000, 3001, 3010, 3443, 4010, 4100, 4101, 4102]);
let stage = 'prerequisites', tls, dispatcher, occupied;
const output = [];

function progress(value) { stage = value; console.log(`Installer acceptance: ${value}`); }
async function command(binary, args, options = {}) {
  const result = await execute(binary, args, { cwd: root, timeout: 900_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, BUILDX_CONFIG: process.env.BUILDX_CONFIG ?? join(directory, 'buildx') }, ...options });
  return { stdout: result.stdout, stderr: result.stderr };
}
async function install(args, expectedSuccess = true) {
  let result;
  try { result = await command('bash', [join(root, 'install.sh'), ...args]); }
  catch (error) {
    if (expectedSuccess) {
      // Fixtures are synthetic and this report stays in the ignored private evidence directory.
      // Console output remains fixed so an unexpected wrapper response cannot expose a credential.
      await writeFile(join(root, '.data/installer-acceptance-error.log'), `${stage}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { mode: 0o600 });
      throw new Error(`Installer command failed during ${stage}.`);
    }
    result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', failed: true };
  }
  output.push(`${result.stdout}\n${result.stderr}`);
  assert.ok(expectedSuccess ? !result.failed : result.failed, expectedSuccess ? 'Installer unexpectedly failed.' : 'Installer unexpectedly accepted an unsafe request.');
  return result;
}
async function freePort() {
  for (;;) {
    const server = net.createServer();
    await new Promise((yes, no) => server.once('error', no).listen(0, '127.0.0.1', yes));
    const port = server.address().port;
    await new Promise(yes => server.close(yes));
    if (!reserved.has(port)) { reserved.add(port); return port; }
  }
}
async function wait(check, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise(yes => setTimeout(yes, 500));
  }
  throw new Error(`Readiness timed out during ${stage}.`);
}
async function document(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function request(origin, path, { method = 'GET', payload, cookie = '', headers = {}, trust } = {}) {
  const response = await fetch(`${origin}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    ...(trust ? { dispatcher: trust } : {}), headers: { origin, ...(cookie ? { cookie } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const text = await response.text(); let value; try { value = JSON.parse(text); } catch {}
  return { response, value, text };
}
async function privateFile(path) {
  const metadata = await stat(path);
  assert.ok(metadata.isFile(), 'Expected a persisted installation file.');
  if (process.platform !== 'win32') assert.equal(metadata.mode & 0o077, 0, 'Deployment secrets must not be group/world accessible.');
}
function cookies(response) { return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); }
async function cleanupInstallation(path) {
  if (!path.startsWith(directory + '/') || !existsSync(join(path, 'compose.yaml'))) return;
  // These are only disposable acceptance fixtures; never use volume deletion on a user installation.
  try { await command('docker', ['compose', '--file', join(path, 'compose.yaml'), 'down', '--volumes', '--remove-orphans']); } catch {}
  try {
    const state = await document(join(path, 'installation.json'));
    const image = state.plan?.settings?.image;
    if (typeof image === 'string' && /^smart-flint-installed:[a-z0-9._-]+$/.test(image)) await command('docker', ['image', 'rm', image]);
  } catch {}
}

try {
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  await command('docker', ['compose', 'version', '--short']);
  await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
  await rm(join(root, '.data/installer-acceptance-error.log'), { force: true });
  for (const [supplied, image, dockerfile] of [
    [process.env.SMART_FLINT_INSTALLER_TEST_IMAGE, productionImage, 'deploy/Dockerfile'],
    [process.env.SMART_FLINT_INSTALLER_SANDBOX_IMAGE, sandboxImage, 'deploy/Dockerfile.sandbox'],
  ]) {
    if (supplied) continue;
    progress(`build disposable ${dockerfile.includes('sandbox') ? 'sandbox' : 'production'} test image`);
    generatedImages.push(image);
    await command('docker', ['build', '--pull', '--file', dockerfile, '--tag', image, root]);
  }
  progress('checksummed gzip image export and immutable archive installation');
  const rawArchive = join(directory, 'installer-runtime.tar'), imageArchive = join(directory, 'installer-runtime.tar.gz');
  await command('docker', ['save', '--output', rawArchive, productionImage]);
  await pipeline(createReadStream(rawArchive), createGzip(), createWriteStream(imageArchive, { mode: 0o600 }));
  const archiveHash = createHash('sha256'); for await (const chunk of createReadStream(imageArchive)) archiveHash.update(chunk);
  await writeFile(join(directory, 'SHA256SUMS'), `${archiveHash.digest('hex')}  installer-runtime.tar.gz\n`, { mode: 0o600 });
  progress('public help and isolated configure-only deployment');
  await install(['--help']);
  const deploy = join(directory, 'production'); installations.push(deploy);
  const backendPort = await freePort(), tlsPort = await freePort();
  const certificates = await setupLocalCertificates(join(directory, 'tls'));
  tls = await createLocalHTTPSProxy({ ...certificates, host: '127.0.0.1', port: tlsPort, targetOrigin: `http://127.0.0.1:${backendPort}` });
  dispatcher = new Agent({ connect: { ca: await readFile(certificates.caCertPath, 'utf8') } });
  const deployFlags = ['--mode', 'deploy', '--directory', deploy, '--public-url', tls.origin, '--tls', 'external', '--auth', 'local',
    '--port', String(backendPort), '--non-interactive', '--no-open', '--image-archive', imageArchive];
  await install([...deployFlags, '--configure-only']);
  const secretsPath = join(deploy, 'setup-secrets.json');
  await privateFile(secretsPath); await privateFile(join(deploy, 'compose.yaml'));
  const before = await readFile(secretsPath, 'utf8'), secrets = JSON.parse(before);
  assert.ok(typeof secrets.bootstrapToken === 'string' && secrets.bootstrapToken.length >= 32, 'Initial deployment credential was not created.');
  assert.ok(typeof secrets.encryptionKey === 'string' && Buffer.from(secrets.encryptionKey, 'base64').length === 32, 'Master key was not created.');
  assert.ok(output.every(value => !value.includes(secrets.bootstrapToken) && !value.includes(secrets.encryptionKey) && !value.includes(secrets.postgresPassword)), 'Installer output exposed a credential.');
  const composed = await document(join(deploy, 'compose.yaml'));
  assert.ok(composed.services.flint.ports.every(value => value.startsWith('127.0.0.1:')), 'External TLS backend must bind only to loopback.');

  progress('start, first owner, secure session and persisted database state');
  await install(['--action', 'start', '--directory', deploy, '--non-interactive', '--no-open']);
  const expectedImage = (await command('docker', ['image', 'inspect', '--format', '{{.Id}}', productionImage])).stdout.trim();
  assert.equal((await document(join(deploy, 'installation.json'))).resolvedImageId, expectedImage, 'Configure-only must retain the chosen image for subsequent start.');
  await wait(async () => (await request(tls.origin, '/ready', { trust: dispatcher })).response.status === 200);
  const session = await request(tls.origin, '/api/admin/session', { method: 'POST', payload: { token: secrets.bootstrapToken }, trust: dispatcher });
  assert.equal(session.response.status, 200); assert.match(session.response.headers.get('set-cookie'), /;\s*Secure/i);
  const password = `Installer fixture ${randomBytes(24).toString('base64url')}!`;
  const ownerConfig = join(directory, 'first-owner.json');
  await writeFile(ownerConfig, JSON.stringify({ owner: { username: 'installer-owner', password, displayName: 'Installer acceptance owner' } }), { mode: 0o600 });
  progress('first-owner creation through private config and installer stdin');
  await install(['--action', 'start', '--directory', deploy, '--config', ownerConfig, '--non-interactive', '--no-open']);
  assert.equal((await request(tls.origin, '/api/admin/session', { cookie: cookies(session.response), trust: dispatcher })).value.authenticated, false);
  const login = await request(tls.origin, '/api/admin/session', { method: 'POST', payload: { username: 'installer-owner', password }, trust: dispatcher });
  assert.equal(login.response.status, 200);
  const organization = await request(tls.origin, '/api/admin/tenants', { method: 'POST', cookie: cookies(login.response), trust: dispatcher, payload: { name: 'Installer persistence fixture' } });
  assert.equal(organization.response.status, 201);
  await install(['--action', 'status', '--directory', deploy, '--non-interactive', '--no-open']);
  await install(['--action', 'stop', '--directory', deploy, '--non-interactive', '--no-open']);
  await install(['--directory', deploy, '--non-interactive', '--no-open']);
  await wait(async () => (await request(tls.origin, '/ready', { trust: dispatcher })).response.status === 200);
  assert.ok((await readFile(secretsPath, 'utf8')) === before, 'Resume regenerated saved deployment credentials.');
  const restoredLogin = await request(tls.origin, '/api/admin/session', { method: 'POST', payload: { username: 'installer-owner', password }, trust: dispatcher });
  assert.equal(restoredLogin.response.status, 200);
  const dashboard = await request(tls.origin, '/api/admin/dashboard', { cookie: cookies(restoredLogin.response), trust: dispatcher });
  assert.ok(dashboard.value.tenants.some(value => value.id === organization.value.id), 'Stop/resume lost the installation database.');
  assert.equal((await request(tls.origin, '/api/admin/session', { method: 'POST', payload: { token: secrets.bootstrapToken }, trust: dispatcher })).response.status, 401);

  progress('safe failure on mode changes, unrelated directories and occupied host ports');
  await install(['--mode', 'sandbox', '--directory', deploy, '--non-interactive', '--no-open'], false);
  assert.ok((await readFile(secretsPath, 'utf8')) === before, 'Rejected mode change altered credentials.');
  const unrelated = join(directory, 'unrelated'); await mkdir(unrelated); await writeFile(join(unrelated, 'keep.txt'), 'preserve');
  await install(['--mode', 'sandbox', '--directory', unrelated, '--non-interactive', '--no-open'], false);
  assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'preserve');
  occupied = net.createServer(); await new Promise((yes, no) => occupied.once('error', no).listen(0, '127.0.0.1', yes));
  const occupiedPath = join(directory, 'occupied'); installations.push(occupiedPath);
  const conflictPorts = Object.fromEntries(await Promise.all(['mock-port', 'patient-port', 'cds-port', 'fhir-port'].map(async key => [key, await freePort()])));
  await install(['--mode', 'sandbox', '--directory', occupiedPath, '--port', String(occupied.address().port),
    ...Object.entries(conflictPorts).flatMap(([key, value]) => [`--${key}`, String(value)]), '--image', sandboxImage, '--non-interactive', '--no-open'], false);
  await new Promise(yes => occupied.close(yes)); occupied = undefined;

  progress('Docker-only sandbox with isolated samples and a synthetic patient launch');
  const sandbox = join(directory, 'sandbox'); installations.push(sandbox);
  const ports = Object.fromEntries(await Promise.all(['port', 'mock-port', 'patient-port', 'cds-port', 'fhir-port'].map(async key => [key, await freePort()])));
  const flags = ['--mode', 'sandbox', '--directory', sandbox, '--non-interactive', '--no-open',
    ...Object.entries(ports).flatMap(([key, value]) => [`--${key}`, String(value)]),
    '--image', sandboxImage];
  await install(flags);
  const bridge = `http://127.0.0.1:${ports.port}`, mock = `http://127.0.0.1:${ports['mock-port']}`, patient = `http://127.0.0.1:${ports['patient-port']}`;
  await wait(async () => (await request(bridge, '/ready')).response.status === 200);
  assert.equal((await request(bridge, '/api/admin/session')).value.authMode, 'demo');
  assert.equal((await request(patient, '/')).response.status, 200);
  assert.equal((await request(mock, '/epic/northstar/r4/metadata')).response.status, 200);
  const launch = await request(mock, `/epic/northstar/ehr-launch?patient=patient-b&launch_url=${encodeURIComponent(`${bridge}/launch/inst_health_northstar`)}`);
  assert.equal(launch.response.status, 302);
  const ehr = await fetch(launch.response.headers.get('location'), { redirect: 'manual' });
  assert.equal(ehr.status, 302);
  const callback = new URL(ehr.headers.get('location'));
  assert.equal(callback.origin, patient);
  const ticket = callback.searchParams.get('smart_flint_launch'); assert.ok(ticket);
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const start = await request(bridge, '/api/launches', { method: 'POST', payload: { installationId: 'inst_health_northstar', redirectUri: `${patient}/callback`, codeChallenge: challenge, state, launchTicket: ticket } });
  assert.equal(start.response.status, 200);
  const authorizing = await fetch(start.value.launchUrl, { redirect: 'manual' }); assert.equal(authorizing.status, 302);
  const authorize = new URL(authorizing.headers.get('location')); assert.equal(authorize.origin, mock);
  const consent = await fetch(authorize); assert.equal(consent.status, 200);
  const transaction = /name="transaction" value="([^"]+)"/.exec(await consent.text())?.[1]; assert.ok(transaction);
  const decision = await fetch(new URL(authorize.pathname.replace(/authorize$/, 'decision'), mock), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ transaction, decision: 'allow', patient: 'patient-b' }) });
  assert.equal(decision.status, 302);
  const authorized = await fetch(decision.headers.get('location'), { redirect: 'manual', headers: { cookie: cookies(authorizing) } });
  assert.equal(authorized.status, 302);
  const destination = new URL(authorized.headers.get('location')); assert.equal(destination.origin, patient); assert.equal(destination.searchParams.get('state'), state);
  const activation = await request(bridge, '/api/activations/redeem', { method: 'POST', payload: { code: destination.searchParams.get('code'), codeVerifier: verifier, applicationId: start.value.applicationId, redirectUri: `${patient}/callback` } });
  assert.equal(activation.response.status, 200);
  const fhir = await fetch(`${activation.value.activation.gateway.baseUrl}/Patient/patient-b`, { headers: { authorization: `Bearer ${activation.value.sessionToken}` } });
  assert.equal(fhir.status, 200); assert.equal((await fhir.json()).id, 'patient-b');
  assert.equal((await request(bridge, `/api/activations/${activation.value.activation.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${activation.value.sessionToken}` } })).response.status, 204);
  const sandboxCompose = await document(join(sandbox, 'compose.yaml'));
  assert.notEqual(sandboxCompose.name, composed.name, 'Distinct installation directories must use distinct Compose projects.');
  assert.ok(Object.values(sandboxCompose.services).flatMap(value => value.ports ?? []).every(value => value.startsWith('127.0.0.1:')), 'Sandbox ports must bind only to loopback.');
  await install(['--action', 'stop', '--directory', sandbox, '--non-interactive', '--no-open']);
  assert.ok(output.every(value => !value.includes(password) && !value.includes(secrets.bootstrapToken) && !value.includes(secrets.encryptionKey)), 'Installer output exposed a credential.');
  console.log('Installer acceptance passed: public Docker-only wrapper, private configuration, fresh deployment, owner setup, stop/resume persistence, safe failures, isolated sandbox samples and synthetic EHR patient launch.');
} catch {
  console.error(`Installer acceptance failed at: ${stage}. No credentials or authorization traces are printed.`); process.exitCode = 1;
} finally {
  if (occupied) await new Promise(yes => occupied.close(yes));
  try { await dispatcher?.close(); } catch {}
  try { await tls?.close(); } catch {}
  for (const path of installations.reverse()) await cleanupInstallation(path);
  for (const image of generatedImages.reverse()) { try { await command('docker', ['image', 'rm', image]); } catch {} }
  await rm(directory, { recursive: true, force: true });
}
