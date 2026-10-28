import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { buildApp } from '../apps/server/src/app.js';
import { seedDemo } from '../apps/server/src/seed.js';
import { buildMockEHR } from '../apps/mock-ehr/src/app.js';
import { digest } from '../packages/storage/src/index.js';
import type { ActivationSession, CredentialResponse, Installation, OriginalCredentialResponse } from '../packages/contracts/src/index.js';
import type { Grant, GrantSecret } from '../apps/server/src/models.js';

describe('complete SMART Flint protocol workflows', () => {
  let runtime: Awaited<ReturnType<typeof buildApp>>;
  let ehr: Awaited<ReturnType<typeof buildMockEHR>>;
  let ehrUrl: string;
  let signing: Awaited<ReturnType<typeof generateKeyPair>>;
  let receivedHook: unknown;
  let handlerCredential = '';
  beforeAll(async () => {
    runtime = await buildApp({ config: { demo: true, host: '127.0.0.1', encryptionKey: Buffer.alloc(32, 3).toString('base64'), sqlitePath: ':memory:', baseUrl: 'http://localhost:3001', consoleUrl: 'http://localhost:3010', adminToken: 'integration-admin-token-with-enough-entropy' }, seed: false, serveConsole: false });
    await runtime.app.listen({ port: 0, host: '127.0.0.1' });
    const address = runtime.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No bridge listener');
    runtime.config.baseUrl = `http://localhost:${address.port}`;
    ehr = await buildMockEHR({ bridgeBaseUrl: runtime.config.baseUrl, consoleUrl: runtime.config.consoleUrl, trustedJWKSUrl: `${runtime.config.baseUrl}/.well-known/jwks.json` });
    signing = await generateKeyPair('ES384');
    const publicKey = { ...await exportJWK(signing.publicKey), alg: 'ES384', kid: 'cds-test' };
    ehr.get('/test-cds-jwks', async () => ({ keys: [publicKey] }));
    ehr.post('/test-cds-handler', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${handlerCredential}`);
      receivedHook = request.body;
      return { cards: [{ summary: 'Synthetic application handler completed.', indicator: 'info', source: { label: 'Integration test' } }] };
    });
    await ehr.listen({ port: 0, host: '127.0.0.1' });
    const upstreamAddress = ehr.server.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('No EHR listener');
    ehrUrl = `http://127.0.0.1:${upstreamAddress.port}`;
    runtime.config.mockEhrUrl = ehrUrl;
    await seedDemo(runtime.bridge);
  });
  afterAll(async () => { vi.restoreAllMocks(); if (ehr) await ehr.close(); if (runtime) await runtime.app.close(); });

  async function pendingLaunch(installationId = 'inst_northstar', mode: 'gateway' | 'direct' | 'handoff' = 'gateway', patient = 'patient-a', launchTicket?: string) {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const start = await runtime.app.inject({ method: 'POST', url: '/api/launches', payload: { installationId, redirectUri: `${runtime.config.consoleUrl}/reference-app`, codeChallenge: digest(verifier), state, mode, ...(launchTicket ? { launchTicket } : {}) } });
    expect(start.statusCode).toBe(200);
    const launch = await runtime.app.inject({ url: new URL(start.json().launchUrl).pathname });
    expect(launch.statusCode).toBe(302);
    const cookie = launch.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const authorize = new URL(launch.headers.location!);
    const consent = await ehr.inject({ url: authorize.pathname + authorize.search });
    expect(consent.statusCode).toBe(200);
    const transaction = /name="transaction" value="([^"]+)"/.exec(consent.body)?.[1];
    expect(transaction).toBeTruthy();
    const decision = await ehr.inject({ method: 'POST', url: authorize.pathname.replace(/authorize$/, 'decision'), headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ transaction: transaction!, decision: 'allow', patient }).toString() });
    const upstreamCallback = new URL(decision.headers.location!);
    const callback = await runtime.app.inject({ url: upstreamCallback.pathname + upstreamCallback.search, headers: { cookie } });
    expect(callback.statusCode).toBe(302);
    const appCallback = new URL(callback.headers.location!);
    expect(appCallback.searchParams.get('error')).toBeNull();
    expect(appCallback.searchParams.get('state')).toBe(state);
    return { code: appCallback.searchParams.get('code')!, codeVerifier: verifier, applicationId: 'app_clinical', redirectUri: `${runtime.config.consoleUrl}/reference-app` };
  }
  async function activate(installationId = 'inst_northstar', mode: 'gateway' | 'direct' | 'handoff' = 'gateway', patient = 'patient-a', ticket?: string) {
    const redemption = await pendingLaunch(installationId, mode, patient, ticket);
    const response = await runtime.app.inject({ method: 'POST', url: '/api/activations/redeem', payload: redemption });
    expect(response.statusCode).toBe(200);
    return { ...response.json<ActivationSession>(), redemption };
  }
  const headers = (session: ActivationSession) => ({ authorization: `Bearer ${session.sessionToken}` });

  it('completes standalone authorization, validates OIDC, and serves FHIR to a plain HTTP client', async () => {
    const session = await activate();
    expect(session.activation.context.patient?.reference).toBe('Patient/patient-a');
    expect(session.activation.principal?.subject).toBe('synthetic-clinician-northstar');
    const response = await runtime.app.inject({ url: `/fhir/${session.activation.id}/Patient/patient-a`, headers: headers(session) });
    expect(response.statusCode).toBe(200);
    expect(response.json().resourceType).toBe('Patient');
    expect(response.headers.etag).toBe('W/"1"');
    const metadata = await runtime.app.inject({ url: `/fhir/${session.activation.id}/metadata`, headers: headers(session) });
    expect(metadata.json().implementation.url).toBe(session.activation.gateway.baseUrl);
    expect(metadata.json().rest[0].resource.map((resource: { type: string }) => resource.type)).toEqual(['Patient', 'Observation']);
    const xml = await runtime.app.inject({ url: `/fhir/${session.activation.id}/Patient/patient-a`, headers: { ...headers(session), accept: 'application/fhir+xml' } });
    expect(xml.statusCode).toBe(406);
    const unsupportedWrite = await runtime.app.inject({ method: 'POST', url: `/fhir/${session.activation.id}/Patient`, headers: headers(session), payload: {} });
    expect(unsupportedWrite.statusCode).toBe(404);
  });

  it('rejects callback substitution, invalid downstream PKCE, and handoff replay', async () => {
    const badCallback = await runtime.app.inject({ method: 'POST', url: '/api/launches', payload: { installationId: 'inst_northstar', redirectUri: 'https://attacker.example/callback', codeChallenge: digest('a'.repeat(43)), state: 'b'.repeat(32) } });
    expect(badCallback.statusCode).toBe(400);
    const redemption = await pendingLaunch();
    const invalid = await runtime.app.inject({ method: 'POST', url: '/api/activations/redeem', payload: { ...redemption, codeVerifier: 'x'.repeat(43) } });
    expect(invalid.statusCode).toBe(401);
    const valid = await runtime.app.inject({ method: 'POST', url: '/api/activations/redeem', payload: redemption });
    expect(valid.statusCode).toBe(200);
    const replay = await runtime.app.inject({ method: 'POST', url: '/api/activations/redeem', payload: redemption });
    expect(replay.statusCode).toBe(400);
  });

  it('isolates identical resource IDs across tenants and different patient tabs', async () => {
    const first = await activate('inst_northstar', 'gateway', 'patient-a');
    const otherPatient = await activate('inst_northstar', 'gateway', 'patient-b');
    const otherTenant = await activate('inst_harbor');
    const wrongSession = await runtime.app.inject({ url: `/fhir/${first.activation.id}/Patient/patient-a`, headers: headers(otherPatient) });
    expect(wrongSession.statusCode).toBe(401);
    const wrongPatient = await runtime.app.inject({ url: `/fhir/${first.activation.id}/Patient/patient-b`, headers: headers(first) });
    expect(wrongPatient.statusCode).toBe(403);
    const harbor = await runtime.app.inject({ url: `/fhir/${otherTenant.activation.id}/Patient/patient-a`, headers: headers(otherTenant) });
    expect(harbor.json().managingOrganization.reference).toBe('Organization/harbor');
    expect(otherPatient.activation.context.patient?.reference).toBe('Patient/patient-b');
  });

  it('wraps upstream pagination in activation-bound continuation URLs', async () => {
    const session = await activate();
    const first = await runtime.app.inject({ url: `/fhir/${session.activation.id}/Observation?_count=1`, headers: headers(session) });
    expect(first.statusCode).toBe(200);
    const next = first.json().link.find((link: { relation: string }) => link.relation === 'next').url;
    expect(next).toContain(`/fhir/${session.activation.id}/_page/`);
    expect(first.headers.etag).toBeUndefined();
    const second = await runtime.app.inject({ url: new URL(next).pathname, headers: headers(session) });
    expect(second.statusCode).toBe(200);
    expect(second.json().entry[0].resource.id).not.toBe(first.json().entry[0].resource.id);
    const stranger = await activate();
    const crossActivation = await runtime.app.inject({ url: new URL(next).pathname.replace(session.activation.id, stranger.activation.id), headers: headers(stranger) });
    expect(crossActivation.statusCode).toBe(400);
  });

  it('supports direct upstream access and returns the unchanged original access token without leaking refresh ownership', async () => {
    const session = await activate('inst_lakeside', 'direct');
    const response = await runtime.app.inject({ url: `/api/activations/${session.activation.id}/credentials`, headers: headers(session) });
    const credential = response.json<CredentialResponse>();
    const original = (await runtime.app.inject({ url: `/api/activations/${session.activation.id}/credentials/original`, headers: headers(session) })).json<OriginalCredentialResponse>();
    expect(credential.accessToken).toBe(original.tokenResponse.access_token);
    expect(original.refreshTokenWithheld).toBe(true);
    expect(original.tokenResponse.refresh_token).toBeUndefined();
    const direct = await fetch(`${credential.baseUrl}/Patient/patient-a`, { headers: { authorization: `${credential.tokenType} ${credential.accessToken}` } });
    expect(direct.status).toBe(200);
    expect((await direct.json() as { managingOrganization: { reference: string } }).managingOrganization.reference).toBe('Organization/lakeside');
  });

  it('enforces current token-export policy for already active direct sessions', async () => {
    const session = await activate('inst_harbor', 'direct');
    const installation = await runtime.bridge.repo.get<Installation>('installations', 'inst_harbor');
    await runtime.bridge.repo.put('installations', { ...installation!, allowTokenExport: false });
    expect((await runtime.app.inject({ url: `/api/activations/${session.activation.id}/credentials`, headers: headers(session) })).statusCode).toBe(403);
    expect((await runtime.app.inject({ url: `/api/activations/${session.activation.id}/credentials/original`, headers: headers(session) })).statusCode).toBe(403);
    expect((await runtime.app.inject({ url: `/api/activations/${session.activation.id}`, headers: headers(session) })).json().tokenExportAllowed).toBe(false);
    await runtime.bridge.repo.put('installations', installation!);
  });

  it('serializes rotating refresh tokens and preserves the original response', async () => {
    const session = await activate();
    const before = await runtime.bridge.vault.get<GrantSecret>(`grant:${session.activation.id}`);
    const grant = await runtime.bridge.repo.get<Grant>('grants', session.activation.id);
    await runtime.bridge.repo.put('grants', { ...grant!, expiresAt: new Date(0).toISOString() });
    const results = await Promise.all(Array.from({ length: 5 }, () => runtime.bridge.currentToken(session.activation.id)));
    expect(new Set(results.map(r => r.token.access_token)).size).toBe(1);
    const after = await runtime.bridge.vault.get<GrantSecret>(`grant:${session.activation.id}`);
    expect(after!.current.refresh_token).not.toBe(before!.current.refresh_token);
    expect(after!.original.access_token).toBe(before!.original.access_token);
  });

  it('hands off refresh ownership once and allows the app to renew directly', async () => {
    const session = await activate('inst_northstar', 'handoff');
    const response = await runtime.app.inject({ method: 'POST', url: `/api/activations/${session.activation.id}/credentials/handoff`, headers: headers(session) });
    expect(response.statusCode).toBe(200);
    const credentials = response.json<CredentialResponse>();
    expect(credentials.refreshOwner).toBe('application');
    const upstream = await fetch(credentials.tokenEndpoint!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken!, client_id: credentials.clientId! }) });
    expect(upstream.status).toBe(200);
    const gateway = await runtime.app.inject({ url: `/fhir/${session.activation.id}/Patient/patient-a`, headers: headers(session) });
    expect(gateway.statusCode).toBe(409);
    expect((await runtime.app.inject({ method: 'POST', url: `/api/activations/${session.activation.id}/credentials/handoff`, headers: headers(session) })).statusCode).toBe(409);
  });

  it('processes an EHR launch through application bootstrap and preserves its selected patient', async () => {
    const ehrLaunch = await ehr.inject({ url: '/epic/northstar/ehr-launch?patient=patient-b' });
    const bridgeLaunch = new URL(ehrLaunch.headers.location!);
    const bootstrap = await runtime.app.inject({ url: bridgeLaunch.pathname + bridgeLaunch.search });
    const ticket = new URL(bootstrap.headers.location!).searchParams.get('smart_flint_launch')!;
    expect((await runtime.app.inject({ url: `/api/launches/bootstrap/${ticket}` })).json().installationId).toBe('inst_northstar');
    const session = await activate('inst_northstar', 'gateway', 'patient-a', ticket);
    expect(session.activation.context.patient?.reference).toBe('Patient/patient-b');
  });

  it('acquires a SMART Backend Services grant with a pinned ES384 assertion and an application API key', async () => {
    const denied = await runtime.app.inject({ method: 'POST', url: '/api/service-activations', payload: { installationId: 'inst_service' } });
    expect(denied.statusCode).toBe(401);
    const response = await runtime.app.inject({ method: 'POST', url: '/api/service-activations', headers: { authorization: 'Bearer demo-service-key' }, payload: { installationId: 'inst_service' } });
    expect(response.statusCode).toBe(200);
    const session = response.json<ActivationSession>();
    expect(session.activation.kind).toBe('service');
    expect(session.activation.context.patient).toBeUndefined();
    const patients = await runtime.app.inject({ url: `/fhir/${session.activation.id}/Patient`, headers: headers(session) });
    expect(patients.statusCode).toBe(200);
    expect(patients.json().total).toBe(4);
  });

  it('authenticates CDS callers, forwards request-bound context, and rejects JWT replay', async () => {
    const admin = { authorization: `Bearer ${runtime.config.adminToken}` };
    const created = await runtime.app.inject({ method: 'POST', url: '/api/admin/cds-services', headers: admin, payload: { installationId: 'inst_northstar', hook: 'patient-view', title: 'Synthetic test', description: 'Integration fixture', handlerUrl: `${ehrUrl}/test-cds-handler`, callerIssuer: 'https://synthetic-caller.example', callerJwksUrl: `${ehrUrl}/test-cds-jwks` } });
    expect(created.statusCode).toBe(201);
    const service = created.json().service;
    handlerCredential = created.json().handlerSecret;
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'ES384', kid: 'cds-test' }).setIssuer('https://synthetic-caller.example').setAudience(`${runtime.config.baseUrl}/cds-services/${service.id}`).setIssuedAt().setExpirationTime('4m').setJti(randomUUID()).sign(signing.privateKey);
    const payload = { hook: 'patient-view', hookInstance: randomUUID(), context: { patientId: 'synthetic-patient' }, prefetch: { patient: { resourceType: 'Patient', id: 'synthetic-patient' } } };
    const response = await runtime.app.inject({ method: 'POST', url: `/cds-services/${service.id}`, headers: { authorization: `Bearer ${jwt}` }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json().cards[0].source.label).toBe('Integration test');
    expect(receivedHook).toEqual(payload);
    expect((await runtime.app.inject({ method: 'POST', url: `/cds-services/${service.id}`, headers: { authorization: `Bearer ${jwt}` }, payload })).statusCode).toBe(401);
    const audits = JSON.stringify(await runtime.bridge.repo.list('events'));
    expect(audits).not.toContain('synthetic-patient');
  });

  it('closes activations without allowing an in-flight refresh to recreate access', async () => {
    const session = await activate();
    const grant = await runtime.bridge.repo.get<Grant>('grants', session.activation.id);
    await runtime.bridge.repo.put('grants', { ...grant!, expiresAt: new Date(0).toISOString() });
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const original = runtime.bridge.tokenRequest.bind(runtime.bridge);
    const spy = vi.spyOn(runtime.bridge, 'tokenRequest').mockImplementation(async (...args) => { started(); await resume; return original(...args); });
    const renewing = runtime.bridge.currentToken(session.activation.id);
    await waiting;
    const closing = runtime.bridge.closeActivation(session.activation.id);
    release(); await renewing; await closing; spy.mockRestore();
    expect((await runtime.bridge.activation(session.activation.id)).status).toBe('closed');
    expect(await runtime.bridge.vault.get(`grant:${session.activation.id}`)).toBeUndefined();
    expect((await runtime.app.inject({ url: `/fhir/${session.activation.id}/Patient/patient-a`, headers: headers(session) })).statusCode).toBe(401);
  });
});
