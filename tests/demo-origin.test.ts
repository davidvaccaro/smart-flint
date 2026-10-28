import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application, Connection, Tenant } from '../packages/contracts/src/index.js';
import { openRepository, type Repository } from '../packages/storage/src/index.js';
import { Bridge } from '../apps/server/src/bridge.js';
import { loadConfig } from '../apps/server/src/config.js';
import { seedDemo } from '../apps/server/src/seed.js';

const key = Buffer.alloc(32, 7).toString('base64');
const owned: { bridge: Bridge; repo: Repository }[] = [];

function localDefaults() {
  for (const name of ['BASE_URL', 'CONSOLE_URL', 'MOCK_EHR_URL', 'HOST', 'PORT']) vi.stubEnv(name, undefined);
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DEMO_MODE', 'true');
}

async function legacyWorkspace(consoleUrl = 'http://localhost:3000') {
  const repo = await openRepository({ sqlitePath: ':memory:' });
  const bridge = new Bridge(repo, loadConfig({
    demo: true, encryptionKey: key, databaseUrl: undefined, sqlitePath: ':memory:',
    baseUrl: 'http://localhost:3001', consoleUrl, mockEhrUrl: 'http://localhost:4010',
  }));
  owned.push({ bridge, repo });
  await seedDemo(bridge);
  return { bridge, repo };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const { bridge, repo } of owned.splice(0)) { await bridge.http.close(); await repo.close(); }
});

describe('canonical local demo origins', () => {
  it('uses one explicit loopback address for the console, API, and synthetic EHR', () => {
    localDefaults();
    const config = loadConfig({ demo: true, encryptionKey: key });
    expect(config.host).toBe('127.0.0.1');
    expect(config.consoleUrl).toBe('http://127.0.0.1:3010');
    expect(config.baseUrl).toBe('http://127.0.0.1:3001');
    expect(config.mockEhrUrl).toBe('http://127.0.0.1:4010');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000'])('upgrades an existing synthetic workspace from %s while preserving developer-owned configuration', async legacyConsoleUrl => {
    const { bridge, repo } = await legacyWorkspace(legacyConsoleUrl);
    const clinical = (await repo.get<Application>('applications', 'app_clinical'))!;
    clinical.callbackUrls.push('https://developer.example/smart/callback');
    await repo.put('applications', clinical);
    const northstar = (await repo.get<Connection>('connections', 'conn_northstar'))!;
    northstar.allowedOrigins.push('https://approved-auth.example');
    await repo.put('connections', northstar);

    const createdAt = '2026-10-24T00:00:00.000Z';
    const customApp: Application = {
      id: 'app_developer', name: 'Developer app', description: 'User-managed integration',
      callbackUrls: [`${legacyConsoleUrl}/reference-app`, 'http://localhost:3000/custom-callback', 'https://developer.example/callback'],
      requiredContext: [], requiredScopes: [], allowedModes: ['direct'], createdAt,
    };
    const tenant: Tenant = { id: 'tenant_developer', name: 'Developer organization', slug: 'developer', createdAt };
    const customConnection: Connection = {
      id: 'conn_developer', tenantId: tenant.id, name: 'User-managed upstream', vendor: 'generic',
      fhirBaseUrl: 'https://ehr.developer.example/fhir/r4', environment: 'production', fhirVersion: '4.0.1',
      allowedOrigins: ['https://ehr.developer.example', 'https://auth.developer.example'], status: 'verified', createdAt,
    };
    await repo.put('applications', customApp);
    await repo.put('tenants', tenant);
    await repo.put('connections', customConnection);
    // A user can also repurpose an originally synthetic connection; HTTPS configuration must survive.
    const customizedHarbor = { ...(await repo.get<Connection>('connections', 'conn_harbor'))!, fhirBaseUrl: 'https://custom-harbor.example/fhir/r4', allowedOrigins: ['https://custom-harbor.example'] };
    await repo.put('connections', customizedHarbor);

    bridge.config.baseUrl = 'http://127.0.0.1:3001';
    bridge.config.consoleUrl = 'http://127.0.0.1:3010';
    bridge.config.mockEhrUrl = 'http://127.0.0.1:4010';
    await seedDemo(bridge);

    const migrated = (await repo.get<Application>('applications', 'app_clinical'))!;
    expect(migrated.callbackUrls).toEqual(['http://127.0.0.1:3010/reference-app', 'https://developer.example/smart/callback']);
    expect(await repo.get('applications', customApp.id)).toEqual(customApp);
    expect(await repo.get('connections', customConnection.id)).toEqual(customConnection);
    expect(await repo.get('connections', customizedHarbor.id)).toEqual(customizedHarbor);
    const migratedNorthstar = (await repo.get<Connection>('connections', 'conn_northstar'))!;
    expect(migratedNorthstar.fhirBaseUrl).toBe('http://127.0.0.1:4010/epic/northstar/r4');
    expect(migratedNorthstar.allowedOrigins).toEqual(['http://127.0.0.1:4010', 'https://approved-auth.example']);
    expect((await repo.get<Connection>('connections', 'conn_lakeside'))?.fhirBaseUrl).toBe('http://127.0.0.1:4010/oracle/lakeside/r4');

    // Reopening the workspace must not accumulate callback aliases or modify the custom app.
    await seedDemo(bridge);
    expect(await repo.get('applications', migrated.id)).toEqual(migrated);
    expect(await repo.get('connections', migratedNorthstar.id)).toEqual(migratedNorthstar);
    expect((await repo.list('applications')).length).toBe(3);
  });

  it('never migrates or seeds records when demo mode is disabled', async () => {
    const { bridge, repo } = await legacyWorkspace();
    const snapshot = async () => Promise.all(['applications', 'connections', 'installations', 'events', 'secrets'].map(collection => repo.list(collection)));
    const before = await snapshot();
    bridge.config.demo = false;
    bridge.config.consoleUrl = 'https://console.production.example';
    bridge.config.mockEhrUrl = 'http://127.0.0.1:4010';
    await seedDemo(bridge);
    expect(await snapshot()).toEqual(before);
  });
});
