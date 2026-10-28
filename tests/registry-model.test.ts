import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/server/src/app.js';
import { migrateRegistry } from '../apps/server/src/registry.js';
import { seedDemo } from '../apps/server/src/seed.js';
import { seedSamples } from '../apps/server/src/sample-seed.js';
import { openRepository, type Repository } from '../packages/storage/src/index.js';
import type { AppRegistration, Application, Connection, Dashboard, EHRPlatform, Installation, Registration, Tenant } from '../packages/contracts/src/index.js';

const owned: { instance: Awaited<ReturnType<typeof buildApp>>; repo: Repository }[] = [];
const adminToken = 'registry-model-admin-credential-for-testing';
async function setup(seed = true, demo = true, repository?: Repository) {
  const repo = repository ?? await openRepository({ sqlitePath: ':memory:' });
  const instance = await buildApp({ repository: repo, seed, serveConsole: false, config: {
    demo, baseUrl: demo ? 'http://localhost:3001' : 'https://bridge.example',
    consoleUrl: demo ? 'http://localhost:3010' : 'https://bridge.example',
    host: '127.0.0.1', encryptionKey: Buffer.alloc(32, 9).toString('base64'), adminToken, adminBootstrapEnabled: true,
    sqlitePath: ':memory:', databaseUrl: undefined, mockEhrUrl: 'http://localhost:4010',
  } });
  await instance.app.ready(); owned.push({ instance, repo });
  const headers = { authorization: `Bearer ${adminToken}` };
  return { ...instance, repo, headers };
}
afterEach(async () => {
  for (const { instance, repo } of owned.splice(0)) { await instance.app.close(); await repo.close(); }
});

async function registrySnapshot(repo: Repository) {
  const names = ['platforms', 'app_registrations', 'tenants', 'applications', 'connections', 'registrations', 'installations', 'secrets'];
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await repo.list(name)])));
}

