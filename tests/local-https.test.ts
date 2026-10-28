import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalHTTPSProxy, setupLocalCertificates, type LocalCertificates } from '../scripts/local-https.mjs';
import { prepareNodeCABundle, validateDevelopmentEnvironment } from '../scripts/dev-https.mjs';

let directory: string;
let certificates: LocalCertificates;
let ca: Buffer;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'smart-flint-https-'));
  certificates = await setupLocalCertificates(join(directory, 'certificates'));
  ca = await readFile(certificates.caCertPath);
});
afterEach(async () => { await Promise.all(cleanups.splice(0).reverse().map(cleanup => cleanup())); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function upstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No upstream test address');
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${address.port}`;
}
async function proxy(targetOrigin: string, options: { requestTimeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number } = {}) {
  const instance = await createLocalHTTPSProxy({ ...certificates, targetOrigin, port: 0, ...options });
  cleanups.push(() => instance.close());
  return instance;
}
function request(origin: string, options: { path?: string; method?: string; body?: string; headers?: http.OutgoingHttpHeaders; trusted?: boolean } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const call = https.request(`${origin}${options.path ?? '/'}`, {
      ca: options.trusted === false ? undefined : ca,
      method: options.method ?? 'GET', headers: options.headers, rejectUnauthorized: true, agent: false,
    }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
      response.on('error', reject);
    });
    call.on('error', reject);
    call.setTimeout(5_000, () => call.destroy(new Error('Local HTTPS test request timed out.')));
    call.end(options.body);
  });
}

describe('project-owned local HTTPS certificates', () => {
  it('creates a private, idempotent CA and leaf with required loopback names', async () => {
    expect((await stat(certificates.directory)).mode & 0o777).toBe(0o700);
    for (const path of [certificates.caKeyPath, certificates.keyPath, certificates.caCertPath, certificates.certPath]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    const root = new X509Certificate(ca);
    const leaf = new X509Certificate(await readFile(certificates.certPath));
    expect(root.ca).toBe(true); expect(leaf.ca).toBe(false);
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1'); expect(leaf.checkHost('localhost')).toBe('localhost');
    expect(leaf.verify(root.publicKey)).toBe(true);
    const originalKey = await readFile(certificates.keyPath);
    expect(await setupLocalCertificates(certificates.directory)).toEqual(certificates);
    expect(await readFile(certificates.keyPath)).toEqual(originalKey);
  });

  it('combines configured public CAs without copying private keys', async () => {
    const existing = join(directory, 'existing-ca.pem');
    await writeFile(existing, `# Existing operator CA\n${ca.toString()}`);
    const combined = await prepareNodeCABundle(certificates, existing);
    expect((await readFile(combined, 'utf8')).match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect((await stat(combined)).mode & 0o777).toBe(0o600);
    await expect(prepareNodeCABundle(certificates, certificates.caKeyPath)).rejects.toThrow(/only public PEM certificates/);
  });
});

