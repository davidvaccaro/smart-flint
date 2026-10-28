#!/usr/bin/env node
/** Docker-only installation controller; wrappers mount source read-only and a private installation directory. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createProductionPlan } from './installer/production.mjs';
import { prepareImageArchive, IMAGE_ARCHIVE_ERROR } from './installer/image-archive.mjs';

export const sourceRoot = process.env.SMART_FLINT_SOURCE_DIRECTORY ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const version = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')).version;
const options = { mode: {}, directory: {}, action: { default: 'install' }, port: {}, 'mock-port': {}, 'patient-port': {}, 'cds-port': {}, 'fhir-port': {},
  'public-url': {}, tls: {}, auth: {}, config: {}, image: {}, 'image-archive': {}, checksums: {}, 'non-interactive': { type: 'boolean' },
  'no-open': { type: 'boolean' }, 'configure-only': { type: 'boolean' }, help: { type: 'boolean' } };
for (const value of Object.values(options)) if (!value.type) value.type = 'string';
const windowsHost = process.env.SMART_FLINT_HOST_PLATFORM === 'windows' && process.env.SMART_FLINT_WINDOWS_PRIVATE === '1';
const desktopHost = process.env.SMART_FLINT_HOST_PLATFORM === 'darwin' && process.env.SMART_FLINT_POSIX_PRIVATE === '1';
// Docker Desktop maps bind ownership to UID 0. Its wrapper checks the real
// host owner/modes before mounting; permissions remain enforced here.
const privateMode = stat => windowsHost || !process.getuid || ((stat.uid === process.getuid() || (desktopHost && stat.uid === 0)) && !(stat.mode & 0o077));
const imageRef = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,511}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const fixed = error => error?.installerMessage ?? 'The installer could not finish. Your saved configuration and data have been retained. Check Docker availability, selected ports and the installation guide.';
function problem(message) { const error = new Error(message); error.installerMessage = message; return error; }
function port(value, fallback) { const result = value === undefined ? fallback : Number(value); if (!Number.isInteger(result) || result < 1024 || result > 65535) throw problem('Choose application ports from 1024 to 65535.'); return result; }

export function parseInstallerArgs(argv) {
  let parsed; try { parsed = parseArgs({ args: argv, options, strict: true }); } catch { throw problem('Unknown installer option. Run the installer with --help.'); }
  const args = parsed.values;
  if (args.mode !== undefined && !['sandbox', 'deploy'].includes(args.mode)) throw problem('Choose --mode sandbox or --mode deploy.');
  if (!['install', 'start', 'stop', 'status'].includes(args.action)) throw problem('Choose --action install, start, stop or status.');
  return args;
}

export async function privateFile(path, maximum = 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !privateMode(stat) || stat.size > maximum) throw problem('Installation and input files must be owned, private regular files without symbolic links.');
  return readFile(path, 'utf8');
}
async function writeExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
async function replaceState(directory, value) {
  const temporary = join(directory, `.state-${randomUUID()}`);
  try { await writeExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, join(directory, 'installation.json')); }
  finally { await unlink(temporary).catch(() => {}); }
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

export function createSandboxPlan({ projectName, image, port: api = 3010, mockPort = 4010, patientPort = 4100, cdsPort = 4101, fhirPort = 4102 }) {
  const ports = [api, mockPort, patientPort, cdsPort, fhirPort];
  if (new Set(ports).size !== ports.length || ports.some(value => !Number.isInteger(value) || value < 1024 || value > 65535)) throw problem('Choose five distinct sandbox ports from 1024 to 65535.');
  const environment = { SMART_FLINT_SANDBOX_PORT: String(api), SMART_FLINT_MOCK_PORT: String(mockPort), SMART_FLINT_PATIENT_PORT: String(patientPort),
    SMART_FLINT_CDS_PORT: String(cdsPort), SMART_FLINT_FHIR_PORT: String(fhirPort), ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  const compose = { name: projectName, services: { sandbox: { image, pull_policy: 'never', restart: 'unless-stopped', environment,
    ports: ports.map(value => `127.0.0.1:${value}:${value}`), volumes: ['sandbox-data:/app/.data'], read_only: true, tmpfs: ['/tmp:size=32m,noexec,nosuid'],
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] } }, volumes: { 'sandbox-data': {} } };
  return { settings: { mode: 'sandbox', projectName, image, port: api, mockPort, patientPort, cdsPort, fhirPort },
    ports: ports.map(value => ({ hostIp: '127.0.0.1', port: value, protocol: 'tcp' })),
    endpoints: { console: `http://127.0.0.1:${api}`, readiness: `http://127.0.0.1:${api}/ready`, patient: `http://127.0.0.1:${patientPort}` },
    checks: { services: ['sandbox'] }, files: [{ path: 'compose.yaml', mode: 0o600, content: `${JSON.stringify(compose, null, 2)}\n` },
      { path: 'setup-secrets.json', mode: 0o600, content: `${JSON.stringify({ format: 'smart-flint-installation-secrets-v1', encryptionKey: environment.ENCRYPTION_KEY }, null, 2)}\n` },
      { path: 'installation.md', mode: 0o600, content: 'SMART Flint local sandbox. All published ports bind to loopback. Synthetic data only. Use the installer start/status/stop actions; stop retains the database. Do not delete the named data volume.\n' }] };
}

/** A private plan is committed before derived files, so interrupted setup never regenerates keys. */
export async function savePlan(directory, plan) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateMode(stat)) throw problem('Use an owned, private installation directory without symbolic links.');
  const statePath = join(directory, 'installation.json');
  let state;
  if (await exists(statePath)) {
    state = JSON.parse(await privateFile(statePath));
    if (state.format !== 'smart-flint-installation-v1' || !state.plan?.settings?.projectName || !Array.isArray(state.plan.files)) throw problem('This installation state is unsupported. No files were changed.');
    if (plan && plan.settings.mode !== state.plan.settings.mode) throw problem('This directory already belongs to a different installation mode. Choose a new directory.');
  } else {
    if (!plan) throw problem('No SMART Flint installation exists in this directory.');
    if ((await readdir(directory)).length) throw problem('The installation directory contains unrelated files. Choose a new empty directory.');
    state = { format: 'smart-flint-installation-v1', version, createdAt: new Date().toISOString(), configured: false, plan };
    await writeExclusive(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
  for (const file of state.plan.files) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(file.path) || file.path === 'installation.json' || typeof file.content !== 'string' || file.content.length > 256 * 1024) throw problem('The saved installation plan is invalid.');
    const path = join(directory, file.path);
    if (await exists(path)) {
      const current = await privateFile(path);
      if (!state.configured && current !== file.content) throw problem('An interrupted setup file was changed. No credentials were overwritten; review the installation directory.');
    } else if (state.configured) throw problem('An installation file is missing. Restore it from your deployment backup; keys were not regenerated.');
    else await writeExclusive(path, file.content);
  }
  if (!state.configured) { state.configured = true; await replaceState(directory, state); }
  return state;
}

