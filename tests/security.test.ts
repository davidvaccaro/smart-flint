import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Response } from 'undici';
import { buildApp } from '../apps/server/src/app.js';
import { projectRoot } from '../apps/server/src/config.js';
import { publicJWK, scopeCovers, scopesCover } from '../apps/server/src/bridge.js';
import { scopeAllowsRead } from '../apps/server/src/access.js';
import { privateAddress, SafeHttp } from '../apps/server/src/network.js';
import { digest, pkceChallenge } from '../packages/storage/src/index.js';

const owned: Awaited<ReturnType<typeof buildApp>>[] = [];
async function setup(serveConsole = false) {
  const instance = await buildApp({
    config: {
      demo: true, host: '127.0.0.1', baseUrl: 'http://localhost:3001', consoleUrl: 'http://localhost:3010',
      encryptionKey: Buffer.alloc(32).toString('base64'), adminToken: 'test-admin-credential-that-is-long-enough', sqlitePath: ':memory:',
      mockEhrUrl: 'http://localhost:4010', allowPrivateNetworks: false, databaseUrl: undefined,
    }, serveConsole,
  });
  await instance.app.ready(); owned.push(instance); return instance;
}
afterEach(async () => { for (const instance of owned.splice(0)) await instance.app.close(); });

describe('scope authority', () => {
  it('preserves action sets, audience and granular restrictions', () => {
    expect(scopeCovers('patient/Observation.read', 'patient/Observation.rs')).toBe(true);
    expect(scopeCovers('patient/Observation.r', 'patient/Observation.rs')).toBe(false);
    expect(scopeCovers('patient/*.rs', 'patient/Patient.r')).toBe(true);
    expect(scopeCovers('user/*.rs', 'patient/Patient.rs')).toBe(false);
    expect(scopeCovers('system/*.cruds', 'user/Patient.r')).toBe(false);
    expect(scopeCovers('patient/Observation.rs?category=vital-signs', 'patient/Observation.rs')).toBe(false);
    expect(scopeCovers('patient/Observation.rs?category=vital-signs', 'patient/Observation.rs?category=laboratory')).toBe(false);
    expect(scopeCovers('patient/Observation.rs', 'patient/Observation.rs?category=vital-signs')).toBe(true);
    expect(scopeCovers('patient/Observation.write', 'patient/Observation.r')).toBe(false);
    expect(scopeCovers('patient/*.*', 'patient/Patient.cruds')).toBe(true);
  });

  it('combines complementary permissions without joining different filters or audiences', () => {
    expect(scopesCover(['patient/Observation.r', 'patient/Observation.s'], 'patient/Observation.rs')).toBe(true);
    expect(scopesCover(['patient/Observation.r', 'user/Observation.s'], 'patient/Observation.rs')).toBe(false);
    expect(scopesCover(['patient/Observation.r?category=vital-signs', 'patient/Observation.s?category=laboratory'], 'patient/Observation.rs?category=vital-signs')).toBe(false);
    expect(scopesCover(['openid', 'fhirUser'], 'offline_access')).toBe(false);
    expect(scopesCover(['openid', 'fhirUser'], 'openid')).toBe(true);
  });

  it('checks resource read and search permissions independently', () => {
    expect(scopeAllowsRead('patient/Patient.r', 'Patient', 'r')).toBe(true);
    expect(scopeAllowsRead('patient/Patient.r', 'Patient', 's')).toBe(false);
    expect(scopeAllowsRead('patient/Patient.s', 'Patient', 'r')).toBe(false);
    expect(scopeAllowsRead('patient/Observation.rs', 'Patient', 'r')).toBe(false);
    expect(scopeAllowsRead('system/*.read', 'Observation', 's')).toBe(true);
    expect(scopeAllowsRead('patient/Patient.cud', 'Patient', 'r')).toBe(false);
    expect(scopeAllowsRead('launch/patient', 'Patient', 'r')).toBe(false);
  });
});

