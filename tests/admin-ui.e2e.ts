/** Isolated UI acceptance. Admin responses are synthetic fixtures; saved registry and IdPs are never contacted. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { AdminIdentity, AdminRole, AdminSessionStatus, AdminUser, Dashboard } from '../packages/contracts/src/index.js';

const root = process.cwd();
const dist = join(root, 'apps/console/dist');
assert.ok(existsSync(join(dist, 'index.html')), 'Build the console before running this check.');
const server = createServer(async (request, response) => {
  const path = new URL(request.url || '/', 'http://localhost').pathname;
  const file = path.startsWith('/assets/') || path === '/favicon.svg' ? resolve(dist, `.${path}`) : join(dist, 'index.html');
  if (!file.startsWith(`${dist}${sep}`)) { response.writeHead(404).end(); return; }
  try { response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] || 'application/octet-stream' }).end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(chromePath) ? { executablePath: chromePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage(); page.setDefaultTimeout(10_000);
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
const at = '2026-10-27T12:00:00Z';
const identity = (role: AdminRole): AdminIdentity => ({ id: `user-${role}`, displayName: role === 'platform_admin' ? 'Morgan Administrator' : role === 'integration_admin' ? 'Taylor Integrator' : 'Alex Viewer', kind: 'oidc', role, organizationIds: ['org-a'], applicationIds: ['app-a', 'app-shared'] });
let current = identity('viewer');
let authenticated = true;
let bootstrapEnabled = false;
let userReads = 0;
const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
const users: AdminUser[] = [
  { ...identity('platform_admin'), issuer: 'https://identity.example.test', subject: 'owner-subject', email: 'morgan@example.test', disabled: false, createdAt: at, updatedAt: at },
  { ...identity('viewer'), issuer: 'https://identity.example.test', subject: 'viewer-subject', disabled: false, createdAt: at, updatedAt: at },
];
function dashboard(): Dashboard {
  return {
    tenants: [{ id: 'org-a', name: 'Assigned Organization', slug: 'assigned-org', createdAt: at }],
    applications: ['a', 'shared'].map(id => ({ id: `app-${id}`, name: id === 'a' ? 'Assigned Application' : 'Shared Application', description: 'Synthetic access fixture', callbackUrls: [`${origin}/reference-app`], requiredContext: ['patient'], requiredScopes: ['patient/Patient.rs'], allowedModes: ['gateway'], createdAt: at })),
    platforms: [{ id: 'platform-a', name: 'FHIR Platform', vendor: 'generic', description: 'Standards profile', createdAt: at }],
    connections: [{ id: 'connection-a', tenantId: 'org-a', platformId: 'platform-a', name: 'Assigned Connection', vendor: 'generic', fhirBaseUrl: 'https://ehr.example.test/fhir', environment: 'sandbox', fhirVersion: '4.0.1', allowedOrigins: ['https://ehr.example.test'], status: 'unverified', createdAt: at }],
    appRegistrations: [{ id: 'parent-a', name: 'Assigned Registration', platformId: 'platform-a', applicationIds: ['app-a'], clientRegistrationIds: ['client-a'], audience: 'patient', createdAt: at }],
    registrations: [{ id: 'client-a', name: 'Assigned OAuth Client', vendor: 'generic', platformId: 'platform-a', clientId: 'synthetic-client', authMethod: 'none', createdAt: at }],
    installations: ['a', 'shared'].map(id => ({ id: `installation-${id}`, name: id === 'a' ? 'Assigned Installation' : 'Shared Installation', tenantId: 'org-a', applicationId: `app-${id}`, connectionId: 'connection-a', registrationId: 'client-a', appRegistrationId: 'parent-a', mode: 'gateway', enabled: true, scopes: ['patient/Patient.rs'], allowTokenExport: false, normalizationProfile: 'passthrough', createdAt: at })),
    activations: [], events: [{ id: 'event-a', action: 'installation.updated', at, outcome: 'success', detail: 'Installation policy updated.', installationId: 'installation-a', tenantId: 'org-a', actor: { id: current.id, displayName: current.displayName, role: current.role, kind: current.kind } }],
    access: { identity: current, platformAdmin: current.role === 'platform_admin', canWrite: current.role !== 'viewer', manageable: { tenants: ['org-a'], applications: ['app-a'], connections: ['connection-a'], registrations: ['client-a'], appRegistrations: ['parent-a'], installations: ['installation-a'], activations: [], cdsServices: [] } },
    runtime: { version: '0.1.0', storage: 'sqlite', demo: false, baseUrl: origin, consoleUrl: origin },
  };
}
await context.route('**/api/**', async route => {
  const request = route.request(); const path = new URL(request.url()).pathname;
  const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/admin/session' && request.method() === 'GET') return respond({ authenticated, demo: false, oidcEnabled: true, oidcLoginUrl: `${origin}/api/admin/oidc/login`, bootstrapEnabled, ...(authenticated ? { identity: current } : {}) } satisfies AdminSessionStatus);
  if (path === '/api/admin/dashboard') return respond(dashboard());
  if (path === '/api/admin/users' && request.method() === 'GET') { userReads++; return respond(users); }
  if (request.method() !== 'GET') {
    const body = request.postDataJSON() || {};
    writes.push({ path, method: request.method(), body });
    if (path === '/api/admin/users') { const user = { ...body, id: 'user-created', createdAt: at, updatedAt: at } as AdminUser; users.push(user); return respond(user, 201); }
    if (path === '/api/admin/users/user-platform_admin') return respond({ code: 'last_platform_admin', message: 'The final enabled platform administrator cannot be removed or demoted.' }, 409);
    if (path.startsWith('/api/admin/users/')) { const user = users.find(item => item.id === path.split('/').at(-1)); if (user) Object.assign(user, body); return respond(user); }
    return respond({ code: 'unexpected_write', message: 'Unexpected synthetic UI write.' }, 500);
  }
  return respond({ code: 'not_found' }, 404);
});
const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
const settings = async () => { await page.getByRole('button', { name: 'Settings & API', exact: true }).click(); await page.getByRole('heading', { name: 'Users & access', exact: true }).waitFor(); };
async function openAs(role: AdminRole, hash = '') { current = identity(role); authenticated = true; await page.goto(`${origin}/${hash}`); await page.getByRole('heading', { level: 1, name: 'Applications', exact: true }).waitFor(); }
try {
  await openAs('viewer');
  await expect(page.getByRole('button', { name: 'Add application', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Developer lab', exact: true })).toHaveCount(0);
  await page.locator('[data-resource-id="app-a"]').getByRole('button', { name: 'Manage application', exact: true }).click();
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page.getByLabel('Application name', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save application', exact: true })).toBeDisabled();
  await expect(page.locator('.detail-row').filter({ hasText: 'Application ID' }).getByRole('button')).toBeEnabled();
  await nav.getByRole('button', { name: 'Organizations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage organization', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit name', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: /^Connections/ }).click();
  await expect(page.getByRole('button', { name: 'Verify', exact: true })).toBeDisabled();
  await nav.getByRole('button', { name: 'Installations', exact: true }).click();
  for (const toggle of await page.getByRole('switch').all()) await expect(toggle).toBeDisabled();
  await settings();
  await expect(page.getByRole('button', { name: 'Add user', exact: true })).toHaveCount(0);
  assert.equal(userReads, 0, 'Scoped viewers must not fetch the administrative directory.');
  assert.equal(writes.length, 0, 'Viewing resources must not mutate configuration.');
  await page.goto(`${origin}/#developer`);
  await expect(page.getByText('Your role allows viewing integration configuration.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Launch application', exact: true })).toHaveCount(0);

  await openAs('integration_admin');
  await expect(page.getByRole('button', { name: 'Add application', exact: true })).toHaveCount(0);
  await page.locator('[data-resource-id="app-shared"]').getByRole('button', { name: 'Manage application', exact: true }).click();
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save application', exact: true })).toBeDisabled();
  await nav.getByRole('button', { name: 'Applications', exact: true }).click();
  await page.locator('[data-resource-id="app-a"]').getByRole('button', { name: 'Manage application', exact: true }).click();
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save application', exact: true })).toBeEnabled();
  await nav.getByRole('button', { name: 'Installations', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Disable Assigned Installation', exact: true })).toBeEnabled();
  await expect(page.getByRole('switch', { name: 'Disable Shared Installation', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Developer lab', exact: true }).click();
  assert.deepEqual(await page.getByLabel('Installation', { exact: true }).locator('option').allTextContents(), ['Select an enabled installation', 'Assigned Installation']);

  await openAs('platform_admin'); await settings();
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Display name', { exact: true }).fill('Riley Integration Admin');
  await dialog.getByLabel('Email (optional)', { exact: true }).fill('riley@example.test');
  await dialog.getByLabel('Identity provider issuer', { exact: true }).fill('https://identity.example.test');
  await dialog.getByLabel('Identity provider subject', { exact: true }).fill('riley-stable-subject');
  await dialog.getByLabel('Administrative role', { exact: true }).selectOption('integration_admin');
  await dialog.getByLabel('Assigned Organization', { exact: true }).check();
  await dialog.getByLabel('Assigned Application', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save user access', exact: true }).click();
  await expect(page.getByText('Riley Integration Admin', { exact: true })).toBeVisible();
  const created = writes.find(item => item.path === '/api/admin/users');
  assert.ok(created);
  assert.deepEqual(created.body, { displayName: 'Riley Integration Admin', email: 'riley@example.test', issuer: 'https://identity.example.test', subject: 'riley-stable-subject', role: 'integration_admin', organizationIds: ['org-a'], applicationIds: ['app-a'], disabled: false });
  await page.getByRole('button', { name: 'Edit access for Morgan Administrator', exact: true }).click();
  await dialog.getByLabel('Administrative role', { exact: true }).selectOption('viewer');
  await dialog.getByRole('button', { name: 'Save user access', exact: true }).click();
  await expect(dialog.getByText('The final enabled platform administrator cannot be removed or demoted.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await mkdir(join(root, '.data'), { recursive: true });
  await page.screenshot({ path: join(root, '.data/admin-access-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => (document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(root, '.data/admin-access-mobile.png'), fullPage: true, animations: 'disabled' });

  authenticated = false;
  await page.goto(`${origin}/?admin_error=access_not_granted`);
  await expect(page.getByRole('link', { name: /Sign in with your organization/ })).toHaveAttribute('href', `${origin}/api/admin/oidc/login`);
  await expect(page.getByLabel('Bootstrap administrator token', { exact: true })).toHaveCount(0);
  assert.equal(new URL(page.url()).searchParams.has('admin_error'), false);
  bootstrapEnabled = true;
  await page.reload();
  await expect(page.getByLabel('Bootstrap administrator token', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('Administrative UI acceptance passed: organization sign-in, bootstrap visibility, named-user provisioning, scoped/viewer mutation controls, managed installation lab filtering, last-owner errors, and mobile layout.');
} finally { await context.close(); await browser.close(); await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }
