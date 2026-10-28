/** Isolated real-browser OIDC flow; local provider only, in-memory registry, no external identity or EHR. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { chromium, type Browser } from '@playwright/test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AdminSessionStatus, AdminUser, Application, Dashboard, Tenant } from '../packages/contracts/src/index.js';
import { buildApp } from '../apps/server/src/app.js';

const provider = Fastify({ logger: false });
await provider.register(formbody);
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...await exportJWK(signing.publicKey), alg: 'ES256', kid: 'synthetic-browser-oidc' };
const clientId = 'synthetic-administrative-client';
const transactions = new Map<string, { redirect: string; state: string; nonce: string; challenge: string }>();
let issuer = '';
let appOrigin = '';
let exchanges = 0;

provider.get('/oidc/.well-known/openid-configuration', async () => ({
  issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
  response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['ES256'],
}));
provider.get('/oidc/jwks', async () => ({ keys: [jwk] }));
provider.get('/oidc/authorize', async (request, reply) => {
  const query = request.query as Record<string, string>;
  assert.equal(query.client_id, clientId); assert.equal(query.response_type, 'code');
  assert.equal(query.redirect_uri, `${appOrigin}/api/admin/oidc/callback`);
  assert.equal(query.code_challenge_method, 'S256');
  assert.match(query.code_challenge!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(query.nonce!, /^[A-Za-z0-9_-]{43}$/);
  const code = randomBytes(24).toString('base64url');
  transactions.set(code, { redirect: query.redirect_uri!, state: query.state!, nonce: query.nonce!, challenge: query.code_challenge! });
  return reply.type('text/html').send(`<!doctype html><html lang="en"><head><title>Synthetic organization identity</title></head><body><h1>Synthetic organization sign-in</h1><p>This local test identity is already provisioned in SMART Flint.</p><form action="/oidc/complete" method="get"><input type="hidden" name="code" value="${code}"><button type="submit">Continue organization sign-in</button></form></body></html>`);
});
provider.get('/oidc/complete', async (request, reply) => {
  const { code } = request.query as { code: string };
  const transaction = transactions.get(code); assert.ok(transaction);
  const redirect = new URL(transaction.redirect);
  redirect.searchParams.set('code', code); redirect.searchParams.set('state', transaction.state); redirect.searchParams.set('iss', issuer);
  return reply.redirect(redirect.href);
});
provider.post('/oidc/token', async (request, reply) => {
  const body = request.body as Record<string, string>;
  const transaction = transactions.get(body.code!); assert.ok(transaction);
  transactions.delete(body.code!);
  assert.equal(body.grant_type, 'authorization_code'); assert.equal(body.client_id, clientId);
  assert.equal(body.redirect_uri, transaction.redirect);
  assert.equal(createHash('sha256').update(body.code_verifier!).digest('base64url'), transaction.challenge);
  exchanges++;
  const time = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({ nonce: transaction.nonce }).setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setIssuer(issuer).setSubject('named-viewer-subject').setAudience(clientId).setIssuedAt(time).setExpirationTime(time + 300).sign(signing.privateKey);
  return reply.header('Cache-Control', 'no-store').send({ token_type: 'Bearer', access_token: 'synthetic-provider-access-token', id_token: idToken });
});

let runtime: Awaited<ReturnType<typeof buildApp>> | undefined;
let browser: Browser | undefined;
try {
  // localhost and 127.0.0.1 are different browser sites; this exercises cross-site SameSite handling.
  await provider.listen({ host: 'localhost', port: 0 });
  const providerAddress = provider.server.address(); assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerOrigin = `http://localhost:${providerAddress.port}`;
  issuer = `${providerOrigin}/oidc`;
  runtime = await buildApp({ seed: false, config: {
    demo: true, host: '127.0.0.1', port: 0, baseUrl: 'http://127.0.0.1:3010', consoleUrl: 'http://127.0.0.1:3010',
    sqlitePath: ':memory:', databaseUrl: undefined, encryptionKey: randomBytes(32).toString('base64'), adminToken: '',
    mockEhrUrl: providerOrigin, adminBootstrapEnabled: false,
    adminOidc: { issuer, clientId, authMethod: 'none', allowedOrigins: [providerOrigin], label: 'Synthetic organization sign-in' },
  } });
  await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  const address = runtime.app.server.address(); assert.ok(address && typeof address === 'object');
  appOrigin = `http://127.0.0.1:${address.port}`;
  runtime.config.baseUrl = appOrigin; runtime.config.consoleUrl = appOrigin;
  const at = new Date().toISOString();
  const user: AdminUser = { id: 'synthetic-browser-viewer', issuer, subject: 'named-viewer-subject', displayName: 'Named test viewer',
    role: 'viewer', organizationIds: ['browser-org-a'], applicationIds: ['browser-app-a'], disabled: false, createdAt: at, updatedAt: at };
  await runtime.bridge.repo.put('admin_users', user);
  for (const suffix of ['a', 'b']) {
    await runtime.bridge.repo.put<Tenant>('tenants', { id: `browser-org-${suffix}`, name: `Organization ${suffix.toUpperCase()}`, slug: `browser-org-${suffix}`, createdAt: at });
    await runtime.bridge.repo.put<Application>('applications', { id: `browser-app-${suffix}`, name: `Application ${suffix.toUpperCase()}`, description: '', callbackUrls: [],
      requiredContext: [], requiredScopes: [], allowedModes: ['gateway'], createdAt: at });
  }
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    return [appOrigin, providerOrigin].includes(origin) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
  await page.goto(`${appOrigin}/api/admin/oidc/login`);
  await page.getByRole('heading', { name: 'Synthetic organization sign-in', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue organization sign-in', exact: true }).click();
  await page.waitForURL(url => url.origin === appOrigin && url.pathname === '/', { waitUntil: 'domcontentloaded' });
  assert.equal(new URL(page.url()).search, '', 'The synthetic provider callback must return without an authorization error.');
  const session = await page.evaluate(async () => (await fetch('/api/admin/session')).json()) as AdminSessionStatus;
  assert.equal(session.authenticated, true);
  assert.equal(session.identity?.kind, 'oidc'); assert.equal(session.identity?.id, user.id);
  assert.equal(session.identity?.role, 'viewer'); assert.equal(exchanges, 1);
  const cookie = (await context.cookies(`${appOrigin}/api/admin/session`)).find(item => item.name === 'smart_flint_admin');
  assert.ok(cookie?.httpOnly); assert.equal(cookie.sameSite, 'Strict');
  const response = await context.request.get(`${appOrigin}/api/admin/dashboard`); assert.equal(response.status(), 200);
  const dashboard = await response.json() as Dashboard;
  assert.deepEqual(dashboard.tenants.map(item => item.id), ['browser-org-a']);
  assert.deepEqual(dashboard.applications.map(item => item.id), ['browser-app-a']);
  const forbidden = await context.request.post(`${appOrigin}/api/admin/tenants`, { headers: { Origin: appOrigin }, data: { name: 'Forbidden new organization' } });
  assert.equal(forbidden.status(), 403);
  const logout = await page.evaluate(async () => (await fetch('/api/admin/session', { method: 'DELETE' })).status);
  assert.equal(logout, 200);
  assert.equal((await context.request.get(`${appOrigin}/api/admin/session`).then(item => item.json()) as AdminSessionStatus).authenticated, false);
  assert.equal((await runtime.bridge.repo.list('transactions')).length, 0);
  const persisted = JSON.stringify(await runtime.bridge.repo.list('events'));
  assert.ok(!persisted.includes('synthetic-provider-access-token'));
  assert.ok(persisted.includes('synthetic-browser-viewer'));
  console.log('Administrative OIDC browser acceptance passed: cross-site identity redirect, real signed ID token, S256 PKCE, state/nonce, HttpOnly session, scoped dashboard, denied writes, actor audit and logout.');
  await context.close();
} finally {
  await browser?.close();
  await runtime?.app.close();
  await provider.close();
}