describe('additive registry migration', () => {
  it('preserves shared cross-platform and cross-app clients, IDs, URLs, scopes and encrypted credentials', async () => {
    const { bridge, repo } = await setup(false);
    await seedDemo(bridge); await seedSamples(bridge);
    const unused: Registration = { id: 'reg_unused', name: 'Unassigned Epic portal client', vendor: 'epic', clientId: 'keep-client-id', authMethod: 'client_secret_basic', secretRef: 'existing-vault-ref', createdAt: '2024-01-01T00:00:00.000Z' };
    await repo.put('registrations', unused); await bridge.vault.set(unused.secretRef!, 'credential-canary');
    const before = await registrySnapshot(repo);
    await migrateRegistry(repo);
    const after = await registrySnapshot(repo);
    for (const collection of ['tenants', 'applications', 'secrets']) expect(after[collection]).toEqual(before[collection]);
    for (const collection of ['connections', 'registrations', 'installations']) {
      const originals = before[collection] as { id: string }[];
      const migrated = after[collection] as { id: string }[];
      expect(migrated.map(row => row.id)).toEqual(originals.map(row => row.id));
      for (const original of originals) expect(migrated.find(row => row.id === original.id)).toMatchObject(original);
    }
    expect(await bridge.vault.get(unused.secretRef!)).toBe('credential-canary');
    const parents = await repo.list<AppRegistration>('app_registrations');
    expect(parents).toHaveLength(9);
    const shared = parents.find(parent => parent.platformId === 'platform_epic' && parent.clientRegistrationIds.includes('reg_service'))!;
    expect(new Set(shared.applicationIds)).toEqual(new Set(['app_service', 'app_health_service']));
    expect(parents.filter(parent => parent.clientRegistrationIds.includes('reg_service')).map(parent => parent.platformId).sort()).toEqual(['platform_epic', 'platform_meditech', 'platform_oracle']);
    expect(parents.filter(parent => parent.clientRegistrationIds.includes('reg_demo'))).toHaveLength(2);
    expect(parents.filter(parent => parent.clientRegistrationIds.includes('reg_health_patient'))).toHaveLength(3);
    const unassigned = parents.find(parent => parent.clientRegistrationIds.includes(unused.id))!;
    expect(unassigned.applicationIds).toEqual([]); expect(unassigned.platformId).toBe('platform_epic');
    expect(parents.every(parent => parent.audience === 'unspecified')).toBe(true);
    expect((await repo.list<Registration>('registrations')).every(client => client.environment === 'unspecified')).toBe(true);
    expect((await repo.get<Registration>('registrations', 'reg_service'))?.platformId).toBeUndefined();
    for (const installation of await repo.list<Installation>('installations')) {
      expect(installation.appRegistrationId).toBeTruthy();
      const binding = await bridge.installation(installation.id, false);
      expect(binding.appRegistration?.applicationIds).toContain(installation.applicationId);
    }
    await migrateRegistry(repo); expect(await registrySnapshot(repo)).toEqual(after);
  });

  it('retains a custom platform association and operator-edited catalog metadata across startup migrations', async () => {
    const { bridge, repo } = await setup(false);
    await seedDemo(bridge);
    const platform: EHRPlatform = { id: 'platform_custom_epic', name: 'Regional Epic program', vendor: 'epic', description: 'Operator metadata', createdAt: '2025-01-01T00:00:00Z' };
    await repo.put('platforms', platform);
    const connection = await repo.get<Connection>('connections', 'conn_northstar');
    await repo.put('connections', { ...connection!, platformId: platform.id });
    await migrateRegistry(repo);
    expect((await repo.get<Connection>('connections', 'conn_northstar'))?.platformId).toBe(platform.id);
    expect((await bridge.installation('inst_northstar')).appRegistration?.platformId).toBe(platform.id);
    const epic = await repo.get<EHRPlatform>('platforms', 'platform_epic');
    await repo.put('platforms', { ...epic!, name: 'Epic managed by integration team' });
    await migrateRegistry(repo);
    expect(await repo.get('platforms', platform.id)).toEqual(platform);
    expect((await repo.get<EHRPlatform>('platforms', 'platform_epic'))?.name).toBe('Epic managed by integration team');
  });

  it('initializes only platform metadata in a fresh production deployment', async () => {
    const { repo, app, headers } = await setup(true, false);
    const dashboard = (await app.inject({ url: '/api/admin/dashboard', headers })).json<Dashboard>();
    expect(dashboard.platforms).toHaveLength(4);
    for (const collection of ['tenants', 'applications', 'connections', 'registrations', 'app_registrations', 'installations', 'cds_services']) expect(await repo.list(collection)).toEqual([]);
    expect(dashboard.runtime.samples).toBeUndefined();
  });

  it('migrates an existing production registry without inserting sample applications or replacing its launch binding', async () => {
    const repo = await openRepository({ sqlitePath: ':memory:' });
    const createdAt = '2023-05-04T00:00:00Z';
    const tenant: Tenant = { id: 'tenant_existing', name: 'Existing hospital', slug: 'existing', createdAt };
    const application: Application = { id: 'app_existing', name: 'Existing app', description: '', callbackUrls: ['https://patient.example/callback'], requiredContext: ['patient'], requiredScopes: [], allowedModes: ['gateway'], createdAt };
    const connection: Connection = { id: 'conn_existing', tenantId: tenant.id, name: 'Epic production', vendor: 'epic', fhirBaseUrl: 'https://ehr.example/FHIR/R4', environment: 'production', fhirVersion: '4.0.1', allowedOrigins: ['https://ehr.example'], status: 'unverified', createdAt };
    const registration: Registration = { id: 'reg_existing', name: 'Existing public client', vendor: 'epic', clientId: 'original-client-id', authMethod: 'none', createdAt };
    const installation: Installation = { id: 'inst_existing', name: 'Existing installation', applicationId: application.id, tenantId: tenant.id, connectionId: connection.id, registrationId: registration.id, mode: 'gateway', enabled: true, scopes: ['launch/patient', 'patient/Patient.r'], allowTokenExport: false, normalizationProfile: 'passthrough', createdAt };
    await repo.put('tenants', tenant); await repo.put('applications', application); await repo.put('connections', connection); await repo.put('registrations', registration); await repo.put('installations', installation);
    const { bridge, app, headers } = await setup(true, false, repo);
    expect(await repo.list('applications')).toEqual([application]);
    expect((await bridge.installation(installation.id)).installation).toMatchObject(installation);
    const worksheet = (await app.inject({ url: `/api/admin/installations/${installation.id}/worksheet`, headers })).json();
    expect(worksheet).toMatchObject({ clientId: registration.clientId, fhirBaseUrl: connection.fhirBaseUrl, launchUrl: 'https://bridge.example/launch/inst_existing', redirectUri: 'https://bridge.example/oauth/callback/conn_existing', appCallbackUrls: application.callbackUrls, scopes: installation.scopes, clientEnvironment: 'unspecified' });
    expect(worksheet.appRegistrationId).toBeTruthy();
  });
});