describe('outbound endpoint boundaries', () => {
  it('recognizes private, loopback, link-local and mapped IPv6 private addresses', () => {
    const addresses = [
      '127.0.0.1', '0.0.0.0', '10.20.30.40', '172.16.0.1', '172.31.255.254', '192.168.1.2',
      '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '::', '::1', 'fc00::1',
      'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
    ];
    for (const address of addresses) expect(privateAddress(address), address).toBe(true);
    for (const address of ['8.8.8.8', '1.1.1.1', '172.15.1.2', '172.32.1.2', '2606:4700:4700::1111', '::ffff:808:808']) expect(privateAddress(address), address).toBe(false);
  });

  it('rejects private literal endpoints before network access, including alternate numeric forms', async () => {
    const { config } = await setup();
    const http = new SafeHttp({ ...config, demo: false, allowPrivateNetworks: false });
    for (const target of ['https://127.0.0.1/fhir', 'https://2130706433/fhir', 'https://0x7f000001/fhir', 'https://[::1]/fhir', 'https://[::ffff:7f00:1]/fhir', 'https://169.254.169.254/latest/meta-data']) {
      expect(() => http.validate(target, [new URL(target).origin]), target).toThrow();
    }
    expect(() => http.validate('https://ehr.example/fhir', ['https://ehr.example'])).not.toThrow();
    const privateEnabled = new SafeHttp({ ...config, demo: false, allowPrivateNetworks: true });
    expect(() => privateEnabled.validate('https://10.1.2.3/fhir', ['https://10.1.2.3'])).not.toThrow();
    expect(() => privateEnabled.validate('https://10.1.2.3/fhir', ['https://different.example'])).toThrow();
    await http.close(); await privateEnabled.close();
  });

  it('restricts a FHIR grant to the approved origin and base path', async () => {
    const { bridge } = await setup();
    const origins = ['https://ehr.example'];
    const base = 'https://ehr.example/tenant-a/r4';
    expect(() => bridge.http.validate(`${base}/Patient/123`, origins, base)).not.toThrow();
    for (const target of ['https://evil.example/Patient/123', 'https://ehr.example/tenant-b/r4/Patient/123', 'https://ehr.example/tenant-a/r40/Patient/123', 'https://ehr.example/tenant-a/r4/../Patient/123', 'https://user:secret@ehr.example/tenant-a/r4/Patient/123']) expect(() => bridge.http.validate(target, origins, base), target).toThrow();
  });
});

