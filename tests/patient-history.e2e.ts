/** Synthetic-only browser regression for assessment tabs and callback presentation. */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assessHealth, assessHistoricalHealth, createHealthFixture } from '../packages/health-assessment/src/index.js';

const appUrl = process.env.SMART_FLINT_PATIENT_URL ?? 'http://127.0.0.1:4100';
const bridgeUrl = process.env.SMART_FLINT_URL ?? 'http://127.0.0.1:3001';
const mockUrl = process.env.SMART_FLINT_MOCK_URL ?? 'http://127.0.0.1:4010';
for (const url of [appUrl, bridgeUrl, mockUrl]) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Use local synthetic services only.');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : existsSync(chromePath) ? { executablePath: chromePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, timezoneId: 'America/New_York' });
const errors: string[] = [];
mkdirSync('.data', { recursive: true });

// Observe every callback document, including the brief bootstrap visit before
// authorization. Report only presentation flags, never URLs, codes or records.
const callbackFrames: { event: string; phase: string }[] = [];
await context.exposeBinding('__reportPatientLaunchFrame', (_source, report: { event: string; phase: string }) => { callbackFrames.push(report); });
await context.addInitScript({ content: `(() => {
  if (location.pathname !== '/callback') return;
  const params = new URLSearchParams(location.search);
  if (!['smart_flint_launch', 'code', 'state', 'error'].some(key => params.has(key))) return;
  const phase = params.has('smart_flint_launch') ? 'bootstrap' : 'activation';
  const sent = new Set();
  const report = event => {
    if (sent.has(event)) return;
    sent.add(event);
    void window.__reportPatientLaunchFrame({ event, phase });
  };
  const observer = new MutationObserver(() => {
    if (document.querySelector('.landing, .login-screen, .sidebar')) report('landing');
    if (document.querySelector('[data-testid="launch-loading"]')) report('loading');
    if (document.querySelector('main.dashboard, .error-banner')) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
})();` });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));

// Keep bootstrap visible long enough to observe its first rendered frame even
// when the local API would otherwise complete before a browser paint.
await page.route('**/api/launches/bootstrap/*', async route => {
  await page.getByTestId('launch-loading').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.landing, .login-screen, .sidebar').count(), 0);
  callbackFrames.push({ event: 'loading', phase: 'bootstrap' });
  await route.continue();
});

// Change only this browser's synthetic responses; source EHR data is untouched.
const historicalFixture = createHealthFixture('patient-b', { asOf: '2021-02-24T04:00:00.000Z' });
const pressure = historicalFixture.observations.find(item => item.code?.coding?.some(coding => coding.code === '85354-9'))!;
pressure.code!.coding!.find(coding => coding.code === '85354-9')!.code = '55284-4';
let records = historicalFixture.observations;
let observationReads = 0;
await page.route(/\/(?:fhir\/[^/]+|epic\/northstar\/r4)\/Observation\?/, async route => {
  observationReads++;
  await route.fulfill({ status: 200, contentType: 'application/fhir+json', body: JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: records.length, entry: records.map(resource => ({ resource })) }) });
});

