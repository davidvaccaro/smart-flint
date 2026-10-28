/** Real console + server acceptance for a fresh local-password deployment; no saved data or external services. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { AdminSessionStatus, AdminUser, AuditEvent } from '../packages/contracts/src/index.js';
import { buildApp } from '../apps/server/src/app.js';

assert.ok(existsSync(join(process.cwd(), 'apps/console/dist/index.html')), 'Build the console before running this check.');
const username = 'browser.operator';
const initialPassword = 'Synthetic first browser passphrase 4836';
const newPassword = 'Synthetic changed browser passphrase 7192';
const bootstrapToken = randomBytes(32).toString('base64url');
const pageErrors: string[] = [];
const externalOrigins = new Set<string>();
let outboundServerRequests = 0;
let runtime: Awaited<ReturnType<typeof buildApp>> | undefined;
let browser: Browser | undefined;

try {
  runtime = await buildApp({ seed: false, serveConsole: true, config: {
    // Synthetic demo data must never bypass an explicitly selected local authentication mode.
    demo: true, adminAuthMode: 'local', adminOidc: undefined, adminBootstrapEnabled: true, adminToken: bootstrapToken,
    host: '127.0.0.1', port: 0, baseUrl: 'http://127.0.0.1:3010', consoleUrl: 'http://127.0.0.1:3010',
    sqlitePath: ':memory:', databaseUrl: undefined, encryptionKey: randomBytes(32).toString('base64'),
  } });
  runtime.bridge.http.request = async () => { outboundServerRequests++; throw new Error('This isolated local-auth flow must not contact an identity provider or EHR.'); };
  await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  const address = runtime.app.server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  runtime.config.baseUrl = origin; runtime.config.consoleUrl = origin;
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const newContext = async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
      const requestOrigin = new URL(route.request().url()).origin;
      if (requestOrigin === origin) return route.continue();
      externalOrigins.add(requestOrigin);
      return route.abort();
    });
    return context;
  };
  const newPage = async (context: BrowserContext) => {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(15_000);
    page.on('pageerror', error => pageErrors.push(error.message));
    return page;
  };
  const status = async (context: BrowserContext) => {
    const result = await context.request.get(`${origin}/api/admin/session`);
    assert.equal(result.status(), 200);
    return await result.json() as AdminSessionStatus;
  };
  const signIn = async (page: Page, password: string) => {
    const form = page.getByRole('form', { name: 'Username and password sign-in', exact: true });
    await form.getByLabel('Username', { exact: true }).fill(username);
    await form.getByLabel('Password', { exact: true }).fill(password);
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  const settings = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings & API', exact: true }).click();
    await page.getByRole('heading', { name: 'Users & access', exact: true }).waitFor();
  };

  const context = await newContext();
  const page = await newPage(context);
  await page.goto(origin);
  await expect(page.getByLabel('Bootstrap administrator token', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open local workspace', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Sign in with your organization/ })).toHaveCount(0);
  const anonymous = await status(context);
  assert.equal(anonymous.authenticated, false); assert.equal(anonymous.authMode, 'local');
  assert.equal(anonymous.localEnabled, true); assert.equal(anonymous.bootstrapEnabled, true); assert.equal(anonymous.oidcEnabled, false);
  const demoBypass = await context.request.post(`${origin}/api/admin/session`, { headers: { Origin: origin }, data: { token: '' } });
  assert.equal(demoBypass.status(), 401, 'An explicitly configured local deployment must not offer passwordless demo access.');

  const setup = page.getByRole('form', { name: 'Initial deployment setup', exact: true });
  await setup.getByLabel('Bootstrap administrator token', { exact: true }).fill(bootstrapToken);
  await setup.getByRole('button', { name: 'Open initial setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  assert.equal((await status(context)).identity?.kind, 'bootstrap');
  await settings(page);
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Display name', { exact: true }).fill('Browser deployment owner');
  await dialog.getByLabel('Username', { exact: true }).fill(username);
  await dialog.getByLabel('Initial password', { exact: true }).fill(initialPassword);
  await dialog.getByLabel('Confirm initial password', { exact: true }).fill(initialPassword);
  await dialog.getByLabel('Administrative role', { exact: true }).selectOption('platform_admin');
  await dialog.getByRole('button', { name: 'Save user access', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Username and password sign-in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Bootstrap administrator token', { exact: true })).toHaveCount(0);
  const retired = await status(context);
  assert.equal(retired.authenticated, false); assert.equal(retired.bootstrapEnabled, false);
  const users = await runtime.bridge.repo.list<AdminUser>('admin_users');
  assert.equal(users.length, 1); assert.equal(users[0]?.authMethod, 'local'); assert.equal(users[0]?.username, username);
  assert.equal(users[0]?.role, 'platform_admin'); assert.deepEqual(users[0]?.organizationIds, []); assert.deepEqual(users[0]?.applicationIds, []);
  const bootstrapReplay = await context.request.post(`${origin}/api/admin/session`, { headers: { Origin: origin }, data: { token: bootstrapToken } });
  assert.equal(bootstrapReplay.status(), 401, 'The initial setup credential must stop working after the first usable owner exists.');

  await signIn(page, initialPassword);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const localSession = await status(context);
  assert.equal(localSession.identity?.kind, 'local'); assert.equal(localSession.identity?.id, users[0]!.id);
  const cookie = (await context.cookies(`${origin}/api/admin/session`)).find(item => item.name === 'smart_flint_admin');
  assert.ok(cookie?.httpOnly); assert.equal(cookie.sameSite, 'Strict');
  await settings(page);
  const otherContext = await newContext();
  const otherPage = await newPage(otherContext);
  await otherPage.goto(origin);
  await signIn(otherPage, initialPassword);
  await expect(otherPage.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  assert.equal((await status(otherContext)).authenticated, true);

  const passwordForm = page.getByRole('region', { name: 'Change password', exact: true });
  await passwordForm.getByLabel('Current password', { exact: true }).fill(initialPassword);
  await passwordForm.getByLabel('New password', { exact: true }).fill(newPassword);
  await passwordForm.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
  await passwordForm.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText('Password changed. Sign in again with your new password.', { exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Username and password sign-in', exact: true })).toBeVisible();
  assert.equal((await status(context)).authenticated, false);
  assert.equal((await status(otherContext)).authenticated, false, 'Changing a password must revoke sessions in other browsers as well.');
  assert.equal(new URL(page.url()).search, '', 'The one-time password-change notice flag must be removed from the URL.');
  await signIn(page, initialPassword);
  await expect(page.getByText('The username or password is incorrect.', { exact: true })).toBeVisible();
  assert.equal((await status(context)).authenticated, false);
  await signIn(page, newPassword);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  assert.equal((await status(context)).identity?.kind, 'local');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Username and password sign-in', exact: true })).toBeVisible();
  assert.equal((await status(context)).authenticated, false);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');

  const events = await runtime.bridge.repo.list<AuditEvent>('events');
  assert.ok(events.some(event => event.action === 'admin.user_created' && event.actor?.kind === 'bootstrap'));
  assert.ok(events.some(event => event.action === 'admin.password_changed' && event.actor?.id === users[0]!.id));
  const stored = JSON.stringify({ users, events, sessions: await runtime.bridge.repo.list('sessions'), secrets: await runtime.bridge.repo.list('secrets') });
  const browserStorage = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
  for (const secret of [bootstrapToken, initialPassword, newPassword, cookie!.value]) {
    assert.ok(!stored.includes(secret), 'Stored account, audit, encrypted secret, and session records must exclude plaintext credentials.');
    assert.ok(!browserStorage.includes(secret), 'Local credentials must not be persisted in browser storage.');
  }
  assert.equal(outboundServerRequests, 0); assert.deepEqual([...externalOrigins], []); assert.deepEqual(pageErrors, []);
  await otherContext.close(); await context.close();
  console.log('Local administration browser flow passed: explicit bootstrap, first local owner, retired setup credential, password sign-in, password change, all-browser session revocation, new-password sign-in, logout, and no identity-provider contact.');
} finally { await browser?.close(); await runtime?.app.close(); }
