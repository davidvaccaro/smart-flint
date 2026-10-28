import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import { createHealthFixture } from '@smart-flint/health-assessment';
import { buildMockEHR } from '../../../apps/mock-ehr/src/app.js';

const clients: Awaited<ReturnType<typeof buildMockEHR>>[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(app => app.close())); });
async function fixture() {
  // Vite defines BASE_URL='/' in its test environment; pin this fixture's service URLs.
  const app = await buildMockEHR({ baseUrl: 'http://localhost:4010', bridgeBaseUrl: 'http://localhost:3001', consoleUrl: 'http://localhost:3000' });
  clients.push(app); return app;
}
const verifier = 'a'.repeat(43);
const base = 'http://localhost:4010/epic/northstar';
const callback = 'http://localhost:3001/oauth/callback/conn_northstar';
async function getCode(app: Awaited<ReturnType<typeof buildMockEHR>>, scope = 'launch/patient patient/Patient.rs patient/Observation.rs user/Practitioner.rs offline_access', clientId = 'smart-flint-demo') {
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: callback,
    aud: `${base}/r4`, state: 'state-for-this-transaction', scope,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const consent = await app.inject({ method: 'GET', url: `/epic/northstar/oauth/authorize?${params}` });
  expect(consent.statusCode).toBe(200);
  const transaction = /name="transaction" value="([^"]+)"/.exec(consent.body)![1]!;
  const decision = await app.inject({ method: 'POST', url: '/epic/northstar/oauth/decision', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ transaction, decision: 'allow', patient: 'patient-a' }).toString() });
  expect(decision.statusCode).toBe(302);
  return new URL(decision.headers.location!).searchParams.get('code')!;
}
async function exchange(app: Awaited<ReturnType<typeof buildMockEHR>>, code: string, codeVerifier = verifier, clientId = 'smart-flint-demo') {
  return app.inject({ method: 'POST', url: '/epic/northstar/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: codeVerifier }).toString() });
}

describe('synthetic EHR protocol fixture', () => {
  it('enforces PKCE and one-time authorization codes', async () => {
    const app = await fixture(); const code = await getCode(app);
    expect((await exchange(app, code, 'b'.repeat(43))).statusCode).toBe(400);
    const token = await exchange(app, code);
    expect(token.statusCode).toBe(200);
    expect(token.json().patient).toBe('patient-a');
    expect((await exchange(app, code)).statusCode).toBe(400);
  });

  it('keeps identical FHIR identifiers isolated between tenants and patients', async () => {
    const app = await fixture(); const token = (await exchange(app, await getCode(app))).json().access_token as string;
    const headers = { Authorization: `Bearer ${token}` };
    expect((await app.inject({ url: '/epic/northstar/r4/Patient/patient-a', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/epic/harbor/r4/Patient/patient-a', headers })).statusCode).toBe(401);
    // A user/Practitioner scope must not widen a patient/Patient scope.
    expect((await app.inject({ url: '/epic/northstar/r4/Patient/patient-b', headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/epic/northstar/r4/Observation?patient=patient-b', headers })).statusCode).toBe(403);
    const otherObservation = createHealthFixture('patient-b').observations[0]!;
    expect((await app.inject({ url: `/epic/northstar/r4/Observation/${otherObservation.id}`, headers })).statusCode).toBe(403);
    const page = (await app.inject({ url: '/epic/northstar/r4/Observation?_count=1', headers })).json();
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.entry).toHaveLength(1);
    expect(page.link.find((link: { relation: string }) => link.relation === 'next').url).toContain('/epic/northstar/r4/Observation?');
  });

  it('represents a patient-facing client with a Patient identity and rejects clinician-wide scopes', async () => {
    const app = await fixture();
    const clientId = 'smart-flint-health-patient';
    const code = await getCode(app, 'launch/patient patient/Patient.r patient/Observation.rs openid fhirUser', clientId);
    const response = await exchange(app, code, verifier, clientId);
    expect(response.statusCode).toBe(200);
    expect(decodeJwt(response.json().id_token).fhirUser).toBe(`${base}/r4/Patient/patient-a`);
    const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback, aud: `${base}/r4`, state: 'patient-scope-check', scope: 'user/Patient.rs', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const denied = await app.inject({ url: `/epic/northstar/oauth/authorize?${params}` });
    expect(denied.json().error).toBe('invalid_scope');
  });

  it('separates vital signs, laboratory results, and social history in patient observation searches', async () => {
    const app = await fixture();
    const token = (await exchange(app, await getCode(app))).json().access_token as string;
    const headers = { Authorization: `Bearer ${token}` };
    const expected = {
      'vital-signs': ['observation-a-1', 'observation-a-2', 'health-patient-a-bp-previous', 'health-patient-a-bp', 'health-patient-a-bmi'],
      laboratory: ['health-patient-a-a1c-previous', 'health-patient-a-a1c'],
      'social-history': ['health-patient-a-tobacco'],
    };
    for (const [category, ids] of Object.entries(expected)) {
      const query = new URLSearchParams({ patient: 'patient-a', category, _count: '100' });
      const response = await app.inject({ url: `/epic/northstar/r4/Observation?${query}`, headers });
      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.entry.map((entry: { resource: { id: string } }) => entry.resource.id).sort()).toEqual([...ids].sort());
      expect(result.total).toBe(ids.length);
      expect(result.entry.every((entry: { resource: { subject: { reference: string } } }) => entry.resource.subject.reference === 'Patient/patient-a')).toBe(true);
    }
  });

  it('rotates refresh tokens and rejects old or cross-tenant tokens', async () => {
    const app = await fixture(); const initial = (await exchange(app, await getCode(app))).json();
    const refresh = (url: string, token: string) => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ client_id: 'smart-flint-demo', grant_type: 'refresh_token', refresh_token: token }).toString() });
    expect((await refresh('/epic/harbor/oauth/token', initial.refresh_token)).statusCode).toBe(400);
    const rotated = await refresh('/epic/northstar/oauth/token', initial.refresh_token);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().refresh_token).not.toBe(initial.refresh_token);
    expect((await refresh('/epic/northstar/oauth/token', initial.refresh_token)).statusCode).toBe(400);
  });

  it('refuses arbitrary authorization callbacks and interactive system privileges', async () => {
    const app = await fixture();
    const query = new URLSearchParams({ client_id: 'smart-flint-demo', redirect_uri: 'https://attacker.example/callback' });
    expect((await app.inject({ url: `/epic/northstar/oauth/authorize?${query}` })).statusCode).toBe(400);
    const params = new URLSearchParams({ client_id: 'smart-flint-demo', redirect_uri: callback, response_type: 'code', aud: `${base}/r4`, state: 'state', scope: 'system/Patient.rs', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    expect((await app.inject({ url: `/epic/northstar/oauth/authorize?${params}` })).json().error).toBe('invalid_scope');
  });
});
