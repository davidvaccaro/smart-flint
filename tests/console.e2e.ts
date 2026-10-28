/** Local, synthetic-only UI acceptance check. Run after npm run dev. */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { ActivationSession, Dashboard } from '../packages/contracts/src/index.js';

const baseUrl = process.env.SMART_FLINT_CONSOLE_URL ?? 'http://127.0.0.1:3010';
const mockUrl = process.env.SMART_FLINT_MOCK_URL ?? 'http://127.0.0.1:4010';
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(chromePath) ? { executablePath: chromePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
const browserErrors: string[] = [];
page.on('pageerror', error => browserErrors.push(error.message));
const ownActivations = new Set<string>();
const activationCaptures: Promise<void>[] = [];
page.on('response', response => {
  const path = new URL(response.url()).pathname;
  if (!response.ok() || !['/api/activations/redeem', '/api/service-activations'].includes(path)) return;
  activationCaptures.push(response.json().then((body: ActivationSession) => { ownActivations.add(body.activation.id); }));
});
const configurationCreates: string[] = [];
page.on('request', request => {
  const path = new URL(request.url()).pathname;
  if (request.method() === 'POST' && /^\/api\/admin\/(applications|tenants|platforms|connections|registrations|app-registrations|installations)$/.test(path)) configurationCreates.push(path);
});
mkdirSync('.data', { recursive: true });

async function openConsole(view: 'applications' | 'developer' = 'applications') {
  await page.goto(view === 'applications' ? `${baseUrl}/` : `${baseUrl}/#developer`);
  await page.waitForFunction(() => !!document.querySelector('.login-submit:not(:disabled)') || !!document.querySelector('.sidebar'));
  const login = page.getByRole('button', { name: 'Open local workspace', exact: true });
  if (await login.isVisible({ timeout: 2000 }).catch(() => false)) await login.click();
  await page.getByRole('heading', { name: view === 'applications' ? 'Applications' : 'Developer lab', level: 1, exact: true }).waitFor();
}

async function launch(mode: 'gateway' | 'direct' | 'handoff', installationId = 'inst_northstar', patient = 'patient-a') {
  await openConsole('developer');
  await page.getByLabel('Installation', { exact: true }).selectOption(installationId);
  await page.getByLabel('Access mode', { exact: true }).selectOption(mode);
  await page.getByRole('button', { name: 'Launch application', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).waitFor();
  const selector = page.getByLabel('Patient context');
  if (await selector.isVisible()) await selector.selectOption(patient);
  await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).click();
  await page.getByRole('heading', { name: 'Application activated', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send GET request', exact: true }).click();
  await page.getByRole('heading', { name: 'FHIR response', exact: true }).waitFor();
  assert.match(await page.locator('.fhir-response').innerText(), /"resourceType": "Patient"/);
  assert.match(await page.locator('.fhir-response').innerText(), new RegExp(`"id": "${patient}"`));
}

try {
  await openConsole();
  const dashboardResponse = await context.request.get(`${baseUrl}/api/admin/dashboard`);
  assert.equal(dashboardResponse.status(), 200);
  const data = await dashboardResponse.json() as Dashboard;
  assert.equal(data.runtime.demo, true, 'This acceptance suite uses local synthetic fixtures only');
  const clinicalApp = data.applications.find(item => item.id === 'app_clinical')!;
  const northstar = data.tenants.find(item => item.id === 'tenant_northstar')!;
  const connection = data.connections.find(item => item.id === 'conn_northstar')!;
  const installation = data.installations.find(item => item.id === 'inst_northstar')!;
  const registration = data.registrations.find(item => item.id === 'reg_demo')!;
  const parent = data.appRegistrations.find(item => item.id === installation.appRegistrationId)!;
  assert.ok(clinicalApp && northstar && connection && installation && registration && parent, 'The built-in clinical fixture must be present');
  assert.equal(connection.fhirBaseUrl, `${mockUrl}/epic/northstar/r4`, 'Discovery verification must target the local simulator');
  assert.equal(parent.platformId, connection.platformId);
  assert.ok(parent.applicationIds.includes(clinicalApp.id));
  assert.ok(parent.clientRegistrationIds.includes(registration.id));
  const mainNavigation = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  assert.deepEqual(await mainNavigation.locator('button > span:first-of-type').allTextContents(), ['Applications', 'EHR Platforms', 'Organizations', 'Installations', 'Activations']);
  assert.equal(await mainNavigation.getByRole('button', { name: 'Connections', exact: true }).count(), 0);
  await page.locator('[data-resource-id="app_clinical"]').getByRole('button', { name: 'Manage application', exact: true }).click();
  await page.getByRole('heading', { name: clinicalApp.name, exact: true }).waitFor();
  await page.getByRole('tab', { name: /^Registrations/ }).click();
  await page.locator(`[data-resource-id="${parent.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-resource-id="${parent.id}"] .profile-client-id`).innerText(), registration.clientId);
  await mainNavigation.getByRole('button', { name: 'EHR Platforms', exact: true }).click();
  await page.locator(`[data-resource-id="${parent.platformId}"] .resource-card-title`).click();
  await page.getByRole('tab', { name: /^Registrations/ }).click();
  await page.locator(`[data-resource-id="${parent.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-resource-id="${parent.id}"] .profile-client-id`).innerText(), registration.clientId, 'Application and platform must show the same portal registration');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('heading', { name: 'Workspace overview', exact: true }).waitFor();
  assert.equal(await page.locator('.metric-card').count(), 4);
  await page.screenshot({ path: '.data/console-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => (document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0) <= 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile layout must not overflow horizontally');
  await page.screenshot({ path: '.data/console-mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await mainNavigation.getByRole('button', { name: 'Organizations', exact: true }).click();
  await page.getByRole('heading', { name: 'Organizations', level: 1, exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('[data-resource-id="tenant_northstar"]').getByRole('button', { name: 'Manage organization', exact: true }).click();
  await page.getByRole('heading', { name: northstar.name, exact: true }).waitFor();
  await page.getByRole('tab', { name: /^Connections/ }).click();
  const connectionRow = page.locator('tbody tr').filter({ hasText: connection.name });
  assert.equal(await connectionRow.count(), 1);
  assert.equal(await connectionRow.locator('.endpoint-text').innerText(), connection.fhirBaseUrl);
  await connectionRow.getByRole('button', { name: 'Verify', exact: true }).click();
  await connectionRow.locator('.badge-verified').waitFor();
  await page.locator('.collection-toolbar').getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('heading', { name: 'Connect an EHR', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await mainNavigation.getByRole('button', { name: 'Installations', exact: true }).click();
  await page.locator('.heading-actions').getByRole('button', { name: 'Create installation', exact: true }).click();
  await page.getByLabel('Installation name', { exact: true }).fill('Synthetic UI wizard check');
  await page.getByLabel('Application', { exact: true }).selectOption('app_clinical');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('EHR platform', { exact: true }).selectOption(parent.platformId);
  await page.getByLabel('App registration', { exact: true }).selectOption(parent.id);
  await page.getByLabel('OAuth client profile', { exact: true }).selectOption('reg_demo');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Organization', { exact: true }).selectOption('tenant_northstar');
  await page.getByLabel('FHIR connection', { exact: true }).selectOption('conn_northstar');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Create an installation', exact: true }).waitFor();
  assert.match(await page.locator('.wizard-steps li.current').innerText(), /Policy & review/);
  const requestedScopes = (await page.getByLabel('Requested scopes', { exact: true }).inputValue()).split(/\s+/);
  for (const required of clinicalApp.requiredScopes) assert.ok(requestedScopes.includes(required));
  assert.match(await page.getByRole('dialog').innerText(), /Synthetic UI wizard check/);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.deepEqual(configurationCreates, [], 'Navigation and the cancelled wizard must not create configuration records');
  await page.locator('[data-resource-id="inst_northstar"] .entity-button').click();
  await page.getByRole('tab', { name: 'Registration worksheet', exact: true }).click();
  await page.locator('.worksheet-code').waitFor();
  const worksheet = JSON.parse(await page.locator('.worksheet-code').innerText());
  assert.equal(worksheet.launchUrl, `${data.runtime.baseUrl}/launch/inst_northstar`);
  assert.equal(worksheet.redirectUri, `${data.runtime.baseUrl}/oauth/callback/conn_northstar`);
  assert.equal(worksheet.clientId, registration.clientId);
  assert.equal(worksheet.appRegistrationId, parent.id);
  assert.deepEqual(worksheet.scopes, installation.scopes);

  await page.getByRole('button', { name: 'Developer lab', exact: true }).click();
  await page.getByLabel('Service installation', { exact: true }).selectOption('inst_service');
  await page.getByRole('button', { name: 'Acquire service session', exact: true }).click();
  await page.getByRole('button', { name: 'Search Patient', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Search Patient', exact: true }).click();
  await page.locator('.backend-result .code-block').waitFor();
  assert.match(await page.locator('.backend-result .code-block').innerText(), /"resourceType": "Bundle"/);
  await page.getByRole('button', { name: 'Close service session', exact: true }).click();
  await page.getByLabel('CDS service', { exact: true }).selectOption('cds_demo');
  await page.getByRole('button', { name: 'Invoke hook', exact: true }).click();
  await page.getByRole('heading', { name: 'SMART Flint received this synthetic patient-view hook.', exact: true }).waitFor();

  await launch('gateway', 'inst_northstar', 'patient-b');
  await page.screenshot({ path: '.data/reference-app.png', fullPage: true });
  await page.getByRole('button', { name: 'Close SMART Flint session', exact: true }).click();
  await page.getByRole('heading', { name: 'Activation closed', exact: true }).waitFor();

  await launch('direct', 'inst_harbor');
  await page.getByRole('button', { name: 'Inspect original token response', exact: true }).click();
  await page.locator('.credential-result .code-block').waitFor();
  assert.match(await page.locator('.credential-result .code-block').innerText(), /hidden — available to this application/);
  assert.equal(await page.getByLabel('Show token values').isChecked(), false);
  await page.getByRole('button', { name: 'Close SMART Flint session', exact: true }).click();

  await launch('handoff');
  await page.getByRole('button', { name: 'Transfer refresh ownership', exact: true }).click();
  await page.locator('.credential-result .code-block').waitFor();
  assert.match(await page.locator('.credential-result .code-block').innerText(), /"refreshOwner": "application"/);
  await page.getByRole('button', { name: 'Close SMART Flint session', exact: true }).click();

  await page.goto(`${mockUrl}/epic/northstar/ehr-launch`);
  await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).click();
  await page.getByRole('heading', { name: 'Application activated', exact: true }).waitFor();
  assert.match(await page.locator('.context-row').filter({ hasText: 'Patient' }).innerText(), /Patient\/patient-a/);
  await page.getByRole('button', { name: 'Close SMART Flint session', exact: true }).click();

  assert.deepEqual(browserErrors, [], 'The console must not emit uncaught browser exceptions');
  assert.deepEqual(configurationCreates, [], 'Acceptance checks must preserve existing configuration');
  console.log('Console acceptance passed: application-first navigation, shared platform registrations, organization connections, unchanged worksheet URLs, responsive navigation, discovery, four-step wizard, backend access, CDS Hooks, gateway, direct access, credential handoff, and EHR bootstrap.');
  console.log('Screenshots: .data/console-desktop.png, .data/console-mobile.png, .data/reference-app.png');
} finally {
  await Promise.allSettled(activationCaptures);
  if (ownActivations.size) {
    const response = await context.request.get(`${baseUrl}/api/admin/dashboard`);
    if (response.ok()) {
      const dashboard = await response.json() as Dashboard;
      for (const activation of dashboard.activations.filter(item => ownActivations.has(item.id) && item.status !== 'closed')) {
        const closed = await context.request.post(`${baseUrl}/api/admin/activations/${activation.id}/close`, { headers: { Origin: baseUrl } });
        assert.equal(closed.status(), 200, 'The acceptance suite must close only its own activation sessions');
      }
    }
  }
  await context.close();
  await browser.close();
}
