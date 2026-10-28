/**
 * Isolated workspace acceptance check. Run after npm run build.
 * Uses an ephemeral loopback server and an in-memory database; it never opens
 * the developer's saved registry or sends a request to an EHR sandbox.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, type Browser, type BrowserContext } from '@playwright/test';
import { buildApp } from '../apps/server/src/app.js';
import { projectRoot } from '../apps/server/src/config.js';
import type { AppRegistration, Application, Connection, Installation, Registration, Tenant } from '../packages/contracts/src/index.js';

assert.ok(existsSync(join(projectRoot, 'apps/console/dist/index.html')), 'Build the console before running the workspace browser check.');

const runtime = await buildApp({
  seed: false, serveConsole: true,
  config: {
    demo: true, host: '127.0.0.1', port: 0, sqlitePath: ':memory:', databaseUrl: undefined,
    encryptionKey: Buffer.alloc(32, 47).toString('base64'), adminToken: '',
    baseUrl: 'http://127.0.0.1:3010', consoleUrl: 'http://127.0.0.1:3010',
    mockEhrUrl: 'http://127.0.0.1:4010', secureCookies: false,
  }
});
let browser: Browser | undefined;
let context: BrowserContext | undefined;
const artifacts = join(projectRoot, '.data');
mkdirSync(artifacts, { recursive: true });

try {
  await runtime.app.listen({ port: 0, host: '127.0.0.1' });
  const address = runtime.app.server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  runtime.config.baseUrl = origin;
  runtime.config.consoleUrl = origin;
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const externalRequests: string[] = [];
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  const mainNavigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const dialog = page.getByRole('dialog');

  async function saveConfiguration<T>(pathname: string): Promise<T> {
    const [response] = await Promise.all([
      page.waitForResponse(item => new URL(item.url()).pathname === pathname && item.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Save configuration', exact: true }).click(),
    ]);
    assert.ok(response.ok(), `Configuration save failed: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  async function navigate(name: string) {
    await mainNavigation.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  }
  async function assertNoHorizontalOverflow() {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The mobile workspace must contain wide tables without overflowing the page.');
  }

  try {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Open local workspace', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Applications', exact: true })).toBeVisible();
    assert.deepEqual((await mainNavigation.getByRole('button').allTextContents()).map(text => text.trim()), ['Applications', 'EHR Platforms', 'Organizations', 'Installations', 'Activations']);
    assert.deepEqual(await runtime.bridge.repo.list('applications'), [], 'This browser check starts with an empty isolated registry.');

    // Define the application through the UI, including the same patient scopes
    // used by the current Epic sample registration.
    await page.locator('.heading-actions').getByRole('button', { name: 'Add application', exact: true }).click();
    await expect(dialog).toHaveAttribute('aria-label', 'Register an application');
    await dialog.getByLabel('Name', { exact: true }).fill('Workspace Patient Companion');
    await dialog.getByLabel('Description', { exact: true }).fill('Synthetic patient-facing onboarding acceptance application.');
    await dialog.getByLabel('Approved callback URLs', { exact: true }).fill(`${origin}/reference-app`);
    await dialog.getByLabel('Required context', { exact: true }).fill('patient');
    await dialog.getByLabel('Required FHIR scopes', { exact: true }).fill('patient/Patient.read patient/Observation.read');
    const application = await saveConfiguration<Application>('/api/admin/applications');
    await expect(dialog).not.toBeVisible();
    const appCard = page.locator(`.application-resource-card[data-resource-id="${application.id}"]`);
    await expect(appCard).toContainText(application.name);

    // Build every missing integration resource inline, without leaving the app.
    await appCard.getByRole('button', { name: 'Add EHR integration', exact: true }).click();
    await expect(dialog).toHaveAttribute('aria-label', 'Create an installation');
    await expect(dialog.getByLabel('Application', { exact: true })).toHaveValue(application.id);
    await dialog.getByLabel('Installation name', { exact: true }).fill('Patient Companion · Harbor · Epic sandbox');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await dialog.getByLabel('EHR platform', { exact: true }).selectOption('platform_epic');
    await dialog.getByRole('button', { name: 'Add an app registration', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Workspace Epic patient portal registration');
    await expect(dialog.getByLabel('EHR platform', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: application.name, exact: true })).toBeChecked();
    await dialog.getByLabel('Application audience', { exact: true }).selectOption('patient');
    const parent = await saveConfiguration<AppRegistration>('/api/admin/app-registrations');
    await expect(dialog.getByLabel('App registration', { exact: true })).toHaveValue(parent.id);

    await dialog.getByRole('button', { name: 'Add an OAuth client profile', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Workspace Epic sandbox client');
    await expect(dialog.getByLabel('App registration', { exact: true })).toHaveValue(parent.id);
    await expect(dialog.getByLabel('App registration', { exact: true })).toBeDisabled();
    await dialog.getByLabel('Environment', { exact: true }).selectOption('sandbox');
    await dialog.getByLabel('Client authentication', { exact: true }).selectOption('none');
    await dialog.getByLabel('Vendor client ID', { exact: true }).fill('workspace-synthetic-patient-client');
    assert.equal(await dialog.getByLabel('Client secret', { exact: true }).count(), 0, 'Public PKCE client creation must not request a client secret.');
    const client = await saveConfiguration<Registration>(`/api/admin/app-registrations/${parent.id}/clients`);
    await expect(dialog.getByLabel('OAuth client profile', { exact: true })).toHaveValue(client.id);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(dialog.getByLabel('App registration', { exact: true })).toHaveValue(parent.id);
    await expect(dialog.getByLabel('OAuth client profile', { exact: true })).toHaveValue(client.id);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();

    await dialog.getByRole('button', { name: 'Add an organization', exact: true }).click();
    await dialog.getByLabel('Organization name', { exact: true }).fill('Workspace Harbor Health');
    const organization = await saveConfiguration<Tenant>('/api/admin/tenants');
    await expect(dialog.getByLabel('Organization', { exact: true })).toHaveValue(organization.id);
    await dialog.getByRole('button', { name: 'Add an organization connection', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Workspace Epic Harbor sandbox');
    await expect(dialog.getByLabel('Organization', { exact: true })).toHaveValue(organization.id);
    await expect(dialog.getByLabel('Organization', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('EHR platform', { exact: true })).toHaveValue('platform_epic');
    await expect(dialog.getByLabel('EHR platform', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Environment', { exact: true })).toHaveValue('sandbox');
    await expect(dialog.getByLabel('Environment', { exact: true })).toBeDisabled();
    await dialog.getByLabel('FHIR base URL', { exact: true }).fill('http://127.0.0.1:4010/epic/northstar/r4');
    const connection = await saveConfiguration<Connection>('/api/admin/connections');
    await expect(dialog.getByLabel('FHIR connection', { exact: true })).toHaveValue(connection.id);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog.getByLabel('Requested scopes', { exact: true })).toHaveValue('launch/patient patient/Patient.read patient/Observation.read');
    await expect(dialog.getByRole('radio', { name: /^Managed gateway/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /^Allow authenticated access to original upstream tokens/ })).not.toBeChecked();
    const [createdResponse] = await Promise.all([
      page.waitForResponse(item => new URL(item.url()).pathname === '/api/admin/installations' && item.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Create installation', exact: true }).click(),
    ]);
    assert.ok(createdResponse.ok(), `Installation creation failed: ${await createdResponse.text()}`);
    const installation = await createdResponse.json() as Installation;
    await expect(dialog).not.toBeVisible();

    // Validate the actual persisted graph, with no replacement of client IDs,
    // issuer URLs, callbacks, or scope selections during the guided workflow.
    const binding = await runtime.bridge.installation(installation.id);
    assert.equal(binding.application.id, application.id);
    assert.equal(binding.connection.id, connection.id);
    assert.equal(binding.connection.tenantId, organization.id);
    assert.equal(binding.connection.platformId, 'platform_epic');
    assert.equal(binding.appRegistration?.id, parent.id);
    assert.deepEqual(binding.appRegistration?.applicationIds, [application.id]);
    assert.deepEqual(binding.appRegistration?.clientRegistrationIds, [client.id]);
    assert.equal(binding.registration.clientId, 'workspace-synthetic-patient-client');
    assert.equal(binding.registration.platformId, 'platform_epic');
    assert.equal(binding.registration.environment, 'sandbox');
    assert.deepEqual(binding.installation.scopes, ['launch/patient', 'patient/Patient.read', 'patient/Observation.read']);
    assert.equal(binding.installation.allowTokenExport, false);
    for (const collection of ['applications', 'tenants', 'connections', 'registrations', 'app_registrations', 'installations']) assert.equal((await runtime.bridge.repo.list(collection)).length, 1, `The wizard should create one ${collection} record.`);

    // Editing from the application's Registrations tab must update the same
    // shared registration shown under the EHR platform.
    await appCard.getByRole('button', { name: 'Manage application', exact: true }).click();
    await page.getByRole('tab', { name: /^Registrations/ }).click();
    let parentCard = page.locator(`.registration-card[data-resource-id="${parent.id}"]`);
    await expect(parentCard).toContainText(client.name);
    await parentCard.getByRole('button', { name: `Edit ${parent.name}`, exact: true }).click();
    await dialog.getByLabel('Registration name', { exact: true }).fill('Workspace shared Epic registration');
    await dialog.getByRole('button', { name: 'Save registration', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(parentCard).toContainText('Workspace shared Epic registration');
    await parentCard.getByRole('button', { name: 'Epic', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'EHR Platforms', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Registrations/ })).toHaveAttribute('aria-selected', 'true');
    parentCard = page.locator(`.registration-card[data-resource-id="${parent.id}"]`);
    await expect(parentCard).toContainText('Workspace shared Epic registration');
    await expect(parentCard).toContainText(client.clientId);
    assert.equal((await runtime.bridge.repo.list('app_registrations')).length, 1, 'Cross-view editing must not copy a registration.');

    await navigate('Organizations');
    const organizationCard = page.locator(`.organization-resource-card[data-resource-id="${organization.id}"]`);
    await organizationCard.getByRole('button', { name: organization.name, exact: true }).click();
    await page.getByRole('tab', { name: /^Connections/ }).click();
    const connectionRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: new RegExp(`^${connection.name}`) }) });
    await expect(connectionRow).toContainText(connection.fhirBaseUrl);
    await expect(connectionRow).toContainText('Epic');
    await connectionRow.getByRole('button', { name: new RegExp(`^${connection.name}`) }).click();
    await expect(dialog).toHaveAttribute('aria-label', connection.name);
    await expect(dialog).toContainText(`${origin}/oauth/callback/${connection.id}`);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    await navigate('Installations');
    await page.getByRole('button', { name: installation.name, exact: true }).click();
    assert.equal(await page.locator('.installation-binding').count(), 4);
    await page.getByRole('tab', { name: 'Registration worksheet', exact: true }).click();
    const worksheetBlock = page.locator('.worksheet-code');
    await expect(worksheetBlock).toBeVisible();
    const worksheet = JSON.parse(await worksheetBlock.innerText());
    assert.equal(worksheet.installationId, installation.id);
    assert.equal(worksheet.appRegistrationId, parent.id);
    assert.equal(worksheet.clientRegistrationId, client.id);
    assert.equal(worksheet.clientEnvironment, 'sandbox');
    assert.equal(worksheet.clientId, client.clientId);
    assert.equal(worksheet.fhirBaseUrl, connection.fhirBaseUrl);
    assert.equal(worksheet.launchUrl, `${origin}/launch/${installation.id}`);
    assert.equal(worksheet.redirectUri, `${origin}/oauth/callback/${connection.id}`);
    assert.deepEqual(worksheet.appCallbackUrls, [`${origin}/reference-app`]);
    assert.deepEqual(worksheet.scopes, binding.installation.scopes);
    await page.screenshot({ path: join(artifacts, 'workspace-desktop.png'), fullPage: true, animations: 'disabled' });

    // Pre-activation failures remain visible even though no activation session
    // was ever issued. This event contains synthetic operational data only.
    const denialDetail = 'Synthetic EHR authorization failed (invalid_grant) before an activation was created.';
    await runtime.bridge.audit('launch.denied', denialDetail, { outcome: 'failure', installationId: installation.id, tenantId: organization.id });
    assert.deepEqual(await runtime.bridge.repo.list('activations'), []);
    await Promise.all([
      page.waitForResponse(item => new URL(item.url()).pathname === '/api/admin/dashboard'),
      page.getByTitle('Refresh workspace', { exact: true }).click(),
    ]);
    await navigate('Activations');
    await expect(page.getByRole('heading', { name: 'No activations in this view', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /^Launch activity/ }).click();
    await page.getByLabel('Filter launch outcome', { exact: true }).selectOption('failure');
    const denialRow = page.locator('.event-row').filter({ hasText: denialDetail });
    await expect(denialRow).toBeVisible();
    await expect(denialRow).toContainText('launch denied');
    await expect(denialRow).toContainText('No activation linked');

    // Mobile navigation must close after choosing a workspace section, while
    // wide registration and connection tables stay within their own scrollers.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => (document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
    await assertNoHorizontalOverflow();
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await navigate('Applications');
    await page.waitForFunction(() => (document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
    await page.locator(`.application-resource-card[data-resource-id="${application.id}"]`).getByRole('button', { name: 'Manage application', exact: true }).click();
    await page.getByRole('tab', { name: /^Registrations/ }).click();
    await expect(page.locator(`.registration-card[data-resource-id="${parent.id}"]`)).toContainText(client.name);
    await assertNoHorizontalOverflow();
    await page.screenshot({ path: join(artifacts, 'workspace-mobile.png'), fullPage: true, animations: 'disabled' });

    assert.deepEqual(browserErrors, [], 'The workspace must not emit uncaught browser exceptions.');
    assert.deepEqual(externalRequests, [], 'The isolated workspace check must not contact external services or sandbox endpoints.');
    console.log('Workspace acceptance passed: application-first navigation, full inline onboarding, persisted integration graph, shared registration editing, organization connections, exact worksheet bindings, pre-activation failures, and mobile navigation.');
    console.log('Isolated in-memory registry closed; saved developer and sandbox configurations were not opened.');
    console.log('Screenshots: .data/workspace-desktop.png, .data/workspace-mobile.png');
  } catch (error) {
    await page.screenshot({ path: join(artifacts, 'workspace-onboarding-failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
    throw error;
  }
} finally {
  await context?.close();
  await browser?.close();
  await runtime.app.close();
}
