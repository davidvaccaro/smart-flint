/** Isolated UI acceptance: synthetic auth responses only, no saved users or real identity provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { AdminIdentity, AdminSessionStatus, AdminUser, Dashboard } from '../packages/contracts/src/index.js';

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
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(chromePath) ? { executablePath: chromePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage(); page.setDefaultTimeout(10_000);
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
const at = '2026-10-28T12:00:00Z';
const initialPassword = 'velvet willow orbit lantern';
const changedPassword = 'cobalt meadow river lantern';
const bootstrapToken = 'synthetic-bootstrap-token';
let mode: 'local' | 'oidc' | 'demo' = 'local';
let omitMode = false;
let bootstrapEnabled = true;
let authenticated = false;
let current: AdminIdentity = { id: 'bootstrap', displayName: 'Initial administrator', kind: 'bootstrap', role: 'platform_admin', organizationIds: [], applicationIds: [] };
const users: AdminUser[] = [];
const passwords = new Map<string, string>();
let userReads = 0;
let passwordChanges = 0;
const creates: Record<string, unknown>[] = [];
const asIdentity = (user: AdminUser): AdminIdentity => ({ id: user.id, displayName: user.displayName, kind: user.authMethod === 'local' ? 'local' : 'oidc', username: user.username, role: user.role, organizationIds: user.organizationIds, applicationIds: user.applicationIds });
function dashboard(): Dashboard {
  return {
    tenants: [{ id: 'org-a', name: 'Assigned Organization', slug: 'assigned-org', createdAt: at }],
    applications: [{ id: 'app-a', name: 'Assigned Application', description: 'Synthetic local access fixture', callbackUrls: [`${origin}/reference-app`], requiredContext: ['patient'], requiredScopes: ['patient/Patient.rs'], allowedModes: ['gateway'], createdAt: at }],
    platforms: [], connections: [], registrations: [], appRegistrations: [], installations: [], activations: [], events: [],
    access: { authMode: mode, identity: current, platformAdmin: current.role === 'platform_admin', canWrite: current.role !== 'viewer', manageable: { tenants: ['org-a'], applications: ['app-a'], connections: [], registrations: [], appRegistrations: [], installations: [], activations: [], cdsServices: [] } },
    runtime: { version: '0.1.0', storage: 'sqlite', demo: true, baseUrl: origin, consoleUrl: origin },
  };
}
page.on('request', request => { assert.ok(![initialPassword, changedPassword, bootstrapToken].some(secret => request.url().includes(secret)), 'Credentials must never appear in request URLs.'); });
await context.route('**/api/**', async route => {
  const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
  const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/admin/session' && method === 'GET') return respond({ authenticated, demo: true, ...(!omitMode ? { authMode: mode } : {}), localEnabled: mode === 'local', oidcEnabled: mode === 'oidc', ...(mode === 'oidc' ? { oidcLoginUrl: `${origin}/api/admin/oidc/login` } : {}), bootstrapEnabled, ...(authenticated ? { identity: current } : {}) } satisfies AdminSessionStatus);
  if (path === '/api/admin/session' && method === 'POST') {
    const body = request.postDataJSON();
    if (body.token === bootstrapToken && bootstrapEnabled) { authenticated = true; return respond({ authenticated: true }); }
    const user = users.find(item => item.username === body.username);
    if (mode === 'local' && user && passwords.get(user.id) === body.password) { authenticated = true; current = asIdentity(user); return respond({ authenticated: true }); }
    return respond({ code: 'invalid_credentials', message: 'The username or password is incorrect.' }, 401);
  }
  if (path === '/api/admin/session' && method === 'DELETE') { authenticated = false; return respond({ authenticated: false }); }
  if (!authenticated) return respond({ code: 'unauthorized', message: 'Sign in to continue.' }, 401);
  if (path === '/api/admin/dashboard') return respond(dashboard());
  if (path === '/api/admin/users' && method === 'GET') { userReads++; return respond(users); }
  if (path === '/api/admin/users' && method === 'POST') {
    const body = request.postDataJSON(); creates.push(body);
    const { password, ...metadata } = body;
    const user = { ...metadata, id: `user-${users.length + 1}`, createdAt: at, updatedAt: at } as AdminUser;
    users.push(user); passwords.set(user.id, password);
    if (current.kind === 'bootstrap' && user.role === 'platform_admin' && !user.disabled) { bootstrapEnabled = false; authenticated = false; }
    return respond(user, 201);
  }
  if (path === '/api/admin/password' && method === 'POST') {
    passwordChanges++;
    const body = request.postDataJSON();
    if (body.currentPassword !== passwords.get(current.id)) return respond({ code: 'invalid_credentials', message: 'The current password is incorrect.' }, 401);
    passwords.set(current.id, body.newPassword); authenticated = false;
    return respond({ changed: true });
  }
  return respond({ code: 'unexpected_request', message: 'Unexpected synthetic UI request.' }, 404);
});
const settings = async () => { await page.getByRole('button', { name: 'Settings & API', exact: true }).click(); await page.getByRole('heading', { name: 'Users & access', exact: true }).waitFor(); };
async function login(username: string, password: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function assertNoStoredCredentials() {
  assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
}
try {
  await page.goto(origin);
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.getByRole('button', { name: 'Open local workspace', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Sign in with your organization/ })).toHaveCount(0);
  await expect(page.getByLabel('Bootstrap administrator token', { exact: true })).toBeVisible();
  await mkdir(join(root, '.data'), { recursive: true });
  await page.screenshot({ path: join(root, '.data/admin-local-login-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(root, '.data/admin-local-login-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1100 });

  await page.getByLabel('Bootstrap administrator token', { exact: true }).fill(bootstrapToken);
  await page.getByRole('button', { name: 'Open initial setup', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Applications', exact: true }).waitFor(); await settings();
  await expect(page.getByText('Complete setup by adding an enabled local platform administrator', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Identity provider issuer', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Administrative role', { exact: true })).toHaveValue('platform_admin');
  await dialog.getByLabel('Display name', { exact: true }).fill('Morgan Local Administrator');
  await dialog.getByLabel('Username', { exact: true }).fill('morgan');
  await dialog.getByLabel('Initial password', { exact: true }).fill(initialPassword);
  await expect(dialog.getByLabel('Initial password', { exact: true })).toHaveAttribute('autocomplete', 'new-password');
  await dialog.getByLabel('Confirm initial password', { exact: true }).fill('a different long passphrase');
  await dialog.getByRole('button', { name: 'Save user access', exact: true }).click();
  await expect(dialog.getByText('The new passwords do not match.', { exact: true })).toBeVisible(); assert.equal(creates.length, 0);
  await dialog.getByLabel('Confirm initial password', { exact: true }).fill(initialPassword);
  await dialog.getByRole('button', { name: 'Save user access', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Bootstrap administrator token', { exact: true })).toHaveCount(0);
  assert.equal(creates.length, 1); assert.equal(creates[0]?.authMethod, 'local'); assert.equal(creates[0]?.username, 'morgan'); assert.equal(creates[0]?.password === initialPassword, true); assert.ok(!('issuer' in creates[0]!) && !('subject' in creates[0]!));
  await login('morgan', 'incorrect long passphrase');
  await expect(page.getByText('The username or password is incorrect.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await login('morgan', initialPassword);
  await page.locator('.workspace-switch').getByText('Morgan Local Administrator', { exact: true }).waitFor(); await settings();
  await expect(page.locator('.access-users').getByText('morgan', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit access for Morgan Local Administrator', exact: true }).click();
  await expect(dialog.getByLabel('Username', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Initial password', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  await dialog.getByLabel('Display name', { exact: true }).fill('Alex Local Viewer');
  await dialog.getByLabel('Username', { exact: true }).fill('alex');
  await dialog.getByLabel('Initial password', { exact: true }).fill(initialPassword);
  await dialog.getByLabel('Confirm initial password', { exact: true }).fill(initialPassword);
  await dialog.getByLabel('Assigned Organization', { exact: true }).check();
  await dialog.getByLabel('Assigned Application', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save user access', exact: true }).click();
  await expect(page.locator('.access-users').getByText('Alex Local Viewer', { exact: true })).toBeVisible();
  const viewer = users.find(user => user.username === 'alex'); assert.ok(viewer);
  assert.equal(viewer.role, 'viewer'); assert.deepEqual(viewer.organizationIds, ['org-a']); assert.deepEqual(viewer.applicationIds, ['app-a']);
  await assertNoStoredCredentials();

  current = asIdentity(viewer); const readsBeforeViewer = userReads;
  await page.goto(`${origin}/?case=viewer#settings`);
  await page.getByRole('heading', { name: 'Change password', exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Add user', exact: true })).toHaveCount(0);
  assert.equal(userReads, readsBeforeViewer, 'Viewers must not fetch the administrative directory.');
  await expect(page.getByLabel('Current password', { exact: true })).toBeEnabled();
  await page.screenshot({ path: join(root, '.data/admin-local-password-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => (document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(root, '.data/admin-local-password-mobile.png'), fullPage: true });
  await page.getByLabel('Current password', { exact: true }).fill(initialPassword);
  await page.getByLabel('New password', { exact: true }).fill(changedPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill('a different long passphrase');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText('The new passwords do not match.', { exact: true })).toBeVisible(); assert.equal(passwordChanges, 0);
  await page.getByLabel('Current password', { exact: true }).fill('incorrect current passphrase');
  await page.getByLabel('Confirm new password', { exact: true }).fill(changedPassword);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText('The current password is incorrect.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');
  await page.getByLabel('Current password', { exact: true }).fill(initialPassword);
  await page.getByLabel('New password', { exact: true }).fill(changedPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(changedPassword);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText('Password changed. Sign in again with your new password.', { exact: true })).toBeVisible();
  assert.equal(new URL(page.url()).searchParams.has('password_changed'), false);
  await expect(page.getByRole('heading', { name: 'Users & access', exact: true })).toHaveCount(0);
  await assertNoStoredCredentials();
  await login('alex', changedPassword);
  await page.getByRole('heading', { level: 1, name: 'Applications', exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Add application', exact: true })).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 1100 });
  mode = 'oidc'; authenticated = false; bootstrapEnabled = false;
  await page.goto(`${origin}/?case=oidc`);
  await expect(page.getByRole('link', { name: /Sign in with your organization/ })).toBeVisible();
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open local workspace', exact: true })).toHaveCount(0);
  current = { ...asIdentity(users[0]!), kind: 'oidc' }; authenticated = true;
  await page.goto(`${origin}/?case=oidc-admin#settings`);
  await page.getByRole('heading', { name: 'Users & access', exact: true }).waitFor();
  await expect(page.getByRole('heading', { name: 'Change password', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  await expect(dialog.getByLabel('Identity provider issuer', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Initial password', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  authenticated = false; mode = 'demo';
  await page.goto(`${origin}/?case=demo`);
  await expect(page.getByRole('button', { name: 'Open local workspace', exact: true })).toBeVisible();
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);
  omitMode = true; await page.reload();
  await expect(page.getByRole('button', { name: 'Open local workspace', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('Local administration UI acceptance passed: explicit auth modes, bootstrap owner setup, native sign-in, scoped account creation, viewer password changes, reauthentication, credential handling, and responsive layouts.');
} finally { await context.close(); await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