describe('strict loopback HTTPS proxy', () => {
  it('requires real CA verification and preserves end-to-end OAuth HTTP details', async () => {
    let received: http.IncomingHttpHeaders = {};
    const target = await upstream((incoming, outgoing) => {
      received = incoming.headers;
      expect(incoming.url).toBe('/oauth/callback/connection?code=synthetic');
      outgoing.writeHead(302, {
        Location: 'http://127.0.0.1:4100/callback?code=synthetic',
        'Set-Cookie': ['binding=synthetic; HttpOnly; Secure; SameSite=Lax; Path=/oauth/callback'],
      });
      outgoing.end('redirect-only');
    });
    const instance = await proxy(target);
    await expect(request(instance.origin, { trusted: false })).rejects.toThrow();
    const response = await request(instance.origin, {
      path: '/oauth/callback/connection?code=synthetic',
      headers: { Origin: 'http://127.0.0.1:4100', Cookie: 'binding=synthetic', Authorization: 'Bearer synthetic-secret',
        Forwarded: 'for=203.0.113.20;proto=https', 'X-Forwarded-For': '203.0.113.20', 'X-Forwarded-Proto': 'https', 'X-Real-IP': '203.0.113.20' },
    });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('http://127.0.0.1:4100/callback?code=synthetic');
    expect(response.headers['set-cookie']?.[0]).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(received.host).toBe(new URL(instance.origin).host);
    expect(received.origin).toBe('http://127.0.0.1:4100');
    expect(received.cookie).toBe('binding=synthetic');
    expect(received.authorization).toBe('Bearer synthetic-secret');
    expect(received.forwarded).toBeUndefined(); expect(received['x-forwarded-for']).toBeUndefined();
    expect(received['x-forwarded-proto']).toBeUndefined(); expect(received['x-real-ip']).toBeUndefined();
  });

  it('rejects oversized requests without disclosing submitted data', async () => {
    let called = false;
    const target = await upstream((_incoming, outgoing) => { called = true; outgoing.end('ok'); });
    const instance = await proxy(target, { maxRequestBytes: 16 });
    const body = 'sensitive-body'.repeat(10);
    const response = await request(instance.origin, { method: 'POST', body, headers: { 'Content-Length': Buffer.byteLength(body) } });
    expect(response.status).toBe(413); expect(response.body).not.toContain('sensitive-body'); expect(called).toBe(false);
  });

  it('bounds upstream duration and returns a generic error instead of response diagnostics', async () => {
    const target = await upstream((_incoming, _outgoing) => { /* Deliberately never responds. */ });
    const instance = await proxy(target, { requestTimeoutMs: 80 });
    const response = await request(instance.origin);
    expect(response.status).toBe(504); expect(response.body).toContain('timed out');
    expect(response.body).not.toContain(target);
  });

  it('rejects public listeners/targets and reports port conflicts without stopping the existing listener', async () => {
    await expect(createLocalHTTPSProxy({ ...certificates, host: '0.0.0.0', port: 0 })).rejects.toThrow(/127.0.0.1/);
    await expect(createLocalHTTPSProxy({ ...certificates, targetOrigin: 'https://example.org', port: 0 })).rejects.toThrow(/fixed HTTP origin/);
    const target = await upstream((_incoming, outgoing) => outgoing.end('still-running'));
    const occupied = Number(new URL(target).port);
    await expect(createLocalHTTPSProxy({ ...certificates, port: occupied })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(await (await fetch(target)).text()).toBe('still-running');
  });
});

describe('development profile configuration guards', () => {
  async function root() { const path = await mkdtemp(join(directory, 'profile-')); return path; }
  it('keeps the existing project SQLite path and refuses production/database settings from either source', async () => {
    const path = await root();
    expect((await validateDevelopmentEnvironment(path, {})).sqlitePath).toBe(join(path, '.data/smart-flint.sqlite'));
    for (const environment of [{ NODE_ENV: 'production' }, { DEMO_MODE: 'false' }, { DATABASE_URL: 'postgresql://production.invalid/db' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) {
      await expect(validateDevelopmentEnvironment(path, environment)).rejects.toThrow();
    }
    for (const contents of ['NODE_ENV=production', 'DEMO_MODE=false', 'DATABASE_URL=postgresql://production.invalid/db', 'NODE_TLS_REJECT_UNAUTHORIZED=0']) {
      await writeFile(join(path, '.env'), contents);
      await expect(validateDevelopmentEnvironment(path, {})).rejects.toThrow();
    }
  });
  it('refuses paths outside project development data and symbolic links', async () => {
    const path = await root();
    await expect(validateDevelopmentEnvironment(path, { SQLITE_PATH: join(directory, 'outside.sqlite') })).rejects.toThrow(/inside the project/);
    await mkdir(join(path, '.data'));
    await symlink(join(directory, 'other.sqlite'), join(path, '.data/smart-flint.sqlite'));
    await expect(validateDevelopmentEnvironment(path, {})).rejects.toThrow(/symbolic links/);
  });
});
