import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createHealthFixture } from '@smart-flint/health-assessment';

type Tenant = { vendor: string; id: string; name: string; accent: string };
export const syntheticTenants: Tenant[] = [
  { vendor: 'epic', id: 'northstar', name: 'Northstar Health', accent: '#19766a' },
  { vendor: 'epic', id: 'harbor', name: 'Harbor Medical', accent: '#3969ab' },
  { vendor: 'oracle', id: 'lakeside', name: 'Lakeside Care', accent: '#956b35' },
  { vendor: 'meditech', id: 'cedar', name: 'Cedar Health', accent: '#68529b' },
];
interface Authorization {
  tenant: string; clientId: string; redirectUri: string; state: string; challenge: string;
  scope: string; nonce?: string; launchPatient?: string; expiresAt: number;
}
interface AuthorizationCode extends Authorization { patient: string }
interface AccessGrant { tenant: string; clientId: string; scope: string; patient?: string; expiresAt: number }
interface RefreshGrant extends AccessGrant { expiresAt: number }
const random = () => randomBytes(32).toString('base64url');
const scopes = new Set([
  'launch', 'launch/patient', 'launch/encounter', 'openid', 'fhirUser', 'profile', 'offline_access', 'online_access',
  ...['patient', 'user', 'system'].flatMap(prefix => ['Patient', 'Observation', 'Encounter', 'Practitioner', '*'].flatMap(resource => [`${prefix}/${resource}.rs`, `${prefix}/${resource}.read`, `${prefix}/${resource}.r`, `${prefix}/${resource}.s`])),
]);
const htmlEscape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface MockEHROptions {
  baseUrl?: string;
  bridgeBaseUrl?: string;
  consoleUrl?: string;
  trustedJWKSUrl?: string;
}

