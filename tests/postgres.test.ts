import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openRepository, randomId, type Repository } from '../packages/storage/src/index.js';
import { Bridge } from '../apps/server/src/bridge.js';
import type { Config } from '../apps/server/src/config.js';
import type { Application, Connection, Installation, Registration, Tenant } from '../packages/contracts/src/index.js';

// Use an isolated development database. The test removes only its own random IDs.
const databaseUrl = process.env.SMART_FLINT_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL repository integration', () => {
  let first: Repository;
  let second: Repository;
  const consumedId = randomId('test');
  const grantId = randomId('test');

  beforeAll(async () => {
    first = await openRepository({ databaseUrl });
    second = await openRepository({ databaseUrl });
  });

  afterAll(async () => {
    if (first) {
      await first.delete('handoffs', consumedId);
      await first.delete('grants', grantId);
      await first.close();
    }
    if (second) await second.close();
  });

  it('allows exactly one of two independent pools to consume a handoff', async () => {
    await first.put('handoffs', { id: consumedId, applicationId: 'test-app' });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? first : second).consume('handoffs', consumedId)));
    expect(results.filter(Boolean)).toEqual([{ id: consumedId, applicationId: 'test-app' }]);
  });

  it('serializes grant changes across independent pools and rolls back failed changes', async () => {
    await first.put('grants', { id: grantId, generation: 0 });
    await Promise.all(Array.from({ length: 10 }, (_, index) => {
      const repo = index % 2 ? first : second;
      return repo.withLock(grantId, async () => {
        const grant = await repo.get<{ id: string; generation: number }>('grants', grantId);
        await repo.put('grants', { id: grantId, generation: grant!.generation + 1 });
      });
    }));
    expect(await first.get('grants', grantId)).toEqual({ id: grantId, generation: 10 });
    await expect(first.withLock(grantId, async () => {
      await first.put('grants', { id: grantId, generation: 99 });
      throw new Error('abort test transaction');
    })).rejects.toThrow('abort test transaction');
    expect(await second.get('grants', grantId)).toEqual({ id: grantId, generation: 10 });
  });

  it('commits reauthorization state before surfacing a refresh failure outside the locked transaction', async () => {
    const suffix = randomId('test');
    const tenantId = `tenant_${suffix}`, applicationId = `app_${suffix}`, connectionId = `conn_${suffix}`;
    const registrationId = `reg_${suffix}`, installationId = `inst_${suffix}`;
    const createdAt = new Date().toISOString();
    const config: Config = {
      port: 3001, host: '127.0.0.1', baseUrl: 'https://bridge.test.example', consoleUrl: 'https://bridge.test.example',
      demo: false, adminToken: 'postgres-integration-test-administrator-placeholder', encryptionKey: randomBytes(32).toString('base64'),
      databaseUrl, sqlitePath: ':memory:', allowPrivateNetworks: false, mockEhrUrl: 'http://localhost:4010', secureCookies: true, retentionHours: 24,
    };
    const bridge = new Bridge(first, config);
    const observer = new Bridge(second, config);
    let activationId: string | undefined;
    try {
      await first.put<Tenant>('tenants', { id: tenantId, name: 'PostgreSQL integration fixture', slug: suffix, createdAt });
      await first.put<Application>('applications', { id: applicationId, name: 'Refresh failure fixture', description: '', callbackUrls: [], requiredContext: ['patient'], requiredScopes: ['patient/Patient.rs'], allowedModes: ['gateway'], createdAt });
      await first.put<Connection>('connections', { id: connectionId, tenantId, name: 'No-network fixture', vendor: 'generic', fhirBaseUrl: 'https://ehr.test.example/fhir', environment: 'sandbox', fhirVersion: '4.0.1', allowedOrigins: ['https://ehr.test.example'], status: 'unverified', createdAt });
      await first.put<Registration>('registrations', { id: registrationId, name: 'Public test registration', vendor: 'generic', clientId: 'fixture-client', authMethod: 'none', createdAt });
      await first.put<Installation>('installations', { id: installationId, name: 'Refresh test', applicationId, tenantId, connectionId, registrationId, mode: 'gateway', enabled: true, scopes: ['patient/Patient.rs'], allowTokenExport: false, normalizationProfile: 'passthrough', createdAt });
      const activation = await bridge.establish(installationId, {
        access_token: 'synthetic-expiring-access-token', refresh_token: 'synthetic-invalid-refresh-token',
        token_type: 'Bearer', scope: 'patient/Patient.rs', patient: 'synthetic-patient', expires_in: 1,
      }, 'https://ehr.test.example/oauth/token', 'gateway', 'interactive');
      activationId = activation.id;
      const renewal = vi.spyOn(bridge, 'tokenRequest').mockRejectedValue(new Error('Simulated upstream refresh denial'));
      await expect(bridge.currentToken(activation.id)).rejects.toMatchObject({ status: 401, code: 'reauthorization_required' });
      expect(renewal).toHaveBeenCalledTimes(1);
      expect((await observer.activation(activation.id)).status).toBe('reauthorization_required');
      expect(await second.get('activations', activation.id)).toMatchObject({ status: 'reauthorization_required' });
      const events = (await second.list<{ id: string; activationId?: string; action: string }>('events')).filter(event => event.activationId === activation.id);
      expect(events.some(event => event.action === 'grant.reauthorization_required')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('synthetic-invalid-refresh-token');
    } finally {
      await bridge.http.close(); await observer.http.close();
      if (activationId) {
        await bridge.vault.delete(`activation:${activationId}`); await bridge.vault.delete(`grant:${activationId}`);
        await first.delete('activations', activationId); await first.delete('grants', activationId);
        for (const event of await first.list<{ id: string; activationId?: string }>('events')) if (event.activationId === activationId) await first.delete('events', event.id);
      }
      for (const [collection, id] of [['installations', installationId], ['registrations', registrationId], ['connections', connectionId], ['applications', applicationId], ['tenants', tenantId]]) await first.delete(collection!, id!);
    }
  });
});
