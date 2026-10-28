import { serviceVersion } from './version.js';
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Activation, AdminUser, Application, AppRegistration, Connection, Dashboard, EHRPlatform, Installation, Registration, Tenant } from '../../../packages/contracts/src/index.js';
import { randomId } from '../../../packages/storage/src/index.js';
import { Bridge, later, now, publicJWK, scopesCover } from './bridge.js';
import { assert, Problem } from './errors.js';
import { legacyAppRegistration, resolvePlatform, validateAppRegistration } from './registry.js';
import { allowedAdminOrigin, authenticateAdmin, registerAdminAuthentication, usablePlatformAdmin } from './admin-auth.js';
import { normalizeUsername, setLocalPassword, validateAdminPassword } from './admin-passwords.js';
import { configuredAdminMode } from './config.js';
import { AdminPolicy } from './admin-policy.js';
import { adminAuditContext } from './admin-context.js';

const name = z.string().trim().min(1).max(120);
const id = z.string().min(1).max(128);
const vendor = z.enum(['generic', 'epic', 'oracle', 'meditech']);
const mode = z.enum(['gateway', 'direct', 'handoff']);
const scopes = z.array(z.string().min(1).max(1024).regex(/^\S+$/)).max(100);
const environment = z.enum(['sandbox', 'production', 'unspecified']);
const audience = z.enum(['patient', 'clinician', 'backend', 'unspecified']);
const metadataUrl = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash; }
  catch { return false; }
}, 'Use an absolute HTTP or HTTPS URL without credentials or fragments.').transform(value => value || undefined);
const platformInput = z.object({ name, vendor: vendor.default('generic'), description: z.string().trim().max(2000).default(''), documentationUrl: metadataUrl.optional() }).strict();
const platformPatch = z.object({ name: name.optional(), vendor: vendor.optional(), description: z.string().trim().max(2000).optional(), documentationUrl: metadataUrl.optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'Provide at least one platform field.');
const appRegistrationInput = z.object({
  name, platformId: id, applicationIds: z.array(id).max(100).default([]), audience: audience.default('unspecified'),
  clientRegistrationIds: z.array(id).max(100).default([]), portalUrl: metadataUrl.optional(),
}).strict();
const appRegistrationPatch = z.object({
  name: name.optional(), applicationIds: z.array(id).max(100).optional(), audience: audience.optional(), portalUrl: metadataUrl.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one app registration field.');
const tenantInput = z.object({ name, slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional() }).strict();
const applicationInput = z.object({
  name, description: z.string().trim().max(2000).default(''), callbackUrls: z.array(z.string().max(2048)).max(30).default([]),
  requiredContext: z.array(z.enum(['patient', 'encounter'])).max(2).default([]),
  requiredScopes: scopes.default([]), allowedModes: z.array(mode).min(1).max(3).default(['gateway', 'direct', 'handoff']),
}).strict();
const applicationPatch = z.object({
  name: name.optional(), description: applicationInput.shape.description.removeDefault().optional(),
  callbackUrls: applicationInput.shape.callbackUrls.removeDefault().optional(), requiredContext: applicationInput.shape.requiredContext.removeDefault().optional(),
  requiredScopes: applicationInput.shape.requiredScopes.removeDefault().optional(), allowedModes: applicationInput.shape.allowedModes.removeDefault().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one application field.');
const connectionInput = z.object({
  tenantId: id, name, vendor: vendor.optional(), platformId: id.optional(), fhirBaseUrl: z.string().max(2048),
  environment: z.enum(['sandbox', 'production']).default('sandbox'), fhirVersion: z.string().min(1).max(40).default('4.0.1'),
  oidcIssuer: z.string().max(2048).optional(),
  allowedOrigins: z.array(z.string().max(2048)).min(1).max(20).optional(),
  discoveryHeaders: z.record(z.string(), z.string().max(1024)).optional(),
}).strict();
const registrationInput = z.object({
  name, vendor: vendor.optional(), platformId: id.optional(), environment: environment.default('unspecified'), clientId: z.string().trim().min(1).max(512),
  authMethod: z.enum(['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt']).default('none'),
  secret: z.string().min(1).max(16384).optional(), privateKey: z.union([z.string().max(32768), z.record(z.string(), z.unknown())]).optional(),
  keyId: z.string().min(1).max(128).optional(),
}).strict();
const installationInput = z.object({
  name, applicationId: id, tenantId: id, connectionId: id, registrationId: id, appRegistrationId: id.optional(),
  mode: mode.default('gateway'), enabled: z.boolean().default(true), scopes,
  allowTokenExport: z.boolean().default(false), normalizationProfile: z.enum(['passthrough', 'display-cleanup-v1']).default('passthrough'),
}).strict();
const installationPatch = z.object({
  name: name.optional(), mode: mode.optional(), enabled: z.boolean().optional(), allowTokenExport: z.boolean().optional(),
  normalizationProfile: z.enum(['passthrough', 'display-cleanup-v1']).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one installation field.');

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Problem(400, 'invalid_request', result.error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '));
  }
  return result.data;
}

function callbackUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Problem(400, 'invalid_callback', 'Application callbacks must be absolute URLs.'); }
  assert(!url.username && !url.password && !url.hash, 400, 'invalid_callback', 'Application callbacks cannot contain credentials or fragments.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const native = /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(url.protocol) && !['http:', 'https:', 'javascript:', 'data:', 'file:'].includes(url.protocol);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && local) || native, 400, 'invalid_callback', 'Use HTTPS, a native reverse-domain URI scheme, or a loopback callback.');
  return value;
}

function redactActivation(activation: Activation): Activation {
  const { principal: _principal, error: _error, ...rest } = activation;
  return {
    ...rest, context: { extensions: {} }, presentation: { needPatientBanner: activation.presentation.needPatientBanner },
    ...(activation.error ? { error: { code: activation.error.code, message: 'The activation could not satisfy its requirements.' } } : {}),
  };
}

/** Explicit projection prevents accidentally exposing future credential fields. References are legacy API metadata. */
function registrationMetadata(registration: Registration): Registration {
  const { id, name, vendor, platformId, environment, clientId, authMethod, secretRef, privateKeyRef, keyId, createdAt } = registration;
  return { id, name, vendor, platformId, environment, clientId, authMethod, secretRef, privateKeyRef, keyId, createdAt };
}

/** Password material is never part of the public administrative directory. */
function adminUserMetadata(user: AdminUser): AdminUser {
  const { id, authMethod, username, issuer, subject, displayName, email, role, organizationIds, applicationIds, disabled, createdAt, updatedAt } = user;
  return { id, authMethod, username, issuer, subject, displayName, email, role, organizationIds, applicationIds, disabled, createdAt, updatedAt };
}

async function validateParentReferences(bridge: Bridge, parent: Pick<AppRegistration, 'platformId' | 'applicationIds' | 'clientRegistrationIds'>): Promise<void> {
  const platform = await resolvePlatform(bridge.repo, parent.platformId);
  for (const applicationId of parent.applicationIds) {
    assert(await bridge.repo.get<Application>('applications', applicationId), 404, 'application_not_found', 'An associated application does not exist.');
  }
  for (const registrationId of parent.clientRegistrationIds) {
    const registration = await bridge.repo.get<Registration>('registrations', registrationId);
    assert(registration, 404, 'registration_not_found', 'An associated OAuth client profile does not exist.');
    assert(!registration.platformId || registration.platformId === platform.id, 409, 'platform_mismatch', 'The OAuth client profile belongs to another EHR platform.');
    assert(registration.vendor === 'generic' || registration.vendor === platform.vendor || platform.vendor === 'generic', 409, 'vendor_mismatch', 'The OAuth client profile uses a different vendor adapter.');
  }
}

async function createRegistration(bridge: Bridge, input: z.infer<typeof registrationInput>, forcedPlatform?: EHRPlatform, legacy = false): Promise<Registration> {
  const platform = forcedPlatform ?? await resolvePlatform(bridge.repo, input.platformId, input.vendor);
  assert(!input.platformId || input.platformId === platform.id, 409, 'platform_mismatch', 'The OAuth client profile belongs to another EHR platform.');
  assert(!input.vendor || input.vendor === platform.vendor, 409, 'platform_vendor_mismatch', 'The platform and adapter vendor must agree.');
  const legacyGeneric = legacy && !input.platformId && platform.vendor === 'generic';
  const registration: Registration = { id: randomId('reg'), name: input.name, vendor: platform.vendor, ...(legacyGeneric ? {} : { platformId: platform.id }), environment: input.environment, clientId: input.clientId, authMethod: input.authMethod, createdAt: now() };
  if (input.authMethod === 'client_secret_basic' || input.authMethod === 'client_secret_post') {
    assert(input.secret, 400, 'client_secret_required', 'Provide the upstream client secret for this registration.');
    assert(!input.privateKey, 400, 'invalid_registration', 'This authentication method uses a client secret.');
    registration.secretRef = `registration:${registration.id}:secret`;
    await bridge.vault.set(registration.secretRef, input.secret);
  } else if (input.authMethod === 'private_key_jwt') {
    assert(!input.secret, 400, 'invalid_registration', 'Private-key JWT authentication uses an asymmetric key.');
    let key: JWK;
    if (input.privateKey) {
      try { key = (typeof input.privateKey === 'string' ? JSON.parse(input.privateKey) : input.privateKey) as JWK; }
      catch { throw new Problem(400, 'invalid_private_key', 'Provide a valid private JWK object.'); }
      assert(key && typeof key === 'object' && typeof key.d === 'string' && ['EC', 'RSA'].includes(key.kty ?? ''), 400, 'invalid_private_key', 'Provide an asymmetric private JWK.');
      const alg = key.alg ?? (key.kty === 'EC' && key.crv === 'P-256' ? 'ES256' : key.kty === 'RSA' ? 'RS384' : 'ES384');
      assert(['ES256', 'ES384', 'RS256', 'RS384'].includes(alg), 400, 'invalid_private_key', 'The signing algorithm is not supported.');
      const kid = input.keyId ?? key.kid ?? randomId('key');
      try {
        // Canonical export discards arbitrary supplied members before a public JWKS is derived.
        const imported = await importJWK(key, alg, { extractable: true });
        key = { ...await exportJWK(imported), alg, kid, use: 'sig' };
      } catch { throw new Problem(400, 'invalid_private_key', 'The private JWK is invalid for its signing algorithm.'); }
    } else {
      const pair = await generateKeyPair('ES384', { extractable: true });
      key = { ...await exportJWK(pair.privateKey), alg: 'ES384', kid: input.keyId ?? randomId('key'), use: 'sig' };
    }
    registration.privateKeyRef = `registration:${registration.id}:private-key`;
    registration.keyId = key.kid;
    await bridge.vault.set(registration.privateKeyRef, key);
  } else {
    assert(!input.secret && !input.privateKey && !input.keyId, 400, 'invalid_registration', 'Public-client registrations cannot contain a confidential secret or signing key.');
  }
  await bridge.repo.put('registrations', registration);
  await bridge.audit('registration.created', 'An upstream registration was configured; private credentials are encrypted.', { outcome: 'success' });
  return registration;
}

export function registerAdmin(app: FastifyInstance, bridge: Bridge): void {
  registerAdminAuthentication(app, bridge);
  const policies = new WeakMap<FastifyRequest, AdminPolicy>();
  const policyFor = (request: FastifyRequest) => policies.get(request)!;

  // Public keys are registration-specific. Private key material never leaves the vault.
  app.get<{ Params: { registrationId: string } }>('/.well-known/jwks/:registrationId', async (request, reply) => {
    const registration = await bridge.repo.get<Registration>('registrations', request.params.registrationId);
    assert(registration, 404, 'registration_not_found', 'This registration does not exist.');
    const key = registration.privateKeyRef && await bridge.vault.get<JWK>(registration.privateKeyRef);
    reply.header('Cache-Control', 'public, max-age=300');
    return { keys: key ? [publicJWK(key)] : [] };
  });

  app.register(async admin => {
    admin.addHook('onRoute', route => {
      const handler = route.handler;
      route.handler = async function(request, reply) {
        const execute = async () => {
          const principal = await authenticateAdmin(bridge, request);
          assert(principal, 401, 'authentication_required', 'An administrative session is required.');
          allowedAdminOrigin(bridge, request, principal.authentication === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
          reply.header('Cache-Control', 'no-store');
          const policy = await AdminPolicy.load(bridge, principal);
          policies.set(request, policy);
          policy.authorize(request);
          const { id, displayName, kind, role } = principal.identity;
          const actor = { id, displayName, kind, role };
          const segments = new URL(request.url, bridge.config.baseUrl).pathname.split('/').slice(3);
          const target = segments[1] ? decodeURIComponent(segments[1]) : undefined;
          return adminAuditContext.run({ actor, ...(target ? { resource: { type: segments[0]!, id: target } } : {}), ...(target && segments[0] === 'applications' ? { applicationId: target } : {}) }, () => handler.call(this, request, reply));
        };
        // Permission checks and writes share a lock, including grant edits and user changes.
        // Nested repository locks reuse the PostgreSQL transaction's leased connection.
        try {
          return await (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)
            ? bridge.repo.withLock('admin:write', execute) : execute());
        } catch (error) {
          const identity = policies.get(request)?.principal.identity;
          if (identity && error instanceof Problem && [403, 404].includes(error.status)) {
            const { id, displayName, kind, role } = identity;
            await bridge.audit('admin.access_denied', 'An administrative operation was denied.', { outcome: 'failure', actor: { id, displayName, kind, role } });
          }
          throw error;
        }
      };
    });

    admin.get('/dashboard', async (request): Promise<Dashboard> => {
      const policy = policyFor(request);
      const platforms = await bridge.repo.list<EHRPlatform>('platforms');
      const events = (await bridge.repo.list<Dashboard['events'][number]>('events')).filter(event => policy.eventVisible(event));
      const summaries = policy.summaries.filter(summary => policy.canRead('activations', summary.id));
      const activations = await Promise.all(summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200).map(async row => redactActivation(await bridge.activation(row.id))));
      return {
        tenants: policy.tenants.filter(t => policy.canRead('tenants', t.id)), platforms,
        applications: policy.applications.filter(a => policy.canRead('applications', a.id)),
        connections: policy.connections.filter(c => policy.canRead('connections', c.id)),
        registrations: policy.registrations.filter(r => policy.canRead('registrations', r.id)).map(registrationMetadata),
        appRegistrations: policy.parents.filter(p => policy.canRead('appRegistrations', p.id)).map(p => policy.parentProjection(p)),
        installations: policy.installations.filter(i => policy.installation(i)), activations,
        events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100), access: policy.access(),
        runtime: { version: serviceVersion, storage: bridge.repo.kind, demo: bridge.config.demo, baseUrl: bridge.config.baseUrl, consoleUrl: bridge.config.consoleUrl,
          ...(bridge.config.demo ? { samples: { patientUrl: bridge.config.samplePatientUrl ?? 'http://127.0.0.1:4100', cdsUrl: bridge.config.sampleCdsUrl ?? 'http://127.0.0.1:4101', fhirUrl: bridge.config.sampleFhirUrl ?? 'http://127.0.0.1:4102', mockEhrUrl: bridge.config.mockEhrUrl } } : {}) },
      };
    });

    const userFields = {
      displayName: name, email: z.string().email().max(320).optional(),
      role: z.enum(['platform_admin', 'integration_admin', 'viewer']),
      organizationIds: z.array(id).max(200), applicationIds: z.array(id).max(200), disabled: z.boolean(),
    };
    const oidcUserInput = z.object({ ...userFields, authMethod: z.literal('oidc').default('oidc'), issuer: z.string().url().max(2048), subject: z.string().min(1).max(512), disabled: userFields.disabled.default(false) }).strict();
    const localUserInput = z.object({ ...userFields, authMethod: z.literal('local').default('local'), username: z.string().trim().min(1).max(64), password: z.string().min(1).max(512), disabled: userFields.disabled.default(false) }).strict();
    const userInput = z.union([localUserInput, oidcUserInput]);
    const userPatch = z.object({
      displayName: userFields.displayName.optional(), email: userFields.email,
      role: userFields.role.optional(), organizationIds: userFields.organizationIds.optional(),
      applicationIds: userFields.applicationIds.optional(), disabled: userFields.disabled.optional(),
    }).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one user field.');
    const validateAssignments = async (user: Pick<AdminUser, 'organizationIds' | 'applicationIds'>) => {
      for (const organizationId of user.organizationIds) assert(await bridge.repo.get('tenants', organizationId), 400, 'invalid_assignment', 'An assigned organization does not exist.');
      for (const applicationId of user.applicationIds) assert(await bridge.repo.get('applications', applicationId), 400, 'invalid_assignment', 'An assigned application does not exist.');
    };
    admin.get('/users', async () => (await bridge.repo.list<AdminUser>('admin_users')).map(adminUserMetadata));
    admin.post('/users', async (request, reply) => {
      const input = parse(userInput, request.body);
      await validateAssignments(input);
      const mode = configuredAdminMode(bridge.config);
      assert(mode === 'demo' || input.authMethod === mode, 403, 'authentication_method_disabled', 'This deployment does not enable the selected sign-in method.');
      const existing = await bridge.repo.list<AdminUser>('admin_users');
      let identity: Pick<AdminUser, 'authMethod' | 'username' | 'issuer' | 'subject'>;
      if (input.authMethod === 'local') {
        const username = normalizeUsername(input.username);
        validateAdminPassword(input.password);
        assert(!existing.some(u => u.authMethod === 'local' && u.username?.toLowerCase() === username), 409, 'username_exists', 'A local administrative user already has this username.');
        identity = { authMethod: 'local', username };
      } else {
        assert(bridge.config.demo || bridge.config.adminOidc, 409, 'oidc_not_configured', 'Configure OIDC before provisioning production OIDC users.');
        assert(!bridge.config.adminOidc || input.issuer === bridge.config.adminOidc.issuer, 400, 'issuer_mismatch', 'Use the exact issuer configured for administrative sign-in.');
        const issuer = new URL(input.issuer);
        assert(issuer.protocol === 'https:' && !issuer.username && !issuer.password && !issuer.search && !issuer.hash, 400, 'invalid_issuer', 'Use a plain HTTPS identity-provider issuer.');
        assert(!existing.some(u => u.authMethod !== 'local' && u.issuer === input.issuer && u.subject === input.subject), 409, 'identity_exists', 'An administrative user already has this issuer and subject.');
        identity = { authMethod: 'oidc', issuer: input.issuer, subject: input.subject };
      }
      // Explicit projection keeps write-only password input out of user records and responses.
      const user: AdminUser = { id: randomId('adminuser'), ...identity, displayName: input.displayName,
        ...(input.email ? { email: input.email } : {}), role: input.role,
        organizationIds: [...new Set(input.organizationIds)], applicationIds: [...new Set(input.applicationIds)],
        disabled: input.disabled, createdAt: now(), updatedAt: now() };
      if (input.authMethod === 'local') await setLocalPassword(bridge, user.id, input.password);
      await bridge.repo.put('admin_users', user);
      await bridge.audit('admin.user_created', 'An administrative user was provisioned.', { outcome: 'success', resource: { type: 'admin_users', id: user.id } });
      reply.code(201); return adminUserMetadata(user);
    });
    admin.patch<{ Params: { id: string } }>('/users/:id', async request => {
      const input = parse(userPatch, request.body);
      const user = await bridge.repo.get<AdminUser>('admin_users', request.params.id);
      assert(user, 404, 'user_not_found', 'This administrative user does not exist.');
      const next: AdminUser = { ...user, ...input,
        organizationIds: [...new Set(input.organizationIds ?? user.organizationIds)], applicationIds: [...new Set(input.applicationIds ?? user.applicationIds)], updatedAt: now() };
      await validateAssignments(next);
      if (await usablePlatformAdmin(bridge, user) && (next.disabled || next.role !== 'platform_admin')) {
        const users = await bridge.repo.list<AdminUser>('admin_users');
        const flags = await Promise.all(users.map(value => usablePlatformAdmin(bridge, value)));
        const owners = users.filter((_user, index) => flags[index]);
        assert(owners.some(u => u.id !== user.id), 409, 'last_platform_admin', 'Keep at least one enabled platform administrator. Provision another owner before changing this account.');
      }
      await bridge.repo.put('admin_users', next);
      await bridge.audit('admin.user_updated', 'Administrative identity, assignments or role were updated.', { outcome: 'success', resource: { type: 'admin_users', id: user.id } });
      return adminUserMetadata(next);
    });

    admin.get('/platforms', async () => bridge.repo.list<EHRPlatform>('platforms'));
    admin.get<{ Params: { id: string } }>('/platforms/:id', async request => resolvePlatform(bridge.repo, request.params.id));

    admin.post('/platforms', async (request, reply) => {
      const input = parse(platformInput, request.body);
      const platform = await bridge.repo.put<EHRPlatform>('platforms', { ...input, id: randomId('platform'), createdAt: now() });
      await bridge.audit('platform.created', 'An EHR integration platform was configured.', { outcome: 'success' });
      reply.code(201); return platform;
    });

    admin.patch<{ Params: { id: string } }>('/platforms/:id', async request => {
      const patch = parse(platformPatch, request.body);
      return bridge.repo.withLock('registry:relations', async () => {
        const platform = await resolvePlatform(bridge.repo, request.params.id);
        if (patch.vendor && patch.vendor !== platform.vendor) {
          assert(!['platform_epic', 'platform_oracle', 'platform_meditech', 'platform_generic'].includes(platform.id), 409, 'platform_in_use', 'The built-in adapter platform vendor cannot change. Create a separate platform for another adapter.');
          const [connections, parents, registrations] = await Promise.all([
            bridge.repo.list<Connection>('connections'), bridge.repo.list<AppRegistration>('app_registrations'), bridge.repo.list<Registration>('registrations'),
          ]);
          assert(!connections.some(connection => connection.platformId === platform.id) && !parents.some(parent => parent.platformId === platform.id) && !registrations.some(client => client.platformId === platform.id),
            409, 'platform_in_use', 'The adapter vendor cannot change while this platform has connections or registrations.');
        }
        const next = await bridge.repo.put('platforms', { ...platform, ...patch });
        await bridge.audit('platform.updated', 'EHR platform metadata was updated.', { outcome: 'success' });
        return next;
      });
    });

    admin.get('/app-registrations', async request => { const p = policyFor(request); return p.parents.filter(r => p.canRead('appRegistrations', r.id)).map(r => p.parentProjection(r)); });
    admin.get<{ Params: { id: string } }>('/app-registrations/:id', async request => {
      const parent = await bridge.repo.get<AppRegistration>('app_registrations', request.params.id);
      assert(parent, 404, 'app_registration_not_found', 'This portal app registration does not exist.');
      return policyFor(request).parentProjection(parent);
    });

    admin.post('/app-registrations', async (request, reply) => {
      return bridge.repo.withLock('registry:relations', async () => {
        const input = parse(appRegistrationInput, request.body);
        await validateParentReferences(bridge, input);
        const parent = await bridge.repo.put<AppRegistration>('app_registrations', { ...input, applicationIds: [...new Set(input.applicationIds)], clientRegistrationIds: [...new Set(input.clientRegistrationIds)], id: randomId('appreg'), createdAt: now() });
        await bridge.audit('app_registration.created', 'An EHR portal app registration was configured.', { outcome: 'success' });
        reply.code(201); return parent;
      });
    });

    admin.patch<{ Params: { id: string } }>('/app-registrations/:id', async request => {
      const patch = parse(appRegistrationPatch, request.body);
      return bridge.repo.withLock('registry:relations', async () => {
        const parent = await bridge.repo.get<AppRegistration>('app_registrations', request.params.id);
        assert(parent, 404, 'app_registration_not_found', 'This portal app registration does not exist.');
        const next: AppRegistration = { ...parent, ...patch, applicationIds: [...new Set(patch.applicationIds ?? parent.applicationIds)] };
        await validateParentReferences(bridge, next);
        const installations = await bridge.repo.list<Installation>('installations');
        assert(!installations.some(installation => installation.appRegistrationId === parent.id && !next.applicationIds.includes(installation.applicationId)),
          409, 'registration_in_use', 'An application association used by an installation cannot be removed.');
        await bridge.repo.put('app_registrations', next);
        await bridge.audit('app_registration.updated', 'EHR portal app registration metadata was updated.', { outcome: 'success' });
        return next;
      });
    });

    admin.post<{ Params: { id: string } }>('/app-registrations/:id/clients', async (request, reply) => {
      const input = parse(registrationInput, request.body);
      return bridge.repo.withLock('registry:relations', async () => {
        const parent = await bridge.repo.get<AppRegistration>('app_registrations', request.params.id);
        assert(parent, 404, 'app_registration_not_found', 'This portal app registration does not exist.');
        const platform = await resolvePlatform(bridge.repo, parent.platformId);
        const registration = await createRegistration(bridge, input, platform);
        await bridge.repo.put('app_registrations', { ...parent, clientRegistrationIds: [...parent.clientRegistrationIds, registration.id] });
        reply.code(201); return registrationMetadata(registration);
      });
    });

    admin.get('/registrations', async request => { const p = policyFor(request); return p.registrations.filter(r => p.canRead('registrations', r.id)).map(registrationMetadata); });

    admin.post('/tenants', async (request, reply) => {
      const input = parse(tenantInput, request.body);
      const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
      assert(slug, 400, 'slug_required', 'Provide a URL-friendly slug for this organization.');
      return bridge.repo.withLock('registry:tenants', async () => {
        assert(!(await bridge.repo.list<Tenant>('tenants')).some(tenant => tenant.slug === slug), 409, 'tenant_slug_exists', 'This organization slug is already in use.');
        const tenant = await bridge.repo.put<Tenant>('tenants', { id: randomId('tenant'), name: input.name, slug, createdAt: now() });
        await bridge.audit('tenant.created', 'A healthcare organization was configured.', { outcome: 'success', tenantId: tenant.id });
        reply.code(201); return tenant;
      });
    });

    admin.post('/applications', async (request, reply) => {
      const input = parse(applicationInput, request.body);
      const application: Application = { ...input, id: randomId('app'), callbackUrls: [...new Set(input.callbackUrls.map(callbackUrl))], createdAt: now() };
      await bridge.repo.put('applications', application);
      await bridge.audit('application.created', 'An application was configured.', { outcome: 'success' });
      reply.code(201); return application;
    });

    admin.patch<{ Params: { id: string } }>('/applications/:id', async request => {
      return bridge.repo.withLock('registry:relations', async () => {
        const patch = parse(applicationPatch, request.body);
        const application = await bridge.repo.get<Application>('applications', request.params.id);
        assert(application, 404, 'application_not_found', 'This application does not exist.');
        const next: Application = { ...application, ...patch, callbackUrls: patch.callbackUrls ? [...new Set(patch.callbackUrls.map(callbackUrl))] : application.callbackUrls };
        for (const installation of await bridge.repo.list<Installation>('installations')) {
          if (installation.applicationId !== application.id) continue;
          assert(next.allowedModes.includes(installation.mode), 409, 'application_in_use', 'An installed access mode cannot be removed from the application.');
          for (const required of next.requiredScopes) assert(scopesCover(installation.scopes, required), 409, 'required_scope_missing', 'An installation does not include the new application scope requirement.');
        }
        await bridge.repo.put('applications', next);
        await bridge.audit('application.updated', 'Application configuration was updated.', { outcome: 'success' });
        return next;
      });
    });

    admin.patch<{ Params: { id: string } }>('/tenants/:id', async request => {
      const patch = parse(z.object({ name }).strict(), request.body);
      const tenant = await bridge.repo.get<Tenant>('tenants', request.params.id);
      assert(tenant, 404, 'tenant_not_found', 'This healthcare organization does not exist.');
      const next = await bridge.repo.put('tenants', { ...tenant, ...patch });
      await bridge.audit('tenant.updated', 'Healthcare organization metadata was updated.', { outcome: 'success', tenantId: tenant.id });
      return next;
    });

    admin.post<{ Params: { id: string } }>('/applications/:id/credentials', async (request) => {
      assert(await bridge.repo.get<Application>('applications', request.params.id), 404, 'application_not_found', 'This application does not exist.');
      parse(z.object({}).strict(), request.body ?? {});
      const apiKey = randomId('appkey');
      await bridge.vault.set(`application-key:${request.params.id}`, apiKey);
      await bridge.audit('application.credentials_rotated', 'An application API credential was rotated. Previously issued activation sessions retain their configured lifetime.', { outcome: 'success' });
      return { applicationId: request.params.id, apiKey };
    });

    admin.post('/connections', async (request, reply) => {
      return bridge.repo.withLock('registry:relations', async () => {
        const input = parse(connectionInput, request.body);
        assert(await bridge.repo.get('tenants', input.tenantId), 404, 'tenant_not_found', 'The healthcare organization does not exist.');
        const platform = await resolvePlatform(bridge.repo, input.platformId, input.vendor);
        let fhir: URL;
        try { fhir = new URL(input.fhirBaseUrl); } catch { throw new Problem(400, 'invalid_url', 'Provide an absolute FHIR base URL.'); }
        assert(!fhir.search, 400, 'invalid_url', 'A FHIR base URL cannot contain query parameters.');
        const allowedOrigins = [...new Set((input.allowedOrigins ?? [fhir.origin]).map(origin => {
          let value: URL;
          try { value = new URL(origin); } catch { throw new Problem(400, 'invalid_origin', 'Allowed origins must be absolute HTTP origins.'); }
          assert(value.origin === origin.replace(/\/$/, '') && !value.username && !value.password, 400, 'invalid_origin', 'Allowed origins cannot contain paths, credentials, queries or fragments.');
          return value.origin;
        }))];
        bridge.http.validate(input.fhirBaseUrl, allowedOrigins);
        for (const origin of allowedOrigins) bridge.http.validate(origin, allowedOrigins);
        if (input.oidcIssuer) {
          const issuer = bridge.http.validate(input.oidcIssuer, allowedOrigins);
          assert(!issuer.search, 400, 'invalid_oidc_issuer', 'An OIDC issuer cannot contain query parameters.');
        }
        for (const header of Object.keys(input.discoveryHeaders ?? {})) {
          assert(/^[A-Za-z0-9-]+$/.test(header) && !/^(authorization|cookie|host|proxy-authorization|set-cookie|connection|content-length)$/i.test(header), 400, 'invalid_discovery_header', 'Discovery headers must be non-sensitive HTTP extension headers.');
          assert(!/[\r\n]/.test(input.discoveryHeaders![header]!), 400, 'invalid_discovery_header', 'Discovery headers cannot contain line breaks.');
        }
        const connection: Connection = { ...input, vendor: platform.vendor, platformId: platform.id, id: randomId('conn'), fhirBaseUrl: input.fhirBaseUrl.replace(/\/+$/, ''), allowedOrigins, status: 'unverified', createdAt: now() };
        await bridge.repo.put('connections', connection);
        await bridge.audit('connection.created', 'A FHIR connection was configured; discovery verification is pending.', { outcome: 'success', tenantId: input.tenantId });
        reply.code(201); return connection;
      });
    });

    admin.post('/registrations', async (request, reply) => {
      return bridge.repo.withLock('registry:relations', async () => {
        const input = parse(registrationInput, request.body);
        const registration = await createRegistration(bridge, input, undefined, true);
        await bridge.repo.put<AppRegistration>('app_registrations', {
          id: randomId('appreg'), name: registration.name, platformId: registration.platformId ?? `platform_${registration.vendor}`, applicationIds: [],
          audience: 'unspecified', clientRegistrationIds: [registration.id], createdAt: registration.createdAt,
        });
        reply.code(201); return registrationMetadata(registration);
      });
    });

    admin.post('/installations', async (request, reply) => {
      const input = parse(installationInput, request.body);
      return bridge.repo.withLock('registry:relations', async () => {
        const [application, tenant, connection, registration] = await Promise.all([
          bridge.repo.get<Application>('applications', input.applicationId), bridge.repo.get<Tenant>('tenants', input.tenantId),
          bridge.repo.get<Connection>('connections', input.connectionId), bridge.repo.get<Registration>('registrations', input.registrationId),
        ]);
        assert(application && tenant && connection && registration, 404, 'configuration_not_found', 'The installation references configuration that does not exist.');
        assert(connection.tenantId === tenant.id, 409, 'tenant_mismatch', 'Select a connection belonging to this healthcare organization.');
        assert(application.allowedModes.includes(input.mode), 400, 'mode_not_allowed', 'The application does not permit this access mode.');
        assert(registration.vendor === 'generic' || connection.vendor === 'generic' || registration.vendor === connection.vendor, 409, 'vendor_mismatch', 'The registration and connection use different vendor profiles.');
        for (const required of application.requiredScopes) assert(scopesCover(input.scopes, required), 400, 'required_scope_missing', `Include the application requirement ${required} in the installation scopes.`);
        const appRegistration = input.appRegistrationId ? await bridge.repo.get<AppRegistration>('app_registrations', input.appRegistrationId) : await legacyAppRegistration(bridge.repo, application, connection, registration);
        assert(appRegistration, 404, 'app_registration_not_found', 'This portal app registration does not exist.');
        await validateAppRegistration(bridge.repo, appRegistration, application, connection, registration);
        const installation: Installation = { ...input, appRegistrationId: appRegistration.id, id: randomId('inst'), scopes: [...new Set(input.scopes)], allowTokenExport: input.allowTokenExport || input.mode !== 'gateway', createdAt: now() };
        await bridge.repo.put('installations', installation);
        await bridge.audit('installation.created', 'An application installation was configured.', { outcome: 'success', tenantId: installation.tenantId, installationId: installation.id });
        reply.code(201); return installation;
      });
    });

    admin.patch<{ Params: { id: string } }>('/installations/:id', async (request) => {
      return bridge.repo.withLock('registry:relations', async () => {
        const patch = parse(installationPatch, request.body);
        const { installation, application } = await bridge.installation(request.params.id, false);
        const next: Installation = { ...installation, ...patch };
        assert(application.allowedModes.includes(next.mode), 400, 'mode_not_allowed', 'The application does not permit this access mode.');
        if (next.mode !== 'gateway') next.allowTokenExport = true;
        await bridge.repo.put('installations', next);
        await bridge.audit('installation.updated', 'Application installation policy was updated.', { outcome: 'success', tenantId: next.tenantId, installationId: next.id });
        return next;
      });
    });

    admin.post<{ Params: { id: string } }>('/connections/:id/verify', async (request) => {
      const connection = await bridge.repo.get<Connection>('connections', request.params.id);
      assert(connection, 404, 'connection_not_found', 'This FHIR connection does not exist.');
      const input = parse(z.object({ registrationId: id.optional() }).strict(), request.body ?? {});
      const installation = (await bridge.repo.list<Installation>('installations')).find(value => value.connectionId === connection.id);
      const registrationId = input.registrationId ?? installation?.registrationId;
      const registration = registrationId ? await bridge.repo.get<Registration>('registrations', registrationId) : undefined;
      assert(!input.registrationId || registration, 404, 'registration_not_found', 'This registration does not exist.');
      try {
        const smartConfiguration = await bridge.discover(connection, registration);
        const verified: Connection = { ...connection, status: 'verified', lastVerifiedAt: now(), smartConfiguration, capabilities: smartConfiguration.capabilities ?? [] };
        await bridge.repo.put('connections', verified);
        await bridge.audit('connection.verified', 'SMART discovery endpoints were verified. An end-to-end launch test is still required.', { outcome: 'success', tenantId: connection.tenantId });
        return verified;
      } catch (error) {
        await bridge.repo.put('connections', { ...connection, status: 'unavailable', lastVerifiedAt: now() });
        await bridge.audit('connection.verification_failed', 'SMART discovery could not be verified.', { outcome: 'failure', tenantId: connection.tenantId });
        throw error;
      }
    });

    admin.get<{ Params: { id: string } }>('/installations/:id/worksheet', async (request) => {
      const { installation, application, connection, registration, appRegistration } = await bridge.installation(request.params.id, false);
      const tenant = await bridge.repo.get<Tenant>('tenants', installation.tenantId);
      return {
        installationId: installation.id, applicationName: application.name, tenantName: tenant?.name ?? installation.tenantId,
        vendor: connection.vendor, clientId: registration.clientId, authMethod: registration.authMethod,
        platformId: connection.platformId, platformName: (await resolvePlatform(bridge.repo, connection.platformId, connection.vendor)).name,
        appRegistrationId: appRegistration?.id, appRegistrationName: appRegistration?.name,
        clientRegistrationId: registration.id, clientRegistrationName: registration.name, clientEnvironment: registration.environment ?? 'unspecified',
        fhirBaseUrl: connection.fhirBaseUrl, environment: connection.environment,
        launchUrl: `${bridge.config.baseUrl}/launch/${installation.id}`,
        redirectUri: `${bridge.config.baseUrl}/oauth/callback/${connection.id}`,
        appCallbackUrls: application.callbackUrls,
        jwksUrl: registration.authMethod === 'private_key_jwt' ? `${bridge.config.baseUrl}/.well-known/jwks/${registration.id}` : undefined,
        scopes: installation.scopes, requirements: { context: application.requiredContext, scopes: application.requiredScopes },
        steps: [
          'Create or update the application registration in the EHR vendor portal using the exact launch and redirect URLs.',
          'Arrange customer enablement, permitted APIs and security configuration for this healthcare organization.',
          ...(registration.authMethod === 'private_key_jwt' ? ['Register the public JWKS URL with the authorization server.'] : []),
          'Verify discovery for this connection, then complete an end-to-end sandbox launch and required FHIR requests.',
          'Enable the installation after confirming its context, granted scopes and selected access mode.',
        ],
      };
    });

    admin.post<{ Params: { id: string } }>('/activations/:id/close', async request => redactActivation(await bridge.closeActivation(request.params.id)));

    admin.get('/cds-services', async request => { const p = policyFor(request); return (await bridge.repo.list<{ id: string }>('cds_services')).filter(s => p.canRead('cdsServices', s.id)); });

    admin.post('/cds-services', async (request, reply) => {
      const input = parse(z.object({
        installationId: id, hook: z.enum(['patient-view', 'encounter-start', 'order-select', 'order-sign']),
        title: name, description: z.string().trim().min(1).max(2000),
        handlerUrl: z.string().max(2048), callerIssuer: z.string().min(1).max(2048), callerJwksUrl: z.string().max(2048),
        prefetch: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), z.string().min(1).max(2048)).optional(),
      }).strict(), request.body);
      const { installation } = await bridge.installation(input.installationId, false);
      let handler: URL, callerKeys: URL;
      try { handler = new URL(input.handlerUrl); callerKeys = new URL(input.callerJwksUrl); }
      catch { throw new Problem(400, 'invalid_url', 'The handler and caller JWKS need absolute approved URLs.'); }
      const allowedOrigins = [...new Set([handler.origin, callerKeys.origin])];
      bridge.http.validate(input.handlerUrl, allowedOrigins);
      bridge.http.validate(input.callerJwksUrl, allowedOrigins);
      const serviceId = randomId('cds');
      const handlerSecret = randomId('hook');
      const service = { ...input, id: serviceId, enabled: true, allowedOrigins, handlerSecretRef: `cds-handler:${serviceId}`, createdAt: now() };
      await bridge.vault.set(service.handlerSecretRef, handlerSecret);
      await bridge.repo.put('cds_services', service);
      await bridge.audit('cds_service.created', 'A CDS Hooks service and its caller trust were configured.', { outcome: 'success', tenantId: installation.tenantId, installationId: installation.id });
      reply.code(201); return { service, handlerSecret };
    });
  }, { prefix: '/api/admin' });
}