async function command(args, { input, quiet = true, timeout = 900_000 } = {}) {
  if (input === undefined) {
    const heartbeat = setInterval(() => console.log('Docker is still working; the installation is being prepared…'), 30_000);
    heartbeat.unref();
    try { return (await execute('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, BUILDX_CONFIG: process.env.BUILDX_CONFIG ?? '/tmp/flint-installer-buildx' } })).stdout.trim(); }
    catch { throw problem(`The Docker ${['version', 'image', 'compose', 'build', 'pull', 'load', 'tag', 'run', 'rm'].includes(args[0]) ? args[0] : 'setup'} operation failed. Check Docker, available disk space, image access and selected ports; saved installation files were retained.`); }
    finally { clearInterval(heartbeat); }
  }
  return new Promise((resolveCommand, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env }); let output = ''; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(problem('The setup operation timed out.')); }, timeout);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536) child.kill(); else output += chunk; });
    child.stderr.on('data', () => {}); child.on('error', () => { clearTimeout(timer); reject(problem('Docker could not start the setup operation.')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolveCommand(output.trim()) : reject(problem('First-owner setup did not complete. Check the configured identity and use a unique password of 15–128 characters.')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const composeArgs = (directory, state, ...args) => ['compose', '--project-name', state.plan.settings.projectName, '--file', join(directory, 'compose.yaml'),
  ...(state.resolvedImageId ? ['--file', join(directory, 'image.lock.yaml')] : []), ...args];
function rows(text) { if (!text.trim()) return []; try { const value = JSON.parse(text); return Array.isArray(value) ? value : [value]; } catch { return text.split('\n').filter(Boolean).map(line => JSON.parse(line)); } }

export async function verifyImageArchive(path, checksumPath = join(dirname(path), 'SHA256SUMS')) {
  const info = await lstat(path), sums = await lstat(checksumPath);
  if (!info.isFile() || info.isSymbolicLink() || !sums.isFile() || sums.isSymbolicLink() || sums.size > 1024 * 1024) throw problem('Use a regular image archive and its release SHA256SUMS file, without symbolic links.');
  const matching = (await readFile(checksumPath, 'utf8')).split(/\r?\n/).filter(line => line.slice(66) === basename(path));
  if (matching.length !== 1 || !/^[a-f0-9]{64}  [A-Za-z0-9_.-]+$/.test(matching[0])) throw problem('The image archive must have exactly one matching entry in SHA256SUMS.');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== matching[0].slice(0, 64)) throw problem('The image archive checksum does not match. No image was loaded.');
}
async function stageImageArchive(directory, path, checksumPath) {
  const staging = await mkdtemp(join(directory, '.verified-image-'));
  const target = join(staging, basename(path));
  try {
    const source = await lstat(path);
    if (!source.isFile() || source.isSymbolicLink() || source.size > 1024 * 1024 * 1024) throw problem('Use a regular release image archive no larger than 1 GiB.');
    const file = await open(target, 'wx', 0o600); let bytes = 0;
    try { for await (const chunk of createReadStream(path)) { bytes += chunk.length; if (bytes > 1024 * 1024 * 1024) throw problem('The image archive exceeds the installer size limit.'); await file.writeFile(chunk); } await file.sync(); }
    finally { await file.close(); }
    // Verification applies to exactly the private bytes passed to docker load.
    await verifyImageArchive(target, checksumPath ?? join(dirname(path), 'SHA256SUMS'));
    return { path: target, directory: staging };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
async function ensureImage(directory, state, args) {
  const tag = state.plan.settings.image;
  if (!imageRef(tag)) throw problem('Invalid saved image reference.');
  if (!state.resolvedImageId && !args.image && !args['image-archive'] && state.imageInput?.reference) args = { ...args, image: state.imageInput.reference };
  if (!args.image && !args['image-archive'] && !state.resolvedImageId && state.imageInput?.kind === 'archive') throw problem('Supply the original --image-archive again to start this configured installation. No source build was substituted.');
  if (state.resolvedImageId) {
    if (!/^sha256:[a-f0-9]{64}$/.test(state.resolvedImageId)) throw problem('Invalid saved immutable image identity.');
    const lock = JSON.parse(await privateFile(join(directory, 'image.lock.yaml'))), service = state.plan.settings.mode === 'sandbox' ? 'sandbox' : 'flint';
    if (JSON.stringify(lock) !== JSON.stringify({ services: { [service]: { image: state.resolvedImageId, pull_policy: 'never' } } })) throw problem('The saved image lock was changed. No replacement image was started.');
    if (!args.image && !args['image-archive']) {
      try { await command(['image', 'inspect', state.resolvedImageId]); return; }
      catch { throw problem('The installation image is missing. Supply its original verified archive or matching image; a different image will not be substituted.'); }
    }
  }
  if (args['image-archive']) {
    const staged = await stageImageArchive(directory, args['image-archive'], args.checksums);
    try {
      const prepared = await prepareImageArchive(staged.path, { directory: staged.directory });
      await command(['load', '--input', prepared.path]);
      // Some engines omit tags in load stdout. Resolve authenticated archive
      // identities instead, and verify the actual local identity before use.
      let selected;
      for (const reference of [...prepared.references, ...prepared.expectedImageIds]) {
        if (!imageRef(reference)) continue;
        try {
          const id = await command(['image', 'inspect', '--format', '{{.Id}}', reference]);
          if (prepared.expectedImageIds.includes(id)) { selected = reference; break; }
        } catch {}
      }
      if (!selected) throw problem('The loaded image identity did not match the verified archive. No runtime was started.');
      await command(['tag', selected, tag]);
    } catch (error) {
      if (error.message === IMAGE_ARCHIVE_ERROR) throw problem(IMAGE_ARCHIVE_ERROR);
      throw error;
    } finally { await rm(staged.directory, { recursive: true, force: true }); }
  } else if (args.image) {
    if (!imageRef(args.image)) throw problem('Supply a valid explicit image reference.');
    try { await command(['image', 'inspect', args.image]); } catch { await command(['pull', args.image]); }
    await command(['tag', args.image, tag]);
  } else {
    let present = false; try { await command(['image', 'inspect', tag]); present = true; } catch {}
    if (!present) {
      console.log('Building the application inside Docker. The first build may take several minutes.');
      await command(['build', '--pull', '--file', join(sourceRoot, state.plan.settings.mode === 'sandbox' ? 'deploy/Dockerfile.sandbox' : 'deploy/Dockerfile'), '--tag', tag, sourceRoot]);
    }
  }
  const imageId = await command(['image', 'inspect', '--format', '{{.Id}}', tag]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || (state.resolvedImageId && state.resolvedImageId !== imageId)) throw problem('The supplied image differs from this installation’s immutable image. No running service was changed.');
  if (!state.resolvedImageId) {
    const service = state.plan.settings.mode === 'sandbox' ? 'sandbox' : 'flint';
    const lock = `${JSON.stringify({ services: { [service]: { image: imageId, pull_policy: 'never' } } }, null, 2)}\n`;
    const lockPath = join(directory, 'image.lock.yaml');
    if (await exists(lockPath)) { if (await privateFile(lockPath) !== lock) throw problem('An interrupted image lock changed. No image was substituted.'); }
    else await writeExclusive(lockPath, lock);
    state.resolvedImageId = imageId; await replaceState(directory, state);
  }
}

async function checkPorts(state, active = []) {
  const owned = new Set(active.flatMap(row => row.Publishers ?? []).map(value => Number(value.PublishedPort)));
  const needed = state.plan.ports.filter(value => !owned.has(value.port));
  if (!needed.length) return;
  const image = process.env.SMART_FLINT_INSTALLER_IMAGE;
  if (!imageRef(image)) throw problem('Use install.sh or install.ps1 for Docker-based port checks.');
  const name = `flint-port-check-${randomBytes(8).toString('hex')}`;
  try {
    await command(['run', '--detach', '--name', name, '--read-only', '--cap-drop', 'ALL', ...needed.flatMap(value => ['--publish', `${value.hostIp}:${value.port}:9/tcp`]),
      '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)']);
  } catch { throw problem(`A requested host port is unavailable (${needed.map(value => value.port).join(', ')}). Existing services were not stopped. Choose other ports or a different installation directory.`); }
  finally { await command(['rm', '--force', name]).catch(() => {}); }
}

const ownerScript = `const fs=require('node:fs');(async()=>{const x=JSON.parse(fs.readFileSync(0,'utf8'));const base='http://127.0.0.1:'+process.env.PORT;const origin=process.env.CONSOLE_URL;const request=async(path,body,cookie)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin,...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return{r,value:await r.json()}};const status=await request('/api/admin/session');if(!status.value.bootstrapEnabled){console.log(JSON.stringify({alreadyProvisioned:true}));return;}const setup=await request('/api/admin/session',{token:x.token});if(!setup.r.ok)throw Error();const cookie=setup.r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');const user=await request('/api/admin/users',x.owner,cookie);if(!user.r.ok)throw Error();console.log(JSON.stringify({created:true}));})().catch(()=>process.exit(1));`;
async function firstOwner(directory, state, owner) {
  if (!owner || state.plan.settings.mode !== 'deploy') return;
  const secret = JSON.parse(await privateFile(join(directory, 'setup-secrets.json')));
  const identity = state.plan.settings.authMode === 'local' ? { authMethod: 'local', username: owner.username, password: owner.password }
    : { authMethod: 'oidc', issuer: state.plan.settings.oidc.issuer, subject: owner.subject };
  if ((identity.authMethod === 'local' && (typeof identity.username !== 'string' || typeof identity.password !== 'string'))
    || (identity.authMethod === 'oidc' && typeof identity.subject !== 'string')) throw problem('Supply the complete first-administrator identity in the private configuration file.');
  const body = JSON.stringify({ token: secret.bootstrapToken, owner: { ...identity, displayName: owner.displayName || 'Platform administrator', role: 'platform_admin', organizationIds: [], applicationIds: [], disabled: false } });
  const result = JSON.parse(await command(composeArgs(directory, state, 'exec', '-T', 'flint', 'node', '-e', ownerScript), { input: body, timeout: 60_000 }));
  console.log(result.alreadyProvisioned ? 'An administrator already exists; the existing account credentials were kept.' : 'First-administrator setup completed. Sign in using your chosen account.');
}

async function ask(question, fallback = '', hidden = false) {
  let muted = false;
  const output = hidden ? new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } }) : process.stdout;
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = terminal.question(`${question}${fallback ? ` [${fallback}]` : ''}: `); muted = hidden;
    const result = await answer; if (hidden) process.stdout.write('\n'); return result || fallback;
  } finally { terminal.close(); }
}
async function wizard(args, supplied) {
  if (args['non-interactive'] || !process.stdin.isTTY) return supplied;
  args.mode ??= (await ask('Choose 1: Try SMART Flint, or 2: Deploy SMART Flint', '1')) === '2' ? 'deploy' : 'sandbox';
  args.port ??= await ask(args.mode === 'sandbox' ? 'Local console port' : 'Local backend port (for an existing TLS proxy)', '3010');
  if (args.mode === 'deploy') {
    args['public-url'] ??= await ask('Public HTTPS URL');
    args.tls ??= (await ask('HTTPS: 1: Existing TLS proxy, or 2: Automatic public HTTPS', '1')) === '2' ? 'caddy' : 'external';
    args.auth ??= (await ask('Administration: 1: Username/password, or 2: Organization SSO', '1')) === '2' ? 'oidc' : 'local';
    if (args.auth === 'oidc' && !supplied.oidc) {
      const issuer = await ask('Exact OIDC issuer URL'), clientId = await ask('Administrative OIDC client ID');
      const authMethod = (await ask('OIDC client: 1: Confidential (secret), or 2: Public PKCE', '1')) === '2' ? 'none' : 'client_secret_basic';
      supplied.oidc = { issuer, clientId, authMethod, ...(authMethod !== 'none' ? { clientSecret: await ask('OIDC client secret', '', true) } : {}) };
    }
    if (!supplied.owner && (await ask('Create the first administrator now? y/n', 'y')).toLowerCase() === 'y') {
      if (args.auth === 'local') {
        const username = await ask('Administrator username', 'admin'), password = await ask('Administrator passphrase (15–128 characters)', '', true);
        if (password !== await ask('Confirm passphrase', '', true)) throw problem('The passphrases did not match. No account was created.');
        supplied.owner = { username, password };
      } else supplied.owner = { subject: await ask('Exact first-administrator OIDC subject') };
    }
  }
  console.log(`Installation folder: ${process.env.SMART_FLINT_HOST_DIRECTORY ?? args.directory}`);
  if ((await ask(args.tls === 'caddy' ? 'Start deployment and expose public HTTP/HTTPS ports 80 and 443? y/n' : 'Continue with this installation? y/n', 'y')).toLowerCase() !== 'y') throw problem('Installation cancelled.');
  return supplied;
}

export async function runInstaller(args) {
  const directory = resolve(args.directory ?? process.env.SMART_FLINT_INSTALL_DIRECTORY ?? '.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const initial = await exists(join(directory, 'installation.json'));
  let supplied = args.config ? JSON.parse(await privateFile(resolve(args.config), 64 * 1024)) : {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw problem('Use a private JSON object for installer configuration.');
  if (initial) {
    const saved = await savePlan(directory);
    const s = saved.plan.settings;
    if ((args.mode && args.mode !== s.mode) || (args['public-url'] && args['public-url'].replace(/\/$/, '') !== s.publicUrl)
      || (args.port && Number(args.port) !== (s.port ?? s.bindPort)) || (args.auth && args.auth !== s.authMode) || (args.tls && args.tls !== s.tlsMode)
      || ['mock', 'patient', 'cds', 'fhir'].some(name => args[`${name}-port`] && Number(args[`${name}-port`]) !== s[`${name}Port`]))
      throw problem('Existing installation settings differ. Use a new directory; configuration and credentials were preserved.');
    return lifecycle(directory, saved, args, supplied.owner);
  }
  if (args.action !== 'install') throw problem('No installation exists in this directory.');
  supplied = await wizard(args, supplied);
  if (!args.mode) throw problem('Specify --mode sandbox or --mode deploy for non-interactive installation.');
  if (args.mode === 'sandbox' && (args.auth || args.tls || args['public-url'])) throw problem('The sandbox is a loopback synthetic demo. Choose deploy for HTTPS and secured administrative sign-in.');
  if (args.mode === 'deploy' && !args['public-url']) throw problem('Supply the deployment public HTTPS URL with --public-url.');
  const id = randomBytes(8).toString('hex'), projectName = `smart-flint-${id}`, image = `smart-flint-installed:${args.mode}-${version}-${id}`;
  const plan = args.mode === 'sandbox' ? createSandboxPlan({ projectName, image, port: port(args.port, 3010), mockPort: port(args['mock-port'], 4010),
    patientPort: port(args['patient-port'], 4100), cdsPort: port(args['cds-port'], 4101), fhirPort: port(args['fhir-port'], 4102) })
    : createProductionPlan({ publicUrl: args['public-url'], projectName, image, authMode: args.auth ?? 'local', tlsMode: args.tls ?? 'external',
      bindPort: port(args.port, 3010), oidc: supplied.oidc, allowPrivateNetworks: supplied.allowPrivateNetworks === true });
  // Check before committing credentials, so a fresh install with occupied ports
  // can be retried with different choices in the same still-empty folder.
  if (!args['configure-only']) await checkPorts({ plan });
  const state = await savePlan(directory, plan);
  state.imageInput = args.image ? { kind: 'reference', reference: args.image } : args['image-archive'] ? { kind: 'archive', filename: basename(args['image-archive']) } : { kind: 'source' };
  await replaceState(directory, state);
  return lifecycle(directory, state, args, supplied.owner);
}

async function lifecycle(directory, state, args, owner) {
  const plan = state.plan;
  if (args['configure-only']) {
    if (args.image || args['image-archive']) await ensureImage(directory, state, args);
    console.log('Private installation configuration prepared. Run the installer again to start it.'); return;
  }
  await command(['version', '--format', '{{.Server.Version}}'], { timeout: 30_000 });
  const composeVersion = await command(['compose', 'version', '--short'], { timeout: 30_000 });
  const [major, minor] = composeVersion.replace(/^v/, '').split('.').map(Number);
  if (major < 2 || (major === 2 && minor < 24)) throw problem('Docker Compose 2.24 or newer is required.');
  if (args.action === 'stop') {
    await command(composeArgs(directory, state, 'stop')); console.log('SMART Flint stopped. Configuration, keys and database volumes were retained.'); return;
  }
  if (args.action === 'status') {
    const status = rows(await command(composeArgs(directory, state, 'ps', '--all', '--format', 'json')));
    console.log(JSON.stringify({ mode: plan.settings.mode, console: plan.endpoints.console, services: status.map(value => ({ service: value.Service, state: value.State, health: value.Health })) }, null, 2)); return;
  }
  let active = []; try { active = rows(await command(composeArgs(directory, state, 'ps', '--format', 'json'))); } catch {}
  await checkPorts(state, active);
  await ensureImage(directory, state, args);
  console.log('Starting SMART Flint and waiting for service readiness…');
  await command(composeArgs(directory, state, 'up', '--detach', '--wait', '--wait-timeout', '180'));
  await firstOwner(directory, state, owner);
  let browserReady = plan.settings.mode === 'sandbox';
  if (!browserReady) {
    try {
      const response = await fetch(plan.endpoints.readiness, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      browserReady = response.status === 200 && (await response.json()).status === 'ready';
    } catch { /* No certificate bypass: services may be ready before the public edge. */ }
  }
  console.log(browserReady ? `SMART Flint is ready. Open ${plan.endpoints.console}` : `SMART Flint services are running; public HTTPS readiness is still pending at ${plan.endpoints.console}.`);
  if (plan.settings.mode === 'deploy') {
    if (plan.settings.tlsMode === 'external') console.log(`Existing HTTPS proxy: ${plan.endpoints.console} → ${plan.endpoints.proxyTarget}. Public HTTPS must be working before browser sign-in.`);
    else console.log('Automatic HTTPS requires public DNS and inbound ports 80/443. Certificate issuance may take a few minutes.');
    if (!owner) console.log('Complete Initial deployment setup using the bootstrap token in the private setup-secrets.json file.');
    if (plan.endpoints.oidcCallback) console.log(`Register the administrative callback: ${plan.endpoints.oidcCallback}`);
  }
  console.log('Start/status/stop use this same installation folder. Database volumes are retained on stop.');
  if (browserReady && process.env.SMART_FLINT_BROWSER_RESULT) await writeExclusive(process.env.SMART_FLINT_BROWSER_RESULT, JSON.stringify({ url: plan.endpoints.console }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseInstallerArgs(process.argv.slice(2));
    if (args.help) console.log(`SMART Flint guided installer\nRun ./install.sh or .\\install.ps1; Docker is the only host runtime requirement.\n\n--mode sandbox|deploy --directory PATH [--non-interactive] [--no-open]\n--port N [--mock-port N --patient-port N --cds-port N --fhir-port N]\n--public-url https://HOST --tls external|caddy --auth local|oidc\n--config PRIVATE_JSON (OIDC and optional first-owner credentials; never pass passwords as arguments)\n--image EXPLICIT_REFERENCE | --image-archive FILE [--checksums SHA256SUMS]\n--configure-only\n--action start|status|stop (existing installation; stop retains all data)\n\nInstallations have private independent keys and named database volumes. No existing service is stopped automatically.\n`);
    else await runInstaller(args);
  } catch (error) { console.error(fixed(error)); process.exitCode = 1; }
}
