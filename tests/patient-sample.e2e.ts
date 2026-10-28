/** Synthetic-only acceptance check for the independent patient SMART app. */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const appUrl = process.env.SMART_FLINT_PATIENT_URL ?? 'http://127.0.0.1:4100';
const bridgeUrl = process.env.SMART_FLINT_URL ?? 'http://127.0.0.1:3001';
const mockUrl = process.env.SMART_FLINT_MOCK_URL ?? 'http://127.0.0.1:4010';
for (const value of [appUrl, bridgeUrl, mockUrl]) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname), 'This acceptance check must only use a local synthetic environment.');
}
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : existsSync(chromePath) ? { executablePath: chromePath } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const page = await context.newPage();
const browserErrors: string[] = [];
page.on('pageerror', error => browserErrors.push(error.message));
mkdirSync('.data', { recursive: true });

async function authorize(patient: string) {
  await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).waitFor();
  const selector = page.getByLabel('Patient context', { exact: true });
  if (await selector.isVisible()) await selector.selectOption(patient);
  await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).click();
  await page.getByRole('heading', { name: 'Your health snapshot', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh record', exact: true }).waitFor();
}

async function launch(installation: string, patient: string, route: 'gateway' | 'direct' = 'gateway') {
  await page.goto(appUrl);
  await page.getByLabel('Healthcare connection', { exact: true }).selectOption(installation);
  if (route === 'direct') await page.getByRole('button', { name: 'Direct to EHR', exact: true }).click();
  await page.getByRole('button', { name: 'Connect my health record', exact: true }).click();
  await authorize(patient);
  assert.equal(new URL(page.url()).origin, new URL(appUrl).origin, 'The callback must return to the independently hosted app.');
  assert.equal(new URL(page.url()).search, '', 'One-use activation parameters must be removed.');
  assert.equal(await page.locator('.domain-card').count(), 4);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).length), 0, 'The patient app must not persist health information or credentials.');
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('smart-flint:launch:')).length), 0, 'The SDK launch transaction must be consumed after activation.');
}

async function disconnect() {
  await page.getByRole('button', { name: 'Disconnect health record', exact: true }).click();
  await page.getByRole('heading', { name: 'Let’s connect your record', exact: true }).waitFor();
  assert.equal(await page.locator('.domain-card').count(), 0, 'Disconnect must clear the in-memory patient snapshot.');
}

