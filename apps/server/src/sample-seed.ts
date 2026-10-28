import type { Application, Connection, Installation, Registration, Tenant } from '../../../packages/contracts/src/index.js';
import { Bridge, now } from './bridge.js';

/** Explicit local samples. Production deployments are configured by the operator. */
export async function seedSamples(bridge: Bridge) {
  if (!bridge.config.demo) return;
  await bridge.repo.withLock('registry:samples', async () => {
    const createdAt = now();
    const patientUrl = bridge.config.samplePatientUrl ?? 'http://127.0.0.1:4100';
    const handlerUrl = `${bridge.config.sampleCdsUrl ?? 'http://127.0.0.1:4101'}/hooks/health-review`;
    const patientApp: Application = {
      id: 'app_health_compass', name: 'Health Compass · patient sample',
      description: 'Independent patient-facing SMART sample with an illustrative health snapshot and explained actions.',
      callbackUrls: [`${patientUrl}/callback`], requiredContext: ['patient'],
      requiredScopes: ['patient/Patient.r', 'patient/Observation.rs'], allowedModes: ['gateway', 'direct', 'handoff'], createdAt,
    };
    const serviceApp: Application = {
      id: 'app_health_service', name: 'Health Compass · backend sample',
      description: 'Headless SMART Backend Services example for bounded population health-review snapshots.',
      callbackUrls: [], requiredContext: [], requiredScopes: ['system/Patient.rs', 'system/Observation.rs'], allowedModes: ['gateway', 'direct'], createdAt,
    };
    for (const application of [patientApp, serviceApp]) if (!await bridge.repo.get('applications', application.id)) await bridge.repo.put('applications', application);
    if (!await bridge.repo.get('registrations', 'reg_health_patient')) await bridge.repo.put<Registration>('registrations', {
      id: 'reg_health_patient', name: 'Health Compass patient-facing public client', vendor: 'generic',
      clientId: 'smart-flint-health-patient', authMethod: 'none', createdAt,
    });
    if (!await bridge.repo.get('registrations', 'reg_service')) {
      const key = await bridge.signingKey();
      await bridge.repo.put<Registration>('registrations', { id: 'reg_service', name: 'Synthetic backend client', vendor: 'generic', clientId: 'smart-flint-service', authMethod: 'private_key_jwt', privateKeyRef: 'bridge-signing', keyId: key.kid, createdAt });
    }
    if (!await bridge.vault.get('application-key:app_health_service')) await bridge.vault.set('application-key:app_health_service', 'demo-health-service-key');
    const fixtures = [
      { id: 'northstar', name: 'Northstar Health', vendor: 'epic' as const },
      { id: 'harbor', name: 'Harbor Medical', vendor: 'epic' as const },
      { id: 'lakeside', name: 'Lakeside Care', vendor: 'oracle' as const },
      { id: 'cedar', name: 'Cedar Health', vendor: 'meditech' as const },
    ];
    for (const { id, name, vendor } of fixtures) {
      if (!await bridge.repo.get('tenants', `tenant_${id}`)) await bridge.repo.put<Tenant>('tenants', { id: `tenant_${id}`, name, slug: id, createdAt });
      if (!await bridge.repo.get('connections', `conn_${id}`)) await bridge.repo.put<Connection>('connections', {
        id: `conn_${id}`, tenantId: `tenant_${id}`, name: `${name} synthetic sandbox`, vendor,
        fhirBaseUrl: `${bridge.config.mockEhrUrl}/${vendor}/${id}/r4`, environment: 'sandbox', fhirVersion: '4.0.1',
        allowedOrigins: [new URL(bridge.config.mockEhrUrl).origin], status: 'unverified', createdAt,
      });
      if (!await bridge.repo.get('connections', `conn_${id}`)) continue;
      const interactive: Installation = {
        id: `inst_health_${id}`, name: `Health Compass · ${id}`, applicationId: patientApp.id, tenantId: `tenant_${id}`,
        connectionId: `conn_${id}`, registrationId: 'reg_health_patient', mode: 'gateway', enabled: true,
        scopes: ['launch/patient', 'openid', 'fhirUser', 'offline_access', 'patient/Patient.r', 'patient/Observation.rs'],
        allowTokenExport: true, normalizationProfile: 'passthrough', createdAt,
      };
      const service: Installation = {
        id: `inst_health_service_${id}`, name: `Health Compass population · ${id}`, applicationId: serviceApp.id,
        tenantId: `tenant_${id}`, connectionId: `conn_${id}`, registrationId: 'reg_service', mode: 'gateway', enabled: true,
        scopes: ['system/Patient.rs', 'system/Observation.rs'], allowTokenExport: true, normalizationProfile: 'passthrough', createdAt,
      };
      for (const installation of [interactive, service]) {
        const existing = await bridge.repo.get<Installation>('installations', installation.id);
        if (!existing) await bridge.repo.put('installations', installation);
        else if (installation.id === interactive.id && existing.registrationId === 'reg_demo') await bridge.repo.put('installations', { ...existing, registrationId: 'reg_health_patient' });
      }
      const cdsId = `cds_health_${id}`;
      if (!await bridge.repo.get('cds_services', cdsId)) {
        const vendor = id === 'lakeside' ? 'oracle' : id === 'cedar' ? 'meditech' : 'epic';
        const callerIssuer = `${bridge.config.mockEhrUrl}/${vendor}/${id}/oauth`;
        const handlerSecretRef = `cds-handler:${cdsId}`;
        await bridge.vault.set(handlerSecretRef, 'demo-health-cds-handler');
        await bridge.repo.put('cds_services', {
          id: cdsId, installationId: interactive.id, hook: 'patient-view', title: 'Health Compass review',
          description: 'Educational sample that explains recorded indicators and follow-up opportunities.', handlerUrl,
          callerIssuer, callerJwksUrl: `${callerIssuer}/jwks`, enabled: true,
          allowedOrigins: [new URL(handlerUrl).origin, new URL(bridge.config.mockEhrUrl).origin], handlerSecretRef,
          prefetch: { patient: 'Patient/{{context.patientId}}', observations: 'Observation?patient={{context.patientId}}&_count=100' }, createdAt,
        });
      }
    }
  });
}