describe('application transaction bindings', () => {
  it('accepts registered HTTPS browser origins while excluding native null origins from CORS', async () => {
    const { app, config } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/admin/applications', headers: { authorization: `Bearer ${config.adminToken}` }, payload: { name: 'Native and web', callbackUrls: ['com.smartflint.test:/oauth/callback', 'https://app.example/callback'] } });
    expect(created.statusCode).toBe(201);
    const approved = await app.inject({ url: '/api/admin/session', headers: { origin: 'https://app.example' } });
    expect(approved.headers['access-control-allow-origin']).toBe('https://app.example');
    const opaque = await app.inject({ url: '/api/admin/session', headers: { origin: 'null' } });
    expect(opaque.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requires the exact registered callback and configured EHR issuer', async () => {
    const { app, bridge } = await setup();
    const body = { installationId: 'inst_northstar', redirectUri: 'https://evil.example/callback', codeChallenge: pkceChallenge('v'.repeat(43)), state: 's'.repeat(32) };
    const unapproved = await app.inject({ method: 'POST', url: '/api/launches', payload: body });
    expect(unapproved.statusCode).toBe(400); expect(unapproved.json().code).toBe('callback_not_registered');
    const changedQuery = await app.inject({ method: 'POST', url: '/api/launches', payload: { ...body, redirectUri: 'http://localhost:3010/reference-app?returnTo=elsewhere' } });
    expect(changedQuery.statusCode).toBe(400);
    const issuer = await app.inject({ url: '/launch/inst_northstar?iss=https%3A%2F%2Fevil.example%2Ffhir&launch=opaque-handle' });
    expect(issuer.statusCode).toBe(400); expect(issuer.json().code).toBe('issuer_mismatch');
    const rejections = (await bridge.repo.list<{ action: string; detail: string }>('events')).filter(event => event.action === 'launch.rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.detail).toBe('EHR launch rejected (issuer_mismatch).');
    expect(JSON.stringify(rejections)).not.toContain('opaque-handle');
    expect(JSON.stringify(rejections)).not.toContain('evil.example');
    const valid = await app.inject({ method: 'POST', url: '/api/launches', payload: { ...body, redirectUri: 'http://localhost:3010/reference-app' } });
    expect(valid.statusCode).toBe(200); expect(valid.json().applicationId).toBe('app_clinical');
  });

  it('forwards an opaque EHR launch handle unchanged and identifies launch-token redemption failures', async () => {
    const { app, bridge, config } = await setup();
    vi.spyOn(bridge, 'discover').mockResolvedValue({ authorization_endpoint: 'http://localhost:4010/epic/northstar/oauth/authorize', token_endpoint: 'http://localhost:4010/epic/northstar/oauth/token' });
    const tokenRequest = vi.spyOn(bridge, 'tokenRequest');
    const opaque = `synthetic.header.${'opaque_-'.repeat(100)}.signature+/=%&`;
    const received = new URL('/launch/inst_northstar', config.baseUrl);
    received.searchParams.set('iss', 'http://localhost:4010/epic/northstar/r4');
    received.searchParams.set('launch', opaque);
    const bootstrap = await app.inject({ url: received.pathname + received.search });
    expect(bootstrap.statusCode).toBe(302);
    const callback = new URL(bootstrap.headers.location!);
    expect(callback.searchParams.has('launch')).toBe(false);
    const state = 's'.repeat(32);
    const started = await app.inject({ method: 'POST', url: '/api/launches', payload: {
      installationId: 'inst_northstar', redirectUri: `${config.consoleUrl}/reference-app`,
      codeChallenge: pkceChallenge('v'.repeat(43)), state, launchTicket: callback.searchParams.get('smart_flint_launch'),
    } });
    expect(started.statusCode).toBe(200);
    const authorizing = await app.inject({ url: new URL(started.json().launchUrl).pathname });
    expect(authorizing.statusCode).toBe(302);
    const authorize = new URL(authorizing.headers.location!);
    expect(authorize.searchParams.getAll('launch')).toEqual([opaque]);
    expect(authorize.searchParams.get('client_id')).toBe('smart-flint-demo');
    expect(authorize.searchParams.get('aud')).toBe('http://localhost:4010/epic/northstar/r4');
    expect(authorize.searchParams.get('scope')?.split(' ')).toContain('launch');
    const upstreamCallback = new URL('/oauth/callback/conn_northstar', config.baseUrl);
    upstreamCallback.searchParams.set('state', authorize.searchParams.get('state')!);
    upstreamCallback.searchParams.set('error', 'invalid_grant');
    upstreamCallback.searchParams.set('error_description', 'private-upstream-description-canary');
    const denied = await app.inject({ url: upstreamCallback.pathname + upstreamCallback.search, headers: { cookie: authorizing.cookies.map(value => `${value.name}=${value.value}`).join('; ') } });
    expect(denied.statusCode).toBe(302);
    const destination = new URL(denied.headers.location!);
    expect(destination.searchParams.get('error')).toBe('invalid_grant');
    expect(destination.searchParams.get('state')).toBe(state);
    expect(destination.searchParams.has('error_description')).toBe(false);
    const events = await bridge.repo.list<{ action: string; detail: string }>('events');
    expect(events.find(event => event.action === 'launch.denied')?.detail).toBe('The EHR could not redeem the launch token for an authorization code (invalid_grant).');
    expect(JSON.stringify(events)).not.toContain(opaque);
    expect(JSON.stringify(events)).not.toContain('private-upstream-description-canary');
    expect(tokenRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['access_denied', 'access_denied'], ['invalid_request', 'invalid_request'],
    ['invalid_launch_token', 'invalid_launch_token'],
    ['invalid_grant', 'invalid_grant'],
    ['private-upstream-error-canary', 'unrecognized_error'],
  ])('records a safe authorization diagnostic for %s without exposing upstream details', async (upstreamError, loggedCode) => {
    const { app, bridge, config } = await setup();
    vi.spyOn(bridge, 'discover').mockResolvedValue({ authorization_endpoint: 'http://localhost:4010/epic/northstar/oauth/authorize', token_endpoint: 'http://localhost:4010/epic/northstar/oauth/token' });
    const tokenRequest = vi.spyOn(bridge, 'tokenRequest');
    const state = 's'.repeat(32);
    const start = await app.inject({ method: 'POST', url: '/api/launches', payload: { installationId: 'inst_northstar', redirectUri: `${config.consoleUrl}/reference-app`, codeChallenge: pkceChallenge('v'.repeat(43)), state } });
    expect(start.statusCode).toBe(200);
    const authorizing = await app.inject({ url: new URL(start.json().launchUrl).pathname });
    expect(authorizing.statusCode).toBe(302);
    const authorize = new URL(authorizing.headers.location!);
    const callback = new URL('/oauth/callback/conn_northstar', config.baseUrl);
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    callback.searchParams.set('error', upstreamError);
    callback.searchParams.set('error_description', 'private-description-canary');
    callback.searchParams.set('error_uri', 'https://sensitive.example/private-error-canary');
    const cookie = authorizing.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const denied = await app.inject({ url: callback.pathname + callback.search, headers: { cookie } });
    expect(denied.statusCode).toBe(302);
    const destination = new URL(denied.headers.location!);
    expect(destination.origin).toBe(config.consoleUrl);
    expect(destination.searchParams.get('error')).toBe(['invalid_launch_token', 'invalid_grant'].includes(upstreamError) ? upstreamError : 'authorization_denied');
    expect(destination.searchParams.get('state')).toBe(state);
    expect(destination.searchParams.has('error_description')).toBe(false);
    const events = await bridge.repo.list<{ action: string; detail: string }>('events');
    expect(events.find(event => event.action === 'launch.denied')?.detail).toBe(`The EHR authorization did not complete (${loggedCode}).`);
    expect(JSON.stringify(events)).not.toMatch(/private-upstream-error-canary|private-description-canary|private-error-canary/);
    expect(await bridge.repo.list('transactions')).toEqual([]);
    expect(await bridge.repo.list('handoffs')).toEqual([]);
    expect(tokenRequest).not.toHaveBeenCalled();
  });

  it('binds activation redemption to the application, callback and verifier and consumes the code once', async () => {
    const { app, bridge } = await setup();
    const activation = await bridge.establish('inst_northstar', { access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600, scope: 'patient/Patient.rs patient/Observation.rs', patient: 'synthetic-patient' }, 'http://localhost:4010/epic/northstar/oauth/token', 'gateway', 'interactive');
    const code = 'synthetic-one-use-code', verifier = 'v'.repeat(43), redirectUri = 'http://localhost:3010/reference-app';
    await bridge.repo.put('handoffs', { id: digest(code), activationId: activation.id, applicationId: 'app_clinical', redirectUri, challenge: pkceChallenge(verifier), expiresAt: new Date(Date.now() + 60000).toISOString() });
    const payload = { code, codeVerifier: verifier, applicationId: 'app_clinical', redirectUri };
    for (const invalid of [{ ...payload, applicationId: 'another-app' }, { ...payload, redirectUri: 'https://evil.example/callback' }, { ...payload, codeVerifier: 'x'.repeat(43) }]) {
      const result = await app.inject({ method: 'POST', url: '/api/activations/redeem', payload: invalid });
      expect(result.statusCode).toBe(401);
    }
    const redeemed = await app.inject({ method: 'POST', url: '/api/activations/redeem', payload });
    expect(redeemed.statusCode).toBe(200); expect(redeemed.json().activation.id).toBe(activation.id);
    const replay = await app.inject({ method: 'POST', url: '/api/activations/redeem', payload });
    expect(replay.statusCode).toBe(400);
    const wrongActivation = await app.inject({ url: '/api/activations/act_another_patient', headers: { authorization: `Bearer ${redeemed.json().sessionToken}` } });
    expect(wrongActivation.statusCode).toBe(401);
  });

  it('requires an application API key rather than the administrator credential for backend activation', async () => {
    const { app, config } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/service-activations', headers: { authorization: `Bearer ${config.adminToken}` }, payload: { installationId: 'inst_service' } });
    expect(response.statusCode).toBe(401); expect(response.json().code).toBe('application_authentication_required');
  });

  it('rejects an invalid CDS caller assertion as authentication failure', async () => {
    const { app, bridge } = await setup();
    await bridge.repo.put('cds_services', {
      id: 'cds_trusted_test', installationId: 'inst_northstar', hook: 'patient-view', title: 'Test service',
      description: 'Caller validation fixture', enabled: true, callerIssuer: 'https://ehr.example',
      callerJwksUrl: 'https://ehr.example/jwks', allowedOrigins: ['https://ehr.example'], createdAt: new Date().toISOString(),
    });
    vi.spyOn(bridge.http, 'request').mockResolvedValue(new Response(JSON.stringify({ keys: [publicJWK(await bridge.signingKey())] }), { status: 200 }));
    const response = await app.inject({ method: 'POST', url: '/cds-services/cds_trusted_test', headers: { authorization: 'Bearer malformed-assertion' }, payload: { hook: 'patient-view', hookInstance: randomUUID(), context: { patientId: 'synthetic-patient' } } });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('malformed-assertion');
  });

  it('withholds refresh credentials until explicit ownership handoff and prevents bridge refresh afterward', async () => {
    const { app, bridge } = await setup();
    const activation = await bridge.establish('inst_northstar', {
      access_token: 'original-access-token', token_type: 'Bearer', refresh_token: 'original-refresh-token',
      expires_in: 3600, scope: 'patient/Patient.rs patient/Observation.rs', patient: 'synthetic-patient',
    }, 'http://localhost:4010/epic/northstar/oauth/token', 'handoff', 'interactive');
    const sessionToken = `session_${'a'.repeat(43)}`;
    await bridge.repo.put('sessions', { id: digest(sessionToken), activationId: activation.id, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const headers = { authorization: `Bearer ${sessionToken}` };
    const original = await app.inject({ url: `/api/activations/${activation.id}/credentials/original`, headers });
    expect(original.statusCode).toBe(200);
    expect(original.json()).toMatchObject({ refreshOwner: 'bridge', refreshTokenWithheld: true, tokenResponse: { access_token: 'original-access-token' } });
    expect(original.json().tokenResponse.refresh_token).toBeUndefined();
    const transferred = await app.inject({ method: 'POST', url: `/api/activations/${activation.id}/credentials/handoff`, headers });
    expect(transferred.statusCode).toBe(200); expect(transferred.json()).toMatchObject({ refreshOwner: 'application', refreshToken: 'original-refresh-token' });
    const managed = await app.inject({ url: `/api/activations/${activation.id}/credentials`, headers });
    expect(managed.statusCode).toBe(409); expect(managed.json().code).toBe('grant_handed_off');
    const replay = await app.inject({ method: 'POST', url: `/api/activations/${activation.id}/credentials/handoff`, headers });
    expect(replay.statusCode).toBe(409);
  });
});

it('serves a secret-free health response and advertises the original-credential envelope', async () => {
  const { app, config } = await setup();
  const health = await app.inject({ url: '/health' });
  expect(health.statusCode).toBe(200); expect(health.json()).toMatchObject({ status: 'ok', service: 'SMART Flint', storage: 'sqlite', demo: true });
  expect(health.body).not.toContain(config.adminToken); expect(health.body).not.toContain(config.encryptionKey);
  const schema = (await app.inject({ url: '/api/openapi.json' })).json();
  expect(schema.components.schemas.OriginalCredentialResponse.required).toContain('refreshTokenWithheld');
});

it.skipIf(!existsSync(join(projectRoot, 'apps/console/dist/index.html')))('serves the built console, SPA routes and referenced assets alongside the API', async () => {
  const { app } = await setup(true);
  for (const url of ['/', '/connections', '/applications', '/installations', '/reference-app']) {
    const response = await app.inject({ url });
    expect(response.statusCode, url).toBe(200); expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('id="root"');
  }
  const index = await app.inject({ url: '/' });
  const script = /src="(\/assets\/[^\"]+\.js)"/.exec(index.body)?.[1];
  expect(script).toBeTruthy();
  const asset = await app.inject({ url: script! });
  expect(asset.statusCode).toBe(200); expect(asset.headers['content-type']).toMatch(/javascript/);
  expect((await app.inject({ url: '/api/openapi.json' })).headers['content-type']).toContain('application/json');
});