/** Synthetic protocol simulator. It does not establish compatibility with any vendor. */
export async function buildMockEHR(options: MockEHROptions = {}) {
  let baseUrl = (options.baseUrl ?? process.env.MOCK_EHR_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '');
  const bridgeBaseUrl = (options.bridgeBaseUrl ?? process.env.BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
  const consoleUrl = options.consoleUrl ?? process.env.CONSOLE_URL ?? 'http://127.0.0.1:3010';
  const patientSampleUrl = process.env.SAMPLE_PATIENT_URL ?? 'http://127.0.0.1:4100';
  const trustedJWKSUrl = options.trustedJWKSUrl ?? process.env.SMART_FLINT_JWKS_URL ?? `${bridgeBaseUrl}/.well-known/jwks.json`;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.addHook('onListen', async () => {
    if (!options.baseUrl && !process.env.MOCK_EHR_URL) {
      const address = app.server.address();
      if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });
  await app.register(formbody);
  await app.register(cors, { origin: [new URL(consoleUrl).origin, new URL(bridgeBaseUrl).origin, new URL(patientSampleUrl).origin], allowedHeaders: ['Authorization', 'Content-Type', 'Accept'], methods: ['GET', 'POST', 'OPTIONS'] });
  const signing = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(signing.publicKey), kid: 'synthetic-ehr-signing-key', alg: 'ES256', use: 'sig' };
  const bridgeKeys = createRemoteJWKSet(new URL(trustedJWKSUrl));
  const authorizations = new Map<string, Authorization>();
  const codes = new Map<string, AuthorizationCode>();
  const accessTokens = new Map<string, AccessGrant>();
  const refreshTokens = new Map<string, RefreshGrant>();
  const launchHandles = new Map<string, { tenant: string; patient: string; expiresAt: number }>();
  const usedAssertions = new Map<string, number>();

  function getTenant(request: FastifyRequest, reply: FastifyReply): Tenant | undefined {
    const params = request.params as { vendor: string; tenant: string };
    const tenant = syntheticTenants.find(t => t.vendor === params.vendor && t.id === params.tenant);
    if (!tenant) reply.code(404).send({ error: 'unknown_synthetic_tenant' });
    return tenant;
  }
  const key = (tenant: Tenant) => `${tenant.vendor}/${tenant.id}`;
  const fhirBase = (tenant: Tenant) => `${baseUrl}/${key(tenant)}/r4`;
  const oauthBase = (tenant: Tenant) => `${baseUrl}/${key(tenant)}/oauth`;
  function oauthError(reply: FastifyReply, error: string, description: string, status = 400) {
    return reply.code(status).header('Cache-Control', 'no-store').send({ error, error_description: description });
  }
  function cleanup() {
    const now = Date.now();
    for (const map of [authorizations, codes, accessTokens, refreshTokens, launchHandles]) {
      for (const [id, value] of map) if (value.expiresAt < now) map.delete(id);
    }
    for (const [id, expiry] of usedAssertions) if (expiry < now) usedAssertions.delete(id);
  }
  function permittedCallback(raw: string): boolean {
    try {
      const callback = new URL(raw);
      const bridge = new URL(bridgeBaseUrl);
      return callback.origin === bridge.origin && !callback.username && !callback.password && !callback.search && !callback.hash && /^\/oauth\/callback(?:\/[A-Za-z0-9_-]+)?$/.test(callback.pathname);
    } catch { return false; }
  }
  async function issueToken(reply: FastifyReply, tenant: Tenant, grant: Omit<AccessGrant, 'expiresAt'>, nonce?: string) {
    const accessToken = random();
    accessTokens.set(accessToken, { ...grant, expiresAt: Date.now() + 300_000 });
    const result: Record<string, unknown> = {
      access_token: accessToken, token_type: 'Bearer', expires_in: 300, scope: grant.scope,
      synthetic_environment: true,
    };
    if (grant.patient) {
      Object.assign(result, {
        patient: grant.patient,
        encounter: `encounter-${grant.patient.slice(-1)}`,
        need_patient_banner: true,
        fhirContext: [{ reference: `Organization/${tenant.id}`, role: 'launch-organization' }],
        tenant: tenant.id,
        intent: 'review-synthetic-chart',
      });
    }
    if (grant.scope.split(' ').includes('openid')) {
      const patientPrincipal = grant.clientId === 'smart-flint-health-patient' && !!grant.patient;
      result.id_token = await new SignJWT({
        fhirUser: patientPrincipal ? `${fhirBase(tenant)}/Patient/${grant.patient}` : `${fhirBase(tenant)}/Practitioner/clinician-1`,
        ...(nonce ? { nonce } : {}),
      }).setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
        .setIssuer(oauthBase(tenant)).setAudience(grant.clientId)
        .setSubject(patientPrincipal ? `synthetic-patient-${tenant.id}-${grant.patient}` : `synthetic-clinician-${tenant.id}`).setIssuedAt().setExpirationTime('5m').sign(signing.privateKey);
    }
    if (grant.scope.split(' ').some(s => s === 'offline_access' || s === 'online_access')) {
      const refreshToken = random();
      refreshTokens.set(refreshToken, { ...grant, expiresAt: Date.now() + 86_400_000 });
      result.refresh_token = refreshToken;
    }
    return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(result);
  }
  async function authenticateClient(request: FastifyRequest, reply: FastifyReply, tenant: Tenant, body: Record<string, string>): Promise<string | undefined> {
    let clientId = body.client_id;
    let secret = body.client_secret;
    const basic = request.headers.authorization;
    if (basic?.startsWith('Basic ')) {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) { oauthError(reply, 'invalid_client', 'Invalid HTTP Basic client credentials.', 401); return; }
      clientId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    if (body.client_assertion) {
      if (body.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
        oauthError(reply, 'invalid_client', 'A JWT bearer client assertion type is required.', 401); return;
      }
      try {
        const verified = await jwtVerify(body.client_assertion, bridgeKeys, {
          issuer: 'smart-flint-service', subject: 'smart-flint-service', audience: `${oauthBase(tenant)}/token`,
          algorithms: ['ES384', 'RS384', 'ES256', 'RS256'], maxTokenAge: '5m',
        });
        const now = Math.floor(Date.now() / 1000);
        if (!verified.payload.jti || !verified.payload.exp || verified.payload.exp > now + 300 || usedAssertions.has(verified.payload.jti)) {
          throw new Error('Invalid or replayed assertion');
        }
        usedAssertions.set(verified.payload.jti, verified.payload.exp * 1000);
        return 'smart-flint-service';
      } catch { oauthError(reply, 'invalid_client', 'The registered client assertion could not be verified.', 401); return; }
    }
    if (['smart-flint-demo', 'smart-flint-health-patient'].includes(clientId ?? '') && !secret) return clientId;
    if (clientId === 'smart-flint-service' && secret) {
      const expected = Buffer.from('demo-backend-secret');
      const received = Buffer.from(secret);
      if (expected.length === received.length && timingSafeEqual(expected, received)) return clientId;
    }
    oauthError(reply, 'invalid_client', 'Use a registered synthetic application.', 401);
  }

  app.get('/health', async () => ({ status: 'ok', synthetic: true }));
  app.get('/', async (_request, reply) => reply.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SMART Flint synthetic EHR</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:16px system-ui;max-width:760px;margin:80px auto;padding:24px;color:#183b35"><h1>SMART Flint synthetic EHR</h1><p>Local OAuth and FHIR protocol fixtures. All records are synthetic. Vendor labels exercise adapter selection and do not represent vendor sandboxes or verified compatibility.</p><ul>${syntheticTenants.map(t => `<li>${t.name}: <code>${htmlEscape(fhirBase(t))}</code></li>`).join('')}</ul><p><a href="${htmlEscape(consoleUrl)}">Open SMART Flint console</a></p></body></html>`));
  app.get('/:vendor/:tenant/r4/.well-known/smart-configuration', async (request, reply) => {
    const tenant = getTenant(request, reply); if (!tenant) return;
    return {
      issuer: oauthBase(tenant), authorization_endpoint: `${oauthBase(tenant)}/authorize`, token_endpoint: `${oauthBase(tenant)}/token`, jwks_uri: `${oauthBase(tenant)}/jwks`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt', 'client_secret_basic', 'client_secret_post'],
      token_endpoint_auth_signing_alg_values_supported: ['ES384', 'RS384'], code_challenge_methods_supported: ['S256'],
      scopes_supported: [...scopes],
      capabilities: ['launch-ehr', 'launch-standalone', 'client-public', 'client-confidential-symmetric', 'client-confidential-asymmetric', 'sso-openid-connect', 'context-ehr-patient', 'context-ehr-encounter', 'context-standalone-patient', 'permission-patient', 'permission-user', 'permission-v1', 'permission-v2', 'permission-offline'],
    };
  });
  app.get('/:vendor/:tenant/oauth/jwks', async (request, reply) => {
    if (!getTenant(request, reply)) return;
    return { keys: [jwk] };
  });
  app.get('/:vendor/:tenant/ehr-launch', async (request, reply) => {
    const tenant = getTenant(request, reply); if (!tenant) return;
    const query = request.query as Record<string, string>;
    let launchUrl: URL;
    try {
      launchUrl = new URL(query.launch_url ?? `${bridgeBaseUrl}/launch/inst_${tenant.id}`);
      if (launchUrl.origin !== new URL(bridgeBaseUrl).origin || !/^\/launch\/[A-Za-z0-9_-]+$/.test(launchUrl.pathname) || launchUrl.username || launchUrl.password || launchUrl.search || launchUrl.hash) throw new Error();
    } catch { return oauthError(reply, 'invalid_request', 'launch_url must be a registered bridge launch route.'); }
    const launch = random();
    launchHandles.set(launch, { tenant: key(tenant), patient: ['patient-a', 'patient-b', 'patient-c', 'patient-d'].includes(query.patient ?? '') ? query.patient! : 'patient-a', expiresAt: Date.now() + 300_000 });
    launchUrl.searchParams.set('iss', fhirBase(tenant)); launchUrl.searchParams.set('launch', launch);
    return reply.redirect(launchUrl.href);
  });
  app.get('/:vendor/:tenant/oauth/authorize', async (request, reply) => {
    cleanup();
    const tenant = getTenant(request, reply); if (!tenant) return;
    const q = request.query as Record<string, string>;
    if (!['smart-flint-demo', 'smart-flint-health-patient'].includes(q.client_id ?? '') || !q.redirect_uri || !permittedCallback(q.redirect_uri)) {
      return oauthError(reply, 'invalid_client', 'The application or callback is not registered with this synthetic EHR.');
    }
    if (q.response_type !== 'code' || q.aud !== fhirBase(tenant) || !q.state || !q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
      return oauthError(reply, 'invalid_request', 'Authorization requires code, a matching FHIR audience, state, and S256 PKCE.');
    }
    const requested = (q.scope ?? '').split(/\s+/).filter(Boolean);
    if (!requested.length || requested.some(scope => !scopes.has(scope) || scope.startsWith('system/') || (q.client_id === 'smart-flint-health-patient' && scope.startsWith('user/')))) {
      return oauthError(reply, 'invalid_scope', 'This interactive client supports the documented patient/user scopes.');
    }
    let launchPatient: string | undefined;
    if (q.launch) {
      const launch = launchHandles.get(q.launch);
      if (!launch || launch.tenant !== key(tenant) || launch.expiresAt <= Date.now()) return oauthError(reply, 'invalid_request', 'The EHR launch handle is invalid or expired.');
      launchHandles.delete(q.launch); launchPatient = launch.patient;
    }
    const id = random();
    authorizations.set(id, { tenant: key(tenant), clientId: q.client_id!, redirectUri: q.redirect_uri, state: q.state, challenge: q.code_challenge, scope: requested.join(' '), nonce: q.nonce, launchPatient, expiresAt: Date.now() + 300_000 });
    return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic EHR authorization</title><style>*{box-sizing:border-box}body{font:15px system-ui;background:#f4f6f3;color:#183b35;margin:0;padding:72px 24px}main{max-width:540px;margin:auto;background:white;border:1px solid #dce6df;border-radius:20px;padding:36px;box-shadow:0 12px 40px #183b3509}.tag{display:inline-block;background:#edf4ef;padding:6px 10px;border-radius:6px;font-size:11px;letter-spacing:.1em;font-weight:700}h1{font-size:28px;letter-spacing:-.04em;margin-bottom:10px}p{color:#65766e;line-height:1.6}label{display:block;margin:22px 0 8px}select{width:100%;padding:12px;border:1px solid #cddbd1;border-radius:8px;background:white;color:#183b35}button{width:100%;padding:13px;margin-top:20px;background:${tenant.accent};color:white;border:0;border-radius:8px;font:600 14px system-ui;cursor:pointer}.deny{margin-top:8px;background:transparent;color:#65766e}code{display:block;white-space:normal;overflow-wrap:anywhere;font-size:11px;padding:12px;background:#f5f7f4;border-radius:8px}</style></head><body><main><span class="tag">SYNTHETIC EHR · LOCAL DEVELOPMENT</span><h1>Connect to ${htmlEscape(tenant.name)}</h1><p>This protocol simulator uses fictional patient records. It is independent of the named EHR vendor.</p><form method="post" action="${htmlEscape(oauthBase(tenant))}/decision"><input type="hidden" name="transaction" value="${id}"><label for="patient">Patient context</label>${launchPatient ? `<p>${htmlEscape(launchPatient)} · selected by EHR launch</p>` : '<select id="patient" name="patient"><option value="patient-a">Maya Morgan · patient-a</option><option value="patient-b">Noah River · patient-b</option><option value="patient-c">Jamie Chen · incomplete records</option><option value="patient-d">Sam Taylor · very high blood pressure</option></select>'}<label>Requested access</label><code>${htmlEscape(requested.join(' '))}</code><button name="decision" value="allow">Continue with synthetic patient</button><button class="deny" name="decision" value="deny">Decline access</button></form></main></body></html>`);
  });
  app.post('/:vendor/:tenant/oauth/decision', async (request, reply) => {
    cleanup();
    const tenant = getTenant(request, reply); if (!tenant) return;
    const body = request.body as Record<string, string>;
    const auth = authorizations.get(body.transaction ?? '');
    if (!auth || auth.tenant !== key(tenant) || auth.expiresAt <= Date.now()) return oauthError(reply, 'invalid_request', 'This authorization transaction expired or was already used.');
    authorizations.delete(body.transaction!);
    const callback = new URL(auth.redirectUri);
    callback.searchParams.set('state', auth.state); callback.searchParams.set('iss', oauthBase(tenant));
    if (body.decision !== 'allow') callback.searchParams.set('error', 'access_denied');
    else {
      const code = random();
      codes.set(code, { ...auth, patient: auth.launchPatient ?? (['patient-a', 'patient-b', 'patient-c', 'patient-d'].includes(body.patient ?? '') ? body.patient! : 'patient-a'), expiresAt: Date.now() + 60_000 });
      callback.searchParams.set('code', code);
    }
    return reply.header('Cache-Control', 'no-store').redirect(callback.href);
  });
  app.post('/:vendor/:tenant/oauth/token', async (request, reply) => {
    cleanup();
    const tenant = getTenant(request, reply); if (!tenant) return;
    const body = request.body as Record<string, string>;
    if (!body || typeof body !== 'object') return oauthError(reply, 'invalid_request', 'A form-encoded request is required.');
    const clientId = await authenticateClient(request, reply, tenant, body); if (!clientId) return;
    if (body.grant_type === 'authorization_code') {
      const auth = codes.get(body.code ?? '');
      if (!auth || auth.expiresAt <= Date.now() || auth.tenant !== key(tenant) || auth.clientId !== clientId || auth.redirectUri !== body.redirect_uri || !body.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) || createHash('sha256').update(body.code_verifier).digest('base64url') !== auth.challenge) {
        return oauthError(reply, 'invalid_grant', 'The authorization code, callback, or PKCE verifier did not match.');
      }
      codes.delete(body.code!);
      return issueToken(reply, tenant, { tenant: key(tenant), clientId, scope: auth.scope, patient: auth.patient }, auth.nonce);
    }
    if (body.grant_type === 'refresh_token') {
      const grant = refreshTokens.get(body.refresh_token ?? '');
      if (!grant || grant.expiresAt <= Date.now() || grant.clientId !== clientId || grant.tenant !== key(tenant)) return oauthError(reply, 'invalid_grant', 'The refresh token is invalid, expired, or already rotated.');
      const requested = body.scope?.split(/\s+/).filter(Boolean);
      if (requested?.some(scope => !grant.scope.split(' ').includes(scope))) return oauthError(reply, 'invalid_scope', 'A refresh request cannot expand access.');
      refreshTokens.delete(body.refresh_token!);
      return issueToken(reply, tenant, { tenant: grant.tenant, clientId, scope: requested?.join(' ') ?? grant.scope, patient: grant.patient });
    }
    if (body.grant_type === 'client_credentials') {
      if (clientId !== 'smart-flint-service') return oauthError(reply, 'unauthorized_client', 'This application is not a registered backend service.');
      const requested = (body.scope ?? '').split(/\s+/).filter(Boolean);
      if (!requested.length || requested.some(scope => !scope.startsWith('system/') || !scopes.has(scope))) return oauthError(reply, 'invalid_scope', 'Backend services require preauthorized system scopes.');
      return issueToken(reply, tenant, { tenant: key(tenant), clientId, scope: requested.join(' ') });
    }
    return oauthError(reply, 'unsupported_grant_type', 'Use authorization_code, refresh_token, or client_credentials.');
  });

  function fhirError(reply: FastifyReply, status: number, code: string, diagnostics: string) {
    return reply.code(status).type('application/fhir+json').send({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] });
  }
  function authorizeFHIR(request: FastifyRequest, reply: FastifyReply, tenant: Tenant, resource: string, operation: 'r' | 's'): AccessGrant | undefined {
    const header = request.headers.authorization;
    const grant = header?.startsWith('Bearer ') ? accessTokens.get(header.slice(7)) : undefined;
    if (!grant || grant.expiresAt <= Date.now() || grant.tenant !== key(tenant)) {
      reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      fhirError(reply, 401, 'login', 'A valid access token for this synthetic tenant is required.'); return;
    }
    const authorized = grant.scope.split(' ').some(scope => {
      const match = /^(patient|user|system)\/([A-Za-z]+|\*)\.(rs|read|r|s)$/.exec(scope);
      return match && (match[2] === resource || match[2] === '*') && (match[3] === 'read' || match[3]!.includes(operation));
    });
    if (!authorized) { fhirError(reply, 403, 'forbidden', `The token does not authorize ${resource} ${operation === 'r' ? 'read' : 'search'}.`); return; }
    return grant;
  }
  function hasUnrestrictedScope(grant: AccessGrant, resource: string, operation: 'r' | 's') {
    return grant.scope.split(' ').some(scope => {
      const match = /^(user|system)\/([A-Za-z]+|\*)\.(rs|read|r|s)$/.exec(scope);
      return match && (match[2] === resource || match[2] === '*') && (match[3] === 'read' || match[3]!.includes(operation));
    });
  }
  function patients(tenant: Tenant) {
    return (['patient-a', 'patient-b', 'patient-c', 'patient-d'] as const).map((id, index) => ({
      ...createHealthFixture(id).patient,
      identifier: [{ system: `https://synthetic.example/${tenant.id}/mrn`, value: `SYNTHETIC-${index + 1}` }],
      managingOrganization: { reference: `Organization/${tenant.id}`, display: tenant.name },
    }));
  }
  function observations(tenant: Tenant) {
    const baseline: Array<Record<string, unknown>> = ['a', 'b'].flatMap(suffix => [
      { resourceType: 'Observation', id: `observation-${suffix}-1`, status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }], code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }], text: 'Heart rate' }, subject: { reference: `Patient/patient-${suffix}` }, effectiveDateTime: '2026-01-01T10:00:00Z', valueQuantity: { value: suffix === 'a' ? 72 : 81, unit: 'beats/minute', system: 'http://unitsofmeasure.org', code: '/min' }, performer: [{ reference: `Organization/${tenant.id}` }] },
      { resourceType: 'Observation', id: `observation-${suffix}-2`, status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }], code: { coding: [{ system: 'http://loinc.org', code: '29463-7', display: 'Body weight' }], text: 'Body weight' }, subject: { reference: `Patient/patient-${suffix}` }, effectiveDateTime: '2026-01-01T10:00:00Z', valueQuantity: { value: suffix === 'a' ? 68 : 87, unit: 'kg', system: 'http://unitsofmeasure.org', code: 'kg' } },
    ]);
    return [...baseline, ...(['patient-a', 'patient-b', 'patient-c', 'patient-d'] as const).flatMap(id => createHealthFixture(id).observations)];
  }
  app.get('/:vendor/:tenant/r4/metadata', async (request, reply) => {
    const tenant = getTenant(request, reply); if (!tenant) return;
    return reply.type('application/fhir+json').send({ resourceType: 'CapabilityStatement', status: 'active', date: '2026-01-01', kind: 'instance', fhirVersion: '4.0.1', format: ['json'], implementation: { description: 'SMART Flint local synthetic EHR fixture', url: fhirBase(tenant) }, rest: [{ mode: 'server', resource: ['Patient', 'Observation', 'Encounter', 'Practitioner'].map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }] })) }] });
  });
  app.get('/:vendor/:tenant/r4/:resource/:id', async (request, reply) => {
    const tenant = getTenant(request, reply); if (!tenant) return;
    const { resource, id } = request.params as { resource: string; id: string };
    const grant = authorizeFHIR(request, reply, tenant, resource, 'r'); if (!grant) return;
    let result: unknown;
    if (resource === 'Patient') result = patients(tenant).find(p => p.id === id);
    if (resource === 'Observation') result = observations(tenant).find(p => p.id === id);
    if (resource === 'Encounter' && /^encounter-[abcd]$/.test(id)) result = { resourceType: 'Encounter', id, status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: `Patient/patient-${id.slice(-1)}` } };
    if (resource === 'Practitioner' && id === 'clinician-1') result = { resourceType: 'Practitioner', id, name: [{ family: 'Example', given: ['Casey'], prefix: ['Dr.'] }] };
    if (!result) return fhirError(reply, 404, 'not-found', 'The synthetic resource does not exist.');
    if (grant.patient && ['Patient', 'Observation', 'Encounter'].includes(resource) && !hasUnrestrictedScope(grant, resource, 'r')) {
      const reference = resource === 'Patient' ? `Patient/${id}` : (result as { subject?: { reference?: string } }).subject?.reference;
      if (reference !== `Patient/${grant.patient}`) return fhirError(reply, 403, 'forbidden', 'This token is restricted to its patient context.');
    }
    return reply.type('application/fhir+json').header('ETag', 'W/"1"').send(result);
  });
  app.get('/:vendor/:tenant/r4/:resource', async (request, reply) => {
    const tenant = getTenant(request, reply); if (!tenant) return;
    const { resource } = request.params as { resource: string };
    const grant = authorizeFHIR(request, reply, tenant, resource, 's'); if (!grant) return;
    const query = request.query as Record<string, string>;
    const allowedSearch = new Set(['patient', 'subject', '_id', '_count', '_offset', 'code', 'category']);
    if (Object.keys(query).some(q => !allowedSearch.has(q))) return fhirError(reply, 400, 'not-supported', 'This synthetic endpoint supports a deliberately small documented search subset.');
    const requestedPatient = (query.patient ?? query.subject)?.replace(/^Patient\//, '');
    const patientOnly = grant.patient && !hasUnrestrictedScope(grant, resource, 's');
    if (patientOnly && requestedPatient && requestedPatient !== grant.patient) return fhirError(reply, 403, 'forbidden', 'This token is restricted to its patient context.');
    const patientId = patientOnly ? grant.patient : requestedPatient;
    let resources: Array<Record<string, unknown>> = resource === 'Patient' ? patients(tenant) : resource === 'Observation' ? observations(tenant) : [];
    if (patientId) resources = resources.filter(r => resource === 'Patient' ? r.id === patientId : (r.subject as { reference?: string } | undefined)?.reference === `Patient/${patientId}`);
    if (query._id) resources = resources.filter(r => r.id === query._id);
    if (query.code) resources = resources.filter(r => ((r.code as { coding?: { code: string; system: string }[] } | undefined)?.coding ?? []).some(c => query.code === c.code || query.code === `${c.system}|${c.code}`));
    if (query.category) resources = resources.filter(r => ((r.category as { coding?: { code: string; system: string }[] }[] | undefined) ?? []).some(cat => (cat.coding ?? []).some(c => query.category === c.code || query.category === `${c.system}|${c.code}`)));
    const offset = Math.max(0, Math.min(1000, Number(query._offset) || 0));
    const count = Math.max(1, Math.min(100, Number(query._count) || 20));
    const self = new URL(request.url, baseUrl).href;
    const links = [{ relation: 'self', url: self }];
    if (offset + count < resources.length) {
      const next = new URL(self); next.searchParams.set('_offset', String(offset + count)); next.searchParams.set('_count', String(count)); links.push({ relation: 'next', url: next.href });
    }
    return reply.type('application/fhir+json').send({ resourceType: 'Bundle', type: 'searchset', total: resources.length, link: links, entry: resources.slice(offset, offset + count).map(resource => ({ fullUrl: `${fhirBase(tenant)}/${resource.resourceType}/${resource.id}`, resource, search: { mode: 'match' } })) });
  });
  app.post('/:vendor/:tenant/cds-hooks/health-review', async (request, reply) => {
    const tenant = getTenant(request, reply); if (!tenant) return;
    const body = request.body as { patientId?: string } | undefined;
    const patientId = body?.patientId ?? 'patient-a';
    const patient = patients(tenant).find(item => item.id === patientId);
    if (!patient) return reply.code(400).send({ error: 'unknown_synthetic_patient' });
    const serviceUrl = `${bridgeBaseUrl}/cds-services/cds_health_${tenant.id}`;
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
      .setIssuer(oauthBase(tenant)).setAudience(serviceUrl).setIssuedAt().setExpirationTime('4m').setJti(random()).sign(signing.privateKey);
    const response = await fetch(serviceUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${assertion}` },
      body: JSON.stringify({ hook: 'patient-view', hookInstance: crypto.randomUUID(), context: { patientId }, fhirServer: fhirBase(tenant),
        prefetch: { patient, observations: { resourceType: 'Bundle', type: 'searchset', entry: observations(tenant).filter(observation => (observation.subject as { reference?: string })?.reference === `Patient/${patientId}`).map(resource => ({ resource })) } } }),
    });
    return reply.code(response.status).header('Cache-Control', 'no-store').send(await response.json());
  });
  return app;
}
