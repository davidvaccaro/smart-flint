import type { Application, Connection, Installation, Registration, Tenant } from '../../../packages/contracts/src/index.js';
import { Bridge, now } from './bridge.js';

/** Synthetic configuration only; every launch and audit event is produced by actual execution. */
export async function seedDemo(bridge: Bridge): Promise<void> {
  if (!bridge.config.demo) return;
  await bridge.repo.withLock('registry:demo-seed', async () => {
    if ((await bridge.repo.list('applications')).length) {
      // Upgrade only the old built-in demo addresses. Preserve operator-created registrations.
      const clinical = await bridge.repo.get<Application>('applications', 'app_clinical');
      const legacyCallbacks = new Set(['http://localhost:3000/reference-app', 'http://127.0.0.1:3000/reference-app']);
      if (clinical?.callbackUrls.some(url => legacyCallbacks.has(url))) {
        await bridge.repo.put('applications', { ...clinical, callbackUrls: [...new Set(clinical.callbackUrls.map(url => legacyCallbacks.has(url) ? `${bridge.config.consoleUrl}/reference-app` : url))] });
      }
      for (const [id, vendor] of [['northstar', 'epic'], ['harbor', 'epic'], ['lakeside', 'oracle']] as const) {
        const connection = await bridge.repo.get<Connection>('connections', `conn_${id}`);
        const legacyBase = `http://localhost:4010/${vendor}/${id}/r4`;
        if (connection?.fhirBaseUrl === legacyBase && bridge.config.mockEhrUrl !== 'http://localhost:4010') {
          const { smartConfiguration, lastVerifiedAt, capabilities, ...original } = connection;
          await bridge.repo.put('connections', { ...original, fhirBaseUrl: `${bridge.config.mockEhrUrl}/${vendor}/${id}/r4`, allowedOrigins: [...new Set(connection.allowedOrigins.map(origin => origin === 'http://localhost:4010' ? new URL(bridge.config.mockEhrUrl).origin : origin))], status: 'unverified' });
        }
      }
      return;
    }
    const createdAt = now();
    const clinical: Application = {
      id: 'app_clinical', name: 'Clinical Workspace', description: 'Synthetic reference application for patient-context launches.',
      callbackUrls: [`${bridge.config.consoleUrl}/reference-app`], requiredContext: ['patient'],
      requiredScopes: ['patient/Patient.rs', 'patient/Observation.rs'], allowedModes: ['gateway', 'direct', 'handoff'], createdAt,
    };
    const service: Application = {
      id: 'app_service', name: 'Population Service', description: 'Synthetic backend service using preauthorized system access.',
      callbackUrls: [], requiredContext: [], requiredScopes: ['system/Patient.rs'], allowedModes: ['gateway', 'direct', 'handoff'], createdAt,
    };
    await bridge.repo.put('applications', clinical);
    await bridge.repo.put('applications', service);
    await bridge.vault.set('application-key:app_service', 'demo-service-key');
    await bridge.repo.put<Registration>('registrations', { id: 'reg_demo', name: 'Synthetic interactive client', vendor: 'generic', clientId: 'smart-flint-demo', authMethod: 'none', createdAt });
    const key = await bridge.signingKey();
    await bridge.repo.put<Registration>('registrations', { id: 'reg_service', name: 'Synthetic backend client', vendor: 'generic', clientId: 'smart-flint-service', authMethod: 'private_key_jwt', privateKeyRef: 'bridge-signing', keyId: key.kid, createdAt });
    const fixtures = [
      { id: 'northstar', name: 'Northstar Health', vendor: 'epic' as const },
      { id: 'harbor', name: 'Harbor Medical', vendor: 'epic' as const },
      { id: 'lakeside', name: 'Lakeside Care', vendor: 'oracle' as const },
    ];
    for (const fixture of fixtures) {
      const tenant: Tenant = { id: `tenant_${fixture.id}`, name: fixture.name, slug: fixture.id, createdAt };
      const connection: Connection = {
        id: `conn_${fixture.id}`, tenantId: tenant.id, name: `${fixture.name} synthetic sandbox`, vendor: fixture.vendor,
        fhirBaseUrl: `${bridge.config.mockEhrUrl}/${fixture.vendor}/${fixture.id}/r4`, environment: 'sandbox', fhirVersion: '4.0.1',
        allowedOrigins: [new URL(bridge.config.mockEhrUrl).origin], status: 'unverified', createdAt,
      };
      const installation: Installation = {
        id: `inst_${fixture.id}`, name: `Clinical Workspace · ${fixture.name}`, applicationId: clinical.id,
        tenantId: tenant.id, connectionId: connection.id, registrationId: 'reg_demo', mode: 'gateway', enabled: true,
        scopes: ['launch/patient', 'openid', 'fhirUser', 'offline_access', ...clinical.requiredScopes],
        allowTokenExport: true, normalizationProfile: 'passthrough', createdAt,
      };
      await bridge.repo.put('tenants', tenant);
      await bridge.repo.put('connections', connection);
      await bridge.repo.put('installations', installation);
    }
    await bridge.repo.put<Installation>('installations', {
      id: 'inst_service', name: 'Population Service · Northstar Health', applicationId: service.id,
      tenantId: 'tenant_northstar', connectionId: 'conn_northstar', registrationId: 'reg_service', mode: 'gateway', enabled: true,
      scopes: ['system/Patient.rs'], allowTokenExport: true, normalizationProfile: 'passthrough', createdAt,
    });
    await bridge.audit('demo.configured', 'Synthetic organizations, applications and installations are available for local testing.');
  });
}