async function launch(ehr = false) {
  if (ehr) {
    const url = new URL(`${mockUrl}/epic/northstar/ehr-launch`);
    url.searchParams.set('patient', 'patient-b');
    url.searchParams.set('launch_url', `${bridgeUrl}/launch/inst_health_northstar`);
    await page.goto(url.href);
  } else {
    await page.goto(appUrl);
    await page.getByLabel('Healthcare connection', { exact: true }).selectOption('inst_health_northstar');
    await page.getByRole('button', { name: 'Connect my health record', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).waitFor();
  const patientSelector = page.getByLabel('Patient context', { exact: true });
  if (await patientSelector.isVisible()) await patientSelector.selectOption('patient-b');
  await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).click();
  await page.getByRole('heading', { name: 'Your health snapshot', exact: true }).waitFor();
}
async function disconnect() {
  await page.getByRole('button', { name: 'Disconnect health record', exact: true }).click();
  await page.getByRole('heading', { name: 'Let’s connect your record', exact: true }).waitFor();
}
async function selectedTab(name: 'Current' | 'Historical') {
  assert.equal(await page.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true');
}

try {
  await launch(true);
  await selectedTab('Historical');
  assert.equal(await page.locator('main.dashboard').getAttribute('data-assessment-mode'), 'historical');
  assert.match(await page.locator('.score-dial').innerText(), /100/);
  assert.match(await page.locator('.coverage').innerText(), /4 of 4 areas/);
  const banner = page.locator('.historical-banner');
  assert.match(await banner.innerText(), /Feb 20, 2021/, 'Historical dates must stay aligned with UTC near a local-day boundary.');
  assert.match(await page.locator('.automatic-history-notice').innerText(), /recent|current/i);
  assert.match(await page.locator('.automatic-history-notice').innerText(), /care team|health review|physical/i);
  assert.equal(await page.locator('.urgent-banner').count(), 0);
  assert.ok(callbackFrames.some(frame => frame.phase === 'bootstrap' && frame.event === 'loading'), 'The bootstrap visit must show the patient loading state.');
  assert.ok(callbackFrames.some(frame => frame.phase === 'activation' && frame.event === 'loading'), 'The activation callback must show the patient loading state.');
  assert.equal(callbackFrames.filter(frame => frame.event === 'landing').length, 0, 'No callback visit may flash a landing or management page.');
  await page.screenshot({ path: '.data/patient-history-preview.png', fullPage: true, animations: 'disabled' });
  const readsBeforeSwitch = observationReads;
  await page.getByRole('tab', { name: 'Current', exact: true }).click();
  await selectedTab('Current');
  assert.match(await page.locator('.score-dial').innerText(), /not scored/);
  assert.match(await page.locator('.availability-card').innerText(), /older|stale/i);
  assert.equal(observationReads, readsBeforeSwitch, 'Tabs reuse the authorized in-memory snapshot.');
  await page.screenshot({ path: '.data/patient-history-current.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Refresh record', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.greeting .button')?.hasAttribute('disabled'));
  await selectedTab('Current');
  await page.getByRole('button', { name: 'Developer connection', exact: true }).click();
  await page.getByRole('button', { name: 'Original FHIR server', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.greeting .button')?.hasAttribute('disabled'));
  await selectedTab('Current');
  await page.getByRole('button', { name: 'Developer connection', exact: true }).click();
  await page.getByRole('button', { name: 'Gateway', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.greeting .button')?.hasAttribute('disabled'));
  await selectedTab('Current');
  await page.getByRole('tab', { name: 'Current', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await selectedTab('Historical');
  await page.keyboard.press('ArrowLeft');
  await selectedTab('Current');
  await page.keyboard.press('ArrowRight');
  await selectedTab('Historical');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Tabs and historical information must fit mobile.');
  assert.equal(await page.locator('header.header').count(), 1);
  assert.equal(await page.locator('main.dashboard').count(), 1);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: '.data/patient-history-mobile.png', fullPage: false, animations: 'disabled' });
  await page.locator('.snapshot-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.data/patient-history-mobile-score.png', fullPage: false, animations: 'disabled' });
  await disconnect();
  assert.equal(await page.locator('.domain-card, .historical-banner, [role="tablist"]').count(), 0);

  // A dated assessment is also available for a normal EHR, without labeling its
  // records synthetic. The browser response alone is changed for this check.
  await page.route('**/api/activations/redeem', async route => {
    const response = await route.fetch(); const body = await response.json();
    body.activation.upstream.baseUrl = 'https://ehr.example.org/fhir/r4';
    delete body.activation.context.extensions.synthetic_environment;
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await launch();
  await selectedTab('Historical');
  assert.doesNotMatch(await banner.innerText(), /sandbox/i);
  await disconnect();
  await page.unroute('**/api/activations/redeem');

  records = [];
  await launch();
  await selectedTab('Current');
  assert.equal(await page.getByRole('tab', { name: 'Historical', exact: true }).isDisabled(), true);
  assert.ok(await page.locator('.historical-unavailable').isVisible());
  assert.match(await page.locator('.score-dial').innerText(), /not scored/);
  await disconnect();

  // A null composite must never hide a recent urgent reading. At a slightly
  // earlier historical anchor the just-stale A1c still supplies a second domain.
  const urgent = createHealthFixture('patient-b');
  urgent.observations = urgent.observations.filter(item => item.code?.coding?.some(code => ['85354-9', '4548-4'].includes(code.code ?? '')));
  const urgentPressure = urgent.observations.find(item => item.code?.coding?.some(code => code.code === '85354-9'))!;
  urgentPressure.component![0]!.valueQuantity!.value = 190;
  urgentPressure.component![1]!.valueQuantity!.value = 122;
  urgentPressure.effectiveDateTime = new Date(Date.now() - 2 * 3600000).toISOString();
  urgent.observations.find(item => item.code?.coding?.some(code => code.code === '4548-4'))!.effectiveDateTime = new Date(Date.now() - 365 * 86400000 - 3600000).toISOString();
  assert.equal(assessHealth(urgent).score.value, null);
  assert.notEqual(assessHistoricalHealth(urgent)!.score.value, null);
  records = urgent.observations;
  await launch();
  await selectedTab('Current');
  assert.ok(await page.getByRole('alert', { name: 'Time-sensitive health guidance', exact: true }).isVisible());
  await page.getByRole('tab', { name: 'Historical', exact: true }).click();
  await selectedTab('Historical');
  assert.ok(await page.getByRole('alert', { name: 'Time-sensitive health guidance', exact: true }).isVisible(), 'Current urgent guidance remains visible while inspecting history.');
  await disconnect();
  assert.deepEqual(errors, []);
  console.log('Assessment tabs passed: automatic historical selection, manual/refresh persistence, keyboard/mobile access, honest dates, any EHR, empty records, current urgency and flash-free EHR callbacks.');
} finally {
  const button = page.getByRole('button', { name: 'Disconnect health record', exact: true });
  if (await button.isVisible().catch(() => false)) await disconnect().catch(() => undefined);
  await context.close(); await browser.close();
}
