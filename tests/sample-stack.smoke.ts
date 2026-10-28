/** Live, synthetic-only protocol matrix. Start `npm run dev` before running this file. */
import assert from 'node:assert/strict';
import { assessHealth, createHealthFixture, type HealthAssessment } from '@smart-flint/health-assessment';

const bridgeUrl = 'http://127.0.0.1:3001';
const ehrUrl = 'http://127.0.0.1:4010';
const serviceUrl = 'http://127.0.0.1:4102';
const consoleOrigin = 'http://127.0.0.1:3010';
const targets = [
  { tenant: 'northstar', vendor: 'epic' },
  { tenant: 'harbor', vendor: 'epic' },
  { tenant: 'lakeside', vendor: 'oracle' },
  { tenant: 'cedar', vendor: 'meditech' },
];
const patients = ['patient-a', 'patient-b', 'patient-c', 'patient-d'] as const;
const forbiddenFields = new Set(['sessionToken', 'accessToken', 'access_token', 'refresh_token', 'refreshToken', 'applicationKey']);

function hasCredentialFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasCredentialFields);
  return Object.entries(value).some(([key, item]) => forbiddenFields.has(key) || hasCredentialFields(item));
}

async function post<T>(url: string, body: unknown, label: string, token?: string): Promise<T> {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      status = response.status;
      if (status >= 500 && attempt < 2) continue; // A local watch process may be restarting.
      assert.equal(status, 200, `${label}: unexpected HTTP status`);
      const result: unknown = await response.json();
      assert.equal(hasCredentialFields(result), false, `${label}: credential field in an application response`);
      return result as T;
    } catch (error) {
      if (error instanceof assert.AssertionError || attempt === 2) throw error;
    }
  }
  throw new Error(`${label}: local service unavailable (${status})`);
}

interface CDSResult { cards: { indicator: string; summary: string }[] }
interface BackendResult { assessments: HealthAssessment[]; issues: { code: string }[] }

async function verifyCleanup(): Promise<void> {
  const auth = await fetch(`${bridgeUrl}/api/admin/session`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Origin: consoleOrigin, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(auth.status, 200, 'Cleanup verification requires the local demo admin login.');
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'The local demo admin session was not created.');
  try {
    const response = await fetch(`${bridgeUrl}/api/admin/dashboard`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Cookie: cookie, Origin: consoleOrigin },
    });
    assert.equal(response.status, 200, 'The local admin dashboard could not be read.');
    const data = await response.json() as { activations: { kind: string; installationId: string; status: string }[] };
    const samples = data.activations.filter(item => item.kind === 'service' && item.installationId.startsWith('inst_health_service_'));
    const open = samples.filter(item => item.status !== 'closed');
    assert.ok(samples.length >= 32, 'Expected at least 32 backend sample activations in the recent dashboard.');
    assert.equal(open.length, 0, 'A backend sample activation remained open.');
    process.stdout.write(JSON.stringify({ cleanup: { recentSampleActivations: samples.length, open: open.length } }) + '\n');
  } finally {
    await fetch(`${bridgeUrl}/api/admin/session`, {
      method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Cookie: cookie, Origin: consoleOrigin },
    });
  }
}

try {
  const health = await fetch(`${ehrUrl}/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200, 'Start the local synthetic EHR before running the smoke matrix.');
  assert.equal((await health.json() as { synthetic?: boolean }).synthetic, true, 'This smoke matrix is restricted to the synthetic EHR.');
  let operations = 0;
  for (const target of targets) {
    for (const patientId of patients) {
      const label = `${target.tenant}/${patientId}`;
      const expected = assessHealth(createHealthFixture(patientId));
      const cds = await post<CDSResult>(`${ehrUrl}/${target.vendor}/${target.tenant}/cds-hooks/health-review`, { patientId }, `${label}/cds`);
      assert.ok(Array.isArray(cds.cards) && cds.cards.length > 0 && cds.cards.length <= 4, `${label}: expected one to four CDS cards`);
      if (patientId === 'patient-d') assert.equal(cds.cards[0]!.indicator, 'critical', `${label}: expected conditional urgent advice first`);
      operations++;
      for (const route of ['gateway', 'direct'] as const) {
        const result = await post<BackendResult>(`${serviceUrl}/assessments`, {
          installationId: `inst_health_service_${target.tenant}`, patientId, route,
        }, `${label}/${route}`, 'demo-health-service-client');
        assert.equal(result.assessments.length, 1, `${label}/${route}: expected one assessment`);
        const actual = result.assessments[0]!;
        assert.equal(actual.patient.id, patientId, `${label}/${route}: patient mismatch`);
        assert.equal(actual.score.value, expected.score.value, `${label}/${route}: score mismatch`);
        assert.equal(actual.score.coveragePercent, expected.score.coveragePercent, `${label}/${route}: coverage mismatch`);
        assert.deepEqual(result.issues, [], `${label}/${route}: unexpected operational issue`);
        operations++;
      }
      // Fixture labels and summary counts only; never print Patient names, records or credentials.
      process.stdout.write(JSON.stringify({
        tenant: target.tenant, fixture: patientId, cards: cds.cards.length,
        indicators: cds.cards.map(card => card.indicator),
        backendRoutes: ['gateway', 'direct'], score: expected.score.value, coveragePercent: expected.score.coveragePercent, status: 'passed',
      }) + '\n');
    }
  }
  if (process.argv.includes('--verify-cleanup')) await verifyCleanup();
  process.stdout.write(JSON.stringify({ summary: { operations, failures: 0, syntheticOnly: true } }) + '\n');
} catch {
  process.stderr.write('Synthetic sample smoke verification failed. Check the local stack and run the service tests for focused diagnostics. No response bodies or credentials were printed.\n');
  process.exitCode = 1;
}
