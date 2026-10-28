import { randomBytes } from 'node:crypto';
import type { HTTPMethods } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../apps/server/src/app.js';
import type { AdminUser, AppRegistration, Application, Connection, Dashboard, Installation, Registration, Tenant } from '../packages/contracts/src/index.js';
import { digest, openRepository } from '../packages/storage/src/index.js';

const issuer = 'https://identity.example';
const origin = 'https://flint.example';
const createdAt = '2026-01-01T00:00:00.000Z';
const owned: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const runtime of owned.splice(0)) {
    await runtime.app.close();
    await runtime.bridge.repo.close();
  }
});

/** A real stored OIDC session is fixture setup; authorization always runs through the HTTP API. */
async function setup() {
  const repo = await openRepository({ sqlitePath: ':memory:' });
  const graph = {
    tenants: ['a', 'b'].map(suffix => ({ id: `org-${suffix}`, name: `Organization ${suffix.toUpperCase()}`, slug: `organization-${suffix}`, createdAt } satisfies Tenant)),
    applications: ['a', 'b'].map(suffix => ({ id: `app-${suffix}`, name: `Application ${suffix.toUpperCase()}`, description: '', callbackUrls: [`https://app-${suffix}.example/callback`], requiredContext: [], requiredScopes: [], allowedModes: ['gateway', 'direct', 'handoff'], createdAt } satisfies Application)),
    connections: ['a', 'b'].map(suffix => ({ id: `conn-${suffix}`, tenantId: `org-${suffix}`, name: `Connection ${suffix.toUpperCase()}`, vendor: 'generic', platformId: 'platform_generic', fhirBaseUrl: `https://ehr-${suffix}.example/FHIR/R4`, environment: 'sandbox', fhirVersion: '4.0.1', allowedOrigins: [`https://ehr-${suffix}.example`], status: 'unverified', createdAt } satisfies Connection)),
    registrations: ['a', 'b', 'shared'].map(suffix => ({ id: `reg-${suffix}`, name: `Client ${suffix.toUpperCase()}`, vendor: 'generic', platformId: 'platform_generic', environment: 'sandbox', clientId: `upstream-client-${suffix}`, authMethod: 'none', createdAt } satisfies Registration)),
    app_registrations: [
      ...['a', 'b'].map(suffix => ({ id: `parent-${suffix}`, name: `Portal registration ${suffix.toUpperCase()}`, platformId: 'platform_generic', applicationIds: [`app-${suffix}`], audience: 'patient', clientRegistrationIds: [`reg-${suffix}`], createdAt } satisfies AppRegistration)),
      { id: 'parent-shared', name: 'Shared portal registration', platformId: 'platform_generic', applicationIds: ['app-a', 'app-b'], audience: 'patient', clientRegistrationIds: ['reg-shared', 'reg-b'], createdAt } satisfies AppRegistration,
    ],
    installations: ['a', 'b'].flatMap(suffix => [
      { id: `inst-${suffix}`, name: `Installation ${suffix.toUpperCase()}`, applicationId: `app-${suffix}`, tenantId: `org-${suffix}`, connectionId: `conn-${suffix}`, registrationId: `reg-${suffix}`, appRegistrationId: `parent-${suffix}`, mode: 'gateway', enabled: true, scopes: ['patient/Patient.rs'], allowTokenExport: false, normalizationProfile: 'passthrough', createdAt } satisfies Installation,
      { id: `inst-shared-${suffix}`, name: `Shared client installation ${suffix.toUpperCase()}`, applicationId: `app-${suffix}`, tenantId: `org-${suffix}`, connectionId: `conn-${suffix}`, registrationId: 'reg-shared', appRegistrationId: 'parent-shared', mode: 'gateway', enabled: true, scopes: ['patient/Patient.rs'], allowTokenExport: false, normalizationProfile: 'passthrough', createdAt } satisfies Installation,
    ]),
  };
  for (const [collection, rows] of Object.entries(graph)) for (const row of rows) await repo.put(collection, row);
  const users = {
    owner: { id: 'user-owner', issuer, subject: 'owner-subject', displayName: 'Platform owner', role: 'platform_admin', organizationIds: [], applicationIds: [], disabled: false, createdAt, updatedAt: createdAt } satisfies AdminUser,
    a: { id: 'user-a', issuer, subject: 'operator-a', displayName: 'Operator A', role: 'integration_admin', organizationIds: ['org-a'], applicationIds: ['app-a'], disabled: false, createdAt, updatedAt: createdAt } satisfies AdminUser,
    b: { id: 'user-b', issuer, subject: 'operator-b', displayName: 'Operator B', role: 'integration_admin', organizationIds: ['org-b'], applicationIds: ['app-b'], disabled: false, createdAt, updatedAt: createdAt } satisfies AdminUser,
    viewer: { id: 'user-viewer', issuer, subject: 'viewer-a', displayName: 'Read-only reviewer', role: 'viewer', organizationIds: ['org-a'], applicationIds: ['app-a'], disabled: false, createdAt, updatedAt: createdAt } satisfies AdminUser,
  };
  const headers = {} as Record<keyof typeof users, Record<string, string>>;
  for (const [key, user] of Object.entries(users)) {
    await repo.put('admin_users', user);
    const credential = randomBytes(32).toString('base64url');
    await repo.put('sessions', { id: `admin:${digest(credential)}`, userId: user.id, kind: 'oidc', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    headers[key as keyof typeof users] = { cookie: `smart_flint_admin=${credential}`, origin, 'content-type': 'application/json' };
  }
  const runtime = await buildApp({ repository: repo, seed: false, serveConsole: false, config: {
    demo: false, host: '127.0.0.1', port: 0, baseUrl: origin, consoleUrl: origin,
    adminToken: '', encryptionKey: randomBytes(32).toString('base64'), sqlitePath: ':memory:',
    adminOidc: { issuer, clientId: 'admin-client', authMethod: 'none', allowedOrigins: [issuer], label: 'Organization sign-in' },
  } });
  owned.push(runtime);
  const activations = {} as Record<'a' | 'b', string>;
  for (const suffix of ['a', 'b'] as const) {
    const activation = await runtime.bridge.establish(`inst-${suffix}`, {
      access_token: `sensitive-upstream-token-${suffix}`, token_type: 'Bearer', scope: 'patient/Patient.rs', expires_in: 3600, patient: `private-patient-${suffix}`,
    }, `https://ehr-${suffix}.example/oauth/token`, 'gateway', 'interactive');
    activations[suffix] = activation.id;
    await repo.put('cds_services', { id: `cds-${suffix}`, installationId: `inst-${suffix}`, title: `Hook ${suffix.toUpperCase()}`, hook: 'patient-view', description: '', enabled: true, handlerUrl: `https://handler-${suffix}.example/cds`, callerIssuer: `https://caller-${suffix}.example`, callerJwksUrl: `https://caller-${suffix}.example/keys`, handlerSecretRef: `handler-secret-${suffix}`, allowedOrigins: [`https://handler-${suffix}.example`, `https://caller-${suffix}.example`], createdAt });
  }
  await runtime.app.ready();
  return { runtime, repo, graph, users, headers, activations };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
async function request(f: Fixture, user: keyof Fixture['users'], method: HTTPMethods, url: string, payload?: unknown) {
  return f.runtime.app.inject({ method, url, headers: f.headers[user], ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}
async function dashboard(f: Fixture, user: keyof Fixture['users']) {
  const response = await request(f, user, 'GET', '/api/admin/dashboard');
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Dashboard>();
}
function installationPayload(overrides: Record<string, unknown> = {}) {
  return { name: 'New integration', applicationId: 'app-a', tenantId: 'org-a', connectionId: 'conn-a', registrationId: 'reg-a', appRegistrationId: 'parent-a', scopes: ['patient/Patient.rs'], ...overrides };
}

describe('production administrative resource permissions', () => {
  it('does not expose an administrative identity or configuration to a registered clinical application origin', async () => {
    const f = await setup();
    for (const url of ['/api/admin/session', '/api/admin/dashboard']) {
      const response = await f.runtime.app.inject({ url, headers: { ...f.headers.owner, origin: 'https://app-a.example' } });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.body).not.toContain(f.users.owner.displayName);
      expect(response.body).not.toContain(f.users.owner.subject);
      expect(response.body).not.toContain('identity');
    }
  });

  it('isolates disjoint administrators across dashboards, lists, worksheets, CDS hooks and shared parent associations', async () => {
    const f = await setup();
    for (const suffix of ['a', 'b'] as const) {
      const other = suffix === 'a' ? 'b' : 'a';
      const data = await dashboard(f, suffix);
      expect(data.tenants.map(row => row.id)).toEqual([`org-${suffix}`]);
      expect(data.applications.map(row => row.id)).toEqual([`app-${suffix}`]);
      expect(data.connections.map(row => row.id)).toEqual([`conn-${suffix}`]);
      expect(new Set(data.installations.map(row => row.id))).toEqual(new Set([`inst-${suffix}`, `inst-shared-${suffix}`]));
      expect(data.activations.map(row => row.id)).toEqual([f.activations[suffix]]);
      expect(data.events.every(event => event.tenantId === `org-${suffix}` || event.installationId === `inst-${suffix}`)).toBe(true);
      expect(JSON.stringify(data)).not.toContain(`private-patient-${suffix}`);
      expect(JSON.stringify(data)).not.toContain('sensitive-upstream-token');
      expect(JSON.stringify(data)).not.toContain(`app-${other}`);
      const shared = data.appRegistrations.find(parent => parent.id === 'parent-shared')!;
      expect(shared.applicationIds).toEqual([`app-${suffix}`]);
      if (suffix === 'a') {
        expect(new Set(data.registrations.map(row => row.id))).toEqual(new Set(['reg-a', 'reg-shared']));
        expect(shared.clientRegistrationIds).toEqual(['reg-shared']);
      }
      for (const url of ['/api/admin/registrations', '/api/admin/app-registrations', '/api/admin/cds-services']) {
        const response = await request(f, suffix, 'GET', url);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).not.toContain(`app-${other}`);
        expect(response.body).not.toContain(`inst-${other}`);
        expect(response.body).not.toContain(`reg-${other}`);
      }
      const ownWorksheet = await request(f, suffix, 'GET', `/api/admin/installations/inst-${suffix}/worksheet`);
      expect(ownWorksheet.statusCode, ownWorksheet.body).toBe(200);
      const foreignWorksheet = await request(f, suffix, 'GET', `/api/admin/installations/inst-${other}/worksheet`);
      expect([403, 404]).toContain(foreignWorksheet.statusCode);
      expect(foreignWorksheet.body).not.toContain(`upstream-client-${other}`);
      const foreignParent = await request(f, suffix, 'GET', `/api/admin/app-registrations/parent-${other}`);
      expect([403, 404]).toContain(foreignParent.statusCode);
    }
  });

  it('permits an assigned operator to update configuration and attributes audit events to the named user', async () => {
    const f = await setup();
    const response = await request(f, 'a', 'PATCH', '/api/admin/applications/app-a', { name: 'Operator-managed application' });
    expect(response.statusCode, response.body).toBe(200);
    expect(await f.repo.get('applications', 'app-a')).toMatchObject({ name: 'Operator-managed application' });
    const installed = await request(f, 'a', 'POST', '/api/admin/installations', installationPayload());
    expect(installed.statusCode, installed.body).toBe(201);
    const event = (await f.repo.list<{ action: string; actor?: unknown }>('events')).find(row => row.action === 'application.updated');
    expect(event?.actor).toMatchObject({ id: f.users.a.id, displayName: f.users.a.displayName, kind: 'oidc', role: 'integration_admin' });
  });

  it('filters audit targets by application visibility even when the organization is assigned', async () => {
    const f = await setup();
    const connection: Connection = { ...f.graph.connections[1]!, id: 'conn-same-org-hidden', tenantId: 'org-a' };
    const installation: Installation = { ...f.graph.installations.find(row => row.id === 'inst-b')!, id: 'inst-same-org-hidden', tenantId: 'org-a', connectionId: connection.id };
    await f.repo.put('connections', connection);
    await f.repo.put('installations', installation);
    vi.spyOn(f.runtime.bridge, 'discover').mockResolvedValue({ token_endpoint: 'https://ehr-b.example/oauth/token' });
    const verification = await request(f, 'owner', 'POST', `/api/admin/connections/${connection.id}/verify`, { registrationId: 'reg-b' });
    expect(verification.statusCode, verification.body).toBe(200);
    const owner = await dashboard(f, 'owner');
    expect(owner.events).toContainEqual(expect.objectContaining({ action: 'connection.verified', tenantId: 'org-a', resource: { type: 'connections', id: connection.id } }));
    const scoped = await dashboard(f, 'a');
    expect(scoped.connections.map(row => row.id)).not.toContain(connection.id);
    expect(JSON.stringify(scoped.events)).not.toContain(connection.id);
  });

  it('binds concurrent configuration audit events to each request user and target', async () => {
    const f = await setup();
    const responses = await Promise.all((['a', 'b'] as const).map(user => request(f, user, 'PATCH', `/api/admin/applications/app-${user}`, { name: `Updated by operator ${user}` })));
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    const events = (await f.repo.list<{ action: string; resource?: { id: string }; actor?: { id: string } }>('events')).filter(row => row.action === 'application.updated');
    expect(events).toHaveLength(2);
    for (const user of ['a', 'b'] as const) expect(events.find(row => row.resource?.id === `app-${user}`)?.actor?.id).toBe(f.users[user].id);
  });

  it('rejects cross-organization/application mutation and cross-binding before changes or network access occur', async () => {
    const f = await setup();
    const discover = vi.spyOn(f.runtime.bridge, 'discover').mockRejectedValue(new Error('A denied request must never reach discovery'));
    const before = await f.repo.list('installations');
    const attempts: [HTTPMethods, string, unknown][] = [
      ['PATCH', '/api/admin/applications/app-b', { name: 'Unauthorized rename' }],
      ['PATCH', '/api/admin/tenants/org-b', { name: 'Unauthorized organization' }],
      ['PATCH', '/api/admin/installations/inst-b', { enabled: false }],
      ['POST', '/api/admin/applications/app-b/credentials', {}],
      ['POST', '/api/admin/connections/conn-b/verify', { registrationId: 'reg-b' }],
      ['POST', '/api/admin/connections/conn-a/verify', { registrationId: 'reg-b' }],
      ['POST', `/api/admin/activations/${f.activations.b}/close`, {}],
      ['POST', '/api/admin/installations', installationPayload({ applicationId: 'app-b' })],
      ['POST', '/api/admin/installations', installationPayload({ tenantId: 'org-b', connectionId: 'conn-b' })],
      ['POST', '/api/admin/installations', installationPayload({ connectionId: 'conn-b' })],
      ['POST', '/api/admin/installations', installationPayload({ registrationId: 'reg-b' })],
      ['POST', '/api/admin/app-registrations', { name: 'Unauthorized association', platformId: 'platform_generic', applicationIds: ['app-b'] }],
      ['POST', '/api/admin/connections', { tenantId: 'org-b', name: 'Unauthorized endpoint', platformId: 'platform_generic', fhirBaseUrl: 'https://new-ehr.example/FHIR/R4' }],
      ['POST', '/api/admin/cds-services', { installationId: 'inst-b', hook: 'patient-view', title: 'Unauthorized hook', description: 'Description', handlerUrl: 'https://handler.example/cds', callerIssuer: 'https://caller.example', callerJwksUrl: 'https://caller.example/keys' }],
    ];
    for (const [method, url, payload] of attempts) {
      const response = await request(f, 'a', method, url, payload);
      expect([403, 404], `${method} ${url}: ${response.body}`).toContain(response.statusCode);
    }
    expect(discover).not.toHaveBeenCalled();
    expect(await f.repo.list('installations')).toEqual(before);
    expect(await f.repo.get('applications', 'app-b')).toEqual(f.graph.applications[1]);
    expect((await f.runtime.bridge.activation(f.activations.b)).status).toBe('ready');
    expect(await f.runtime.bridge.vault.get('application-key:app-b')).toBeUndefined();
  });

  it('keeps a partially authorized shared registration read-only, including its client-creation endpoint', async () => {
    const f = await setup();
    const shared = await f.repo.get('app_registrations', 'parent-shared');
    const registrations = await f.repo.list('registrations');
    for (const [method, url, payload] of [
      ['PATCH', '/api/admin/app-registrations/parent-shared', { name: 'Would affect other tenants' }],
      ['PATCH', '/api/admin/app-registrations/parent-shared', { applicationIds: ['app-a'] }],
      ['POST', '/api/admin/app-registrations/parent-shared/clients', { name: 'Unauthorized client', clientId: 'new-client' }],
    ] as const) {
      const response = await request(f, 'a', method, url, payload);
      expect([403, 404], response.body).toContain(response.statusCode);
    }
    expect(await f.repo.get('app_registrations', 'parent-shared')).toEqual(shared);
    expect(await f.repo.list('registrations')).toEqual(registrations);
    const owner = await request(f, 'owner', 'PATCH', '/api/admin/app-registrations/parent-shared', { name: 'Platform-managed shared registration' });
    expect(owner.statusCode, owner.body).toBe(200);
  });

  it('cannot bind read-only shared credentials to a newly controlled upstream connection', async () => {
    const f = await setup();
    const shared = f.graph.registrations.find(row => row.id === 'reg-shared')!;
    await f.repo.put('registrations', { ...shared, authMethod: 'client_secret_post', secretRef: 'shared-upstream-secret' });
    await f.runtime.bridge.vault.set('shared-upstream-secret', 'shared-credential-must-stay-with-approved-upstreams');
    const response = await request(f, 'a', 'POST', '/api/admin/connections', {
      tenantId: 'org-a', name: 'Operator-controlled public endpoint', platformId: 'platform_generic',
      fhirBaseUrl: 'https://operator-controlled.example/FHIR/R4', allowedOrigins: ['https://operator-controlled.example'],
    });
    expect(response.statusCode, response.body).toBe(201);
    const connection = response.json<Connection>();
    const before = await f.repo.list('installations');
    const binding = await request(f, 'a', 'POST', '/api/admin/installations', installationPayload({
      connectionId: connection.id, registrationId: 'reg-shared', appRegistrationId: 'parent-shared',
    }));
    expect([403, 404], binding.body).toContain(binding.statusCode);
    expect(await f.repo.list('installations')).toEqual(before);
    expect(binding.body).not.toContain('shared-credential-must-stay-with-approved-upstreams');
  });

  it('makes viewers read-only across metadata, credentials, discovery, lifecycle and user administration', async () => {
    const f = await setup();
    expect((await dashboard(f, 'viewer')).access).toMatchObject({ canWrite: false, platformAdmin: false });
    const attempts: [HTTPMethods, string, unknown][] = [
      ['POST', '/api/admin/applications', { name: 'Viewer-created app' }],
      ['POST', '/api/admin/tenants', { name: 'Viewer-created organization' }],
      ['POST', '/api/admin/platforms', { name: 'Viewer-created platform' }],
      ['PATCH', '/api/admin/applications/app-a', { name: 'Viewer rename' }],
      ['PATCH', '/api/admin/tenants/org-a', { name: 'Viewer organization' }],
      ['PATCH', '/api/admin/installations/inst-a', { enabled: false }],
      ['POST', '/api/admin/applications/app-a/credentials', {}],
      ['POST', '/api/admin/connections/conn-a/verify', {}],
      ['POST', `/api/admin/activations/${f.activations.a}/close`, {}],
      ['POST', '/api/admin/installations', installationPayload()],
      ['POST', '/api/admin/app-registrations/parent-a/clients', { name: 'Viewer client', clientId: 'new-viewer-client' }],
      ['PATCH', `/api/admin/users/${f.users.a.id}`, { role: 'platform_admin' }],
    ];
    for (const [method, url, payload] of attempts) {
      const response = await request(f, 'viewer', method, url, payload);
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(403);
    }
    expect((await request(f, 'viewer', 'GET', '/api/admin/installations/inst-a/worksheet')).statusCode).toBe(200);
    expect((await f.runtime.bridge.activation(f.activations.a)).status).toBe('ready');
  });

  it('resolves changed assignments and disablement on existing sessions without requiring a fresh login', async () => {
    const f = await setup();
    expect((await dashboard(f, 'a')).tenants.map(row => row.id)).toEqual(['org-a']);
    const change = await request(f, 'owner', 'PATCH', `/api/admin/users/${f.users.a.id}`, { organizationIds: ['org-b'], applicationIds: ['app-b'] });
    expect(change.statusCode, change.body).toBe(200);
    const changed = await dashboard(f, 'a');
    expect(changed.tenants.map(row => row.id)).toEqual(['org-b']);
    expect(changed.applications.map(row => row.id)).toEqual(['app-b']);
    expect([403, 404]).toContain((await request(f, 'a', 'GET', '/api/admin/installations/inst-a/worksheet')).statusCode);
    const disable = await request(f, 'owner', 'PATCH', `/api/admin/users/${f.users.a.id}`, { disabled: true });
    expect(disable.statusCode, disable.body).toBe(200);
    expect((await request(f, 'a', 'GET', '/api/admin/dashboard')).statusCode).toBe(401);
    expect((await request(f, 'a', 'GET', '/api/admin/session')).json()).toMatchObject({ authenticated: false });
  });

  it('requires organization and application assignments together for integration and activation visibility', async () => {
    const f = await setup();
    const change = await request(f, 'owner', 'PATCH', `/api/admin/users/${f.users.a.id}`, { organizationIds: ['org-a'], applicationIds: ['app-b'] });
    expect(change.statusCode, change.body).toBe(200);
    const data = await dashboard(f, 'a');
    // Both metadata assignments are valid, but no existing installation satisfies both axes.
    expect(data.tenants.map(row => row.id)).toEqual(['org-a']);
    expect(data.applications.map(row => row.id)).toEqual(['app-b']);
    expect(data.installations).toEqual([]);
    expect(data.activations).toEqual([]);
    expect(data.connections).toEqual([]);
    expect(data.registrations).toEqual([]);
    expect((await request(f, 'a', 'GET', '/api/admin/cds-services')).json()).toEqual([]);
    for (const suffix of ['a', 'b']) {
      const worksheet = await request(f, 'a', 'GET', `/api/admin/installations/inst-${suffix}/worksheet`);
      expect([403, 404]).toContain(worksheet.statusCode);
    }
  });

  it('restricts user management to platform administrators, rejects duplicate identities and invalid assignments', async () => {
    const f = await setup();
    for (const user of ['a', 'b', 'viewer'] as const) {
      expect((await request(f, user, 'GET', '/api/admin/users')).statusCode).toBe(403);
      expect((await request(f, user, 'POST', '/api/admin/users', { issuer, subject: 'escalation', displayName: 'Escalation', role: 'platform_admin', organizationIds: [], applicationIds: [] })).statusCode).toBe(403);
    }
    const users = await request(f, 'owner', 'GET', '/api/admin/users');
    expect(users.statusCode, users.body).toBe(200);
    expect(users.json<AdminUser[]>().map(user => user.id).sort()).toEqual(Object.values(f.users).map(user => user.id).sort());
    const input = { issuer, subject: 'new-reviewer', displayName: 'New reviewer', role: 'viewer', organizationIds: ['org-a'], applicationIds: ['app-a'] };
    const create = await request(f, 'owner', 'POST', '/api/admin/users', input);
    expect(create.statusCode, create.body).toBe(201);
    expect(create.json()).toMatchObject(input);
    const duplicate = await request(f, 'owner', 'POST', '/api/admin/users', { ...input, displayName: 'Same external identity' });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    const before = await f.repo.list('admin_users');
    for (const bad of [{ organizationIds: ['org-missing'] }, { applicationIds: ['app-missing'] }]) {
      const result = await request(f, 'owner', 'POST', '/api/admin/users', { ...input, subject: 'invalid-assignment', ...bad });
      expect(result.statusCode, result.body).toBeGreaterThanOrEqual(400);
      expect(result.statusCode, result.body).toBeLessThan(500);
    }
    expect(await f.repo.list('admin_users')).toEqual(before);
  });

  it('protects the last enabled platform administrator while allowing a second owner to be provisioned', async () => {
    const f = await setup();
    for (const patch of [{ disabled: true }, { role: 'viewer', organizationIds: ['org-a'], applicationIds: ['app-a'] }]) {
      const response = await request(f, 'owner', 'PATCH', `/api/admin/users/${f.users.owner.id}`, patch);
      expect(response.statusCode, response.body).toBe(409);
    }
    expect(await f.repo.get('admin_users', f.users.owner.id)).toEqual(f.users.owner);
    const second = await request(f, 'owner', 'POST', '/api/admin/users', { issuer, subject: 'second-owner', displayName: 'Second owner', role: 'platform_admin', organizationIds: [], applicationIds: [] });
    expect(second.statusCode, second.body).toBe(201);
    const disabled = await request(f, 'owner', 'PATCH', `/api/admin/users/${f.users.owner.id}`, { disabled: true });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect((await request(f, 'owner', 'GET', '/api/admin/users')).statusCode).toBe(401);
  });
});