try {
  await page.goto(appUrl);
  await page.getByRole('heading', { name: 'Let’s connect your record', exact: true }).waitFor();
  await page.screenshot({ path: '.data/patient-landing.png', fullPage: true, animations: 'disabled' });

  await launch('inst_health_northstar', 'patient-a');
  assert.match(await page.locator('.coverage').innerText(), /4 of 4 areas/);
  assert.ok(await page.locator('.action-card').count() >= 1, 'The example with review findings must offer a next step.');
  await page.getByRole('button', { name: 'How this score works', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /unvalidated/);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'What this means', exact: true }).first().click();
  await page.locator('.domain-details').first().waitFor();
  await page.getByRole('button', { name: 'Sources & guidance', exact: true }).click();
  assert.ok(await page.locator('.sources-list a').count() >= 4);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.screenshot({ path: '.data/patient-dashboard.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The patient dashboard must fit a mobile viewport.');
  await page.screenshot({ path: '.data/patient-mobile.png', fullPage: false, animations: 'disabled' });
  await page.locator('.domains-grid').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: '.data/patient-mobile-details.png', fullPage: false, animations: 'disabled' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 1440, height: 1080 });

  await page.getByRole('button', { name: 'Developer connection', exact: true }).click();
  await page.getByRole('button', { name: 'Original FHIR server', exact: true }).click();
  await page.getByRole('button', { name: 'Original FHIR server', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.dialog .segmented button:last-child')?.getAttribute('aria-pressed') === 'true');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh record', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh record', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0, 'Direct mode must read successfully against the local CORS-enabled EHR.');
  await disconnect();

  await launch('inst_health_harbor', 'patient-b', 'direct');
  assert.match(await page.locator('.coverage').innerText(), /4 of 4 areas/);
  assert.equal(await page.locator('.priority-urgent').count(), 0);
  await disconnect();

  await launch('inst_health_lakeside', 'patient-c');
  assert.equal(await page.getByRole('tab', { name: 'Historical', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'Current', exact: true }).click();
  assert.ok(await page.locator('.status-stale, .status-unknown').count() >= 1, 'Old and missing results must remain visible.');
  assert.match(await page.locator('.score-dial').innerText(), /not scored/);
  await disconnect();

  await launch('inst_health_cedar', 'patient-d');
  assert.ok(await page.locator('.priority-urgent').count() >= 1, 'Recent extreme blood pressure must display conditional urgent guidance.');
  assert.match(await page.getByRole('alert', { name: 'Time-sensitive health guidance', exact: true }).innerText(), /Wait one minute.*emergency help/s);
  await page.getByRole('heading', { name: 'Review urgent reading first', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.querySelector('.urgent-banner')!.getBoundingClientRect().top < document.querySelector('.snapshot-card')!.getBoundingClientRect().top), 'Urgent guidance must appear before the composite score.');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: '.data/patient-urgent.png', fullPage: false, animations: 'disabled' });
  await disconnect();

  const deniedObservations = /\/fhir\/[^/]+\/Observation\?/;
  await page.route(deniedObservations, route => route.fulfill({ status: 403, contentType: 'application/fhir+json', body: JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden' }] }) }));
  await launch('inst_health_northstar', 'patient-a');
  assert.match(await page.locator('.score-dial').innerText(), /not scored/);
  assert.match(await page.locator('.coverage').innerText(), /0 of 4 areas/);
  assert.ok(await page.locator('.assessment-notices').isVisible(), 'Observation access failure must be explained as incomplete data.');
  const incompleteNotice = page.getByRole('status', { name: 'Record read incomplete', exact: true });
  assert.match(await incompleteNotice.innerText(), /We couldn’t read your measurements.*access to some measurements was denied/s);
  assert.equal(await page.getByRole('status', { name: 'Current information needed', exact: true }).count(), 0, 'Failed reads must not suggest a physical exam or new measurements.');
  assert.match(await page.locator('.availability-card').innerText(), /Record access needs attention/);
  await page.screenshot({ path: '.data/patient-record-unavailable.png', fullPage: false, animations: 'disabled' });
  await page.unroute(deniedObservations);
  await page.getByRole('button', { name: 'Try reading measurements again', exact: true }).click();
  await incompleteNotice.waitFor({ state: 'hidden' });
  assert.match(await page.locator('.coverage').innerText(), /4 of 4 areas/, 'Retry should recover the existing activation after record access is restored.');
  await disconnect();

  await page.route(deniedObservations, route => new URL(route.request().url()).searchParams.get('category') === 'laboratory'
    ? route.fulfill({ status: 403, contentType: 'application/fhir+json', body: JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden' }] }) })
    : route.continue());
  await launch('inst_health_northstar', 'patient-a');
  assert.match(await page.locator('.coverage').innerText(), /3 of 4 areas/, 'A denied laboratory query must preserve successful vital-sign and smoking reads.');
  assert.doesNotMatch(await page.locator('.score-dial').innerText(), /not scored/, 'A valid partial assessment must remain available.');
  assert.match(await incompleteNotice.innerText(), /Some measurements couldn’t be read/);
  assert.equal(await page.getByRole('status', { name: 'Current information needed', exact: true }).count(), 0);
  await page.unroute(deniedObservations);
  await disconnect();

  const ehrLaunch = new URL(`${mockUrl}/epic/northstar/ehr-launch`);
  ehrLaunch.searchParams.set('launch_url', `${bridgeUrl}/launch/inst_health_northstar`);
  ehrLaunch.searchParams.set('patient', 'patient-b');
  await page.goto(ehrLaunch.href);
  await authorize('patient-b');
  assert.match(await page.getByRole('heading', { name: /^Hello,/ }).innerText(), /Noah/);
  // Close the live activation before testing that a reload cannot recover PHI.
  await disconnect();

  const rejectedGrantDecision = '**/epic/northstar/oauth/decision';
  let rejectedGrantCallbacks = 0;
  await page.route(rejectedGrantDecision, async route => {
    assert.equal(new URL(route.request().url()).origin, new URL(mockUrl).origin, 'Only the synthetic EHR decision may be intercepted.');
    assert.equal(route.request().method(), 'POST');
    // Redirect requests are not routed separately, so change the mock consent
    // response and let the browser follow it to the real bridge callback.
    const response = await route.fetch({ maxRedirects: 0 });
    assert.equal(response.status(), 302);
    const location = response.headers().location;
    assert.ok(location, 'Synthetic consent must redirect to the bridge callback.');
    const callback = new URL(location);
    assert.equal(callback.origin, new URL(bridgeUrl).origin, 'The synthetic error injection must remain on the configured bridge origin.');
    assert.equal(callback.pathname, '/oauth/callback/conn_northstar');
    callback.searchParams.delete('code');
    callback.searchParams.set('error', 'invalid_grant');
    callback.searchParams.set('error_description', 'private-canary');
    rejectedGrantCallbacks += 1;
    await route.fulfill({ response, headers: { ...response.headers(), location: callback.href } });
  });
  try {
    await page.goto(appUrl);
    await page.getByLabel('Healthcare connection', { exact: true }).selectOption('inst_health_northstar');
    await page.getByRole('button', { name: 'Connect my health record', exact: true }).click();
    await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).waitFor();
    await page.getByLabel('Patient context', { exact: true }).selectOption('patient-a');
    await page.getByRole('button', { name: 'Continue with synthetic patient', exact: true }).click();
    const grantError = page.getByRole('alert');
    await grantError.waitFor();
    assert.equal(rejectedGrantCallbacks, 1, 'The test must exercise the real bridge OAuth callback once.');
    assert.match(await grantError.innerText(), /The EHR could not validate the authorization grant \(invalid_grant\)\. Start a fresh launch from the EHR\./);
    assert.doesNotMatch(await page.locator('body').innerText(), /private-canary/, 'Upstream error descriptions must not be shown to the application user.');
    assert.equal(await page.locator('.domain-card').count(), 0, 'A rejected authorization grant must not produce patient results.');
    assert.equal(new URL(page.url()).search, '', 'OAuth error parameters must be removed from the app callback URL.');
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('smart-flint:launch:')).length), 0, 'The failed launch transaction must be consumed.');
  } finally {
    await page.unroute(rejectedGrantDecision);
  }

  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Connect my health record', exact: true }).click();
  await page.getByRole('button', { name: 'Decline access', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.domain-card').count(), 0, 'Declining access must not produce fabricated results.');

  assert.deepEqual(browserErrors, [], 'The patient sample must not emit uncaught browser exceptions.');
  console.log('Patient sample acceptance passed: separate app callback, four synthetic connections, standalone/EHR launch, gateway/direct FHIR, incomplete data, urgent guidance, sources, mobile layout, disconnect, invalid grants and denied access.');
  console.log('Synthetic screenshots: .data/patient-landing.png, .data/patient-dashboard.png, .data/patient-mobile.png');
} finally {
  await context.close();
  await browser.close();
}