describe('app-centric administrative relationships', () => {
  it('groups sandbox and production clients, validates bindings, protects referenced app associations and redacts credentials', async () => {
    const { app, repo, bridge, headers } = await setup();
    const createdApp = await app.inject({ method: 'POST', url: '/api/admin/applications', headers, payload: { name: 'Patient app', callbackUrls: ['https://patient.example/callback'] } });
    const application = createdApp.json<Application>();
    const parentResponse = await app.inject({ method: 'POST', url: '/api/admin/app-registrations', headers, payload: { name: 'Epic patient portal app', platformId: 'platform_epic', applicationIds: [application.id], audience: 'patient', portalUrl: 'https://fhir.epic.com/' } });
    expect(parentResponse.statusCode).toBe(201);
    const parent = parentResponse.json<AppRegistration>(); expect(parent.clientRegistrationIds).toEqual([]);
    const secret = 'sandbox-client-secret-canary';
    const sandbox = await app.inject({ method: 'POST', url: `/api/admin/app-registrations/${parent.id}/clients`, headers, payload: { name: 'Non-production client', clientId: 'sandbox-client', authMethod: 'client_secret_post', secret, environment: 'sandbox' } });
    expect(sandbox.statusCode).toBe(201); expect(sandbox.body).not.toContain(secret);
    const sandboxClient = sandbox.json<Registration>(); expect(sandboxClient).toMatchObject({ platformId: 'platform_epic', vendor: 'epic', environment: 'sandbox' });
    expect(await bridge.vault.get(sandboxClient.secretRef!)).toBe(secret);
    const production = await app.inject({ method: 'POST', url: `/api/admin/app-registrations/${parent.id}/clients`, headers, payload: { name: 'Production client', clientId: 'production-client', authMethod: 'private_key_jwt', environment: 'production' } });
    expect(production.statusCode).toBe(201);
    const prodClient = production.json<Registration>();
    expect(production.json().privateKey).toBeUndefined();
    const jwks = await app.inject({ url: `/.well-known/jwks/${prodClient.id}` });
    expect(jwks.json().keys[0].d).toBeUndefined();
    const linked = await repo.get<AppRegistration>('app_registrations', parent.id);
    expect(linked?.clientRegistrationIds).toEqual([sandboxClient.id, prodClient.id]);
    const input = { name: 'Patient at Northstar', applicationId: application.id, tenantId: 'tenant_northstar', connectionId: 'conn_northstar', registrationId: sandboxClient.id, appRegistrationId: parent.id, scopes: [] };
    const failures = [
      [{ ...input, applicationId: 'app_clinical', scopes: ['patient/Patient.rs', 'patient/Observation.rs'] }, 'application_mismatch'],
      [{ ...input, connectionId: 'conn_lakeside', tenantId: 'tenant_lakeside' }, 'vendor_mismatch'],
      [{ ...input, registrationId: 'reg_demo' }, 'registration_mismatch'],
      [{ ...input, registrationId: prodClient.id }, 'environment_mismatch'],
      [{ ...input, tenantId: 'tenant_harbor' }, 'tenant_mismatch'],
    ] as const;
    for (const [payload, code] of failures) {
      const response = await app.inject({ method: 'POST', url: '/api/admin/installations', headers, payload });
      expect(response.statusCode, response.body).toBe(409); expect(response.json().code).toBe(code);
    }
    const installationResponse = await app.inject({ method: 'POST', url: '/api/admin/installations', headers, payload: input });
    expect(installationResponse.statusCode).toBe(201);
    const installation = installationResponse.json<Installation>();
    expect((await bridge.installation(installation.id)).appRegistration?.id).toBe(parent.id);
    const removed = await app.inject({ method: 'PATCH', url: `/api/admin/app-registrations/${parent.id}`, headers, payload: { applicationIds: [] } });
    expect(removed.statusCode).toBe(409); expect(removed.json().code).toBe('registration_in_use');
    const renamed = await app.inject({ method: 'PATCH', url: `/api/admin/app-registrations/${parent.id}`, headers, payload: { name: 'Renamed portal app' } });
    expect(renamed.json()).toMatchObject({ name: 'Renamed portal app', applicationIds: [application.id], audience: 'patient', clientRegistrationIds: [sandboxClient.id, prodClient.id] });
    // A permissive stored extension must not become an administrative credential disclosure.
    await repo.put('registrations', { ...sandboxClient, secret: 'stored-secret-canary', privateKey: { d: 'stored-private-canary' } });
    for (const url of ['/api/admin/dashboard', '/api/admin/registrations']) {
      const response = await app.inject({ url, headers });
      for (const canary of [secret, 'stored-secret-canary', 'stored-private-canary']) expect(response.body).not.toContain(canary);
    }
    const otherParent = (await repo.list<AppRegistration>('app_registrations')).find(candidate => candidate.platformId === 'platform_oracle')!;
    await repo.put('installations', { ...installation, appRegistrationId: otherParent.id });
    await expect(bridge.installation(installation.id)).rejects.toMatchObject({ code: 'platform_mismatch' });
    const { appRegistrationId: _parentId, ...legacy } = installation;
    await repo.put('installations', legacy);
    expect((await bridge.installation(installation.id)).installation.id).toBe(installation.id);
  });

  it('keeps legacy generic OAuth-client creation and installation payloads compatible across platforms', async () => {
    const { app, bridge, headers } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/admin/registrations', headers, payload: { name: 'Legacy shared public client', clientId: 'legacy-client' } });
    expect(response.statusCode).toBe(201);
    const client = response.json<Registration>();
    const parents: string[] = [];
    for (const [tenantId, connectionId] of [['tenant_northstar', 'conn_northstar'], ['tenant_lakeside', 'conn_lakeside']]) {
      const installed = await app.inject({ method: 'POST', url: '/api/admin/installations', headers, payload: { name: 'Legacy payload', applicationId: 'app_clinical', tenantId, connectionId, registrationId: client.id, mode: 'direct', scopes: ['patient/Patient.rs', 'patient/Observation.rs'] } });
      expect(installed.statusCode, installed.body).toBe(201);
      expect(installed.json().allowTokenExport).toBe(true);
      parents.push(installed.json().appRegistrationId);
      expect((await bridge.installation(installed.json().id)).registration.clientId).toBe('legacy-client');
    }
    expect(new Set(parents).size).toBe(2);
  });

  it('validates metadata URLs and platform references and preserves unrelated fields on partial updates', async () => {
    const { app, repo, headers } = await setup();
    for (const documentationUrl of ['javascript:alert(1)', 'https://user:secret@example.com/docs']) {
      expect((await app.inject({ method: 'POST', url: '/api/admin/platforms', headers, payload: { name: 'Bad link', documentationUrl } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/admin/app-registrations', headers, payload: { name: 'Missing platform', platformId: 'missing' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/admin/app-registrations', headers, payload: { name: 'Missing app', platformId: 'platform_epic', applicationIds: ['missing'] } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/admin/connections', headers, payload: { name: 'Wrong adapter', tenantId: 'tenant_northstar', platformId: 'platform_epic', vendor: 'oracle', fhirBaseUrl: 'https://ehr.example/FHIR' } })).statusCode).toBe(409);
    const before = await repo.get<Application>('applications', 'app_health_compass');
    const renamed = await app.inject({ method: 'PATCH', url: '/api/admin/applications/app_health_compass', headers, payload: { name: 'Updated name' } });
    expect(renamed.statusCode).toBe(200); expect(renamed.json()).toEqual({ ...before, name: 'Updated name' });
    const platform = await repo.get<EHRPlatform>('platforms', 'platform_epic');
    const platformName = await app.inject({ method: 'PATCH', url: '/api/admin/platforms/platform_epic', headers, payload: { name: 'Epic configured platform' } });
    expect(platformName.json()).toEqual({ ...platform, name: 'Epic configured platform' });
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/platforms/platform_epic', headers, payload: { vendor: 'oracle' } })).statusCode).toBe(409);
    expect((await repo.get<Connection>('connections', 'conn_northstar'))?.vendor).toBe('epic');
  });
});
