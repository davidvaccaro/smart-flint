import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ActivationDescriptor } from '@smart-flint/contracts';
import { createHealthFixture } from '@smart-flint/health-assessment';
import { buildHealthCDS } from '../samples/cds-service/src/app.js';
import { loadCDSConfig } from '../samples/cds-service/src/config.js';
import { buildHealthFHIRService } from '../samples/fhir-service/src/app.js';
import { loadServiceConfig } from '../samples/fhir-service/src/config.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const fixture = () => createHealthFixture('patient-a');
const cdsHeaders = { authorization: 'Bearer demo-health-cds-handler' };
const serviceHeaders = { authorization: 'Bearer demo-health-service-client' };
const baseUrl = 'http://127.0.0.1:4010/epic/northstar/r4';
const bridgeUrl = 'http://127.0.0.1:3001';
const installationId = 'inst_health_service_northstar';
const bundle = (resources: unknown[], next?: string) => ({
  resourceType: 'Bundle', type: 'searchset', entry: resources.map(resource => ({ resource })),
  ...(next ? { link: [{ relation: 'next', url: next }] } : {}),
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/fhir+json' } });
const payload = (prefetch = true) => {
  const snapshot = fixture();
  return {
    hook: 'patient-view', hookInstance: '9ba95b52-e601-4e67-8c99-06fa1e576474',
    context: { patientId: snapshot.patient.id }, fhirServer: baseUrl,
    ...(prefetch ? { prefetch: { patient: snapshot.patient, observations: bundle(snapshot.observations) } } : {}),
  };
};

describe('Health Compass CDS handler sample', () => {
  it('requires the handler bearer secret and limits demo credentials to loopback callers', async () => {
    const app = await buildHealthCDS(); apps.push(app);
    const denied = await app.inject({ method: 'POST', url: '/hooks/health-review', payload: payload() });
    expect(denied.statusCode).toBe(401);
    const remote = await app.inject({ method: 'POST', url: '/hooks/health-review', remoteAddress: '192.0.2.20', headers: cdsHeaders, payload: payload() });
    expect(remote.statusCode).toBe(401);
  });

  it('turns actual matching prefetch into educational action cards and a separate SMART launch link', async () => {
    const launchUrl = `${bridgeUrl}/launch/inst_health_northstar`;
    const app = await buildHealthCDS({ config: { smartAppLaunchUrl: launchUrl } }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: payload() });
    expect(response.statusCode).toBe(200);
    const cards = response.json().cards;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(4);
    expect(cards[0].detail).toMatch(/unvalidated/);
    expect(cards.every((card: { source: { label: string } }) => card.source.label === 'Health Compass sample')).toBe(true);
    expect(cards[0].links).toEqual([{ label: 'Open Health Compass', type: 'smart', url: launchUrl, appContext: '{"intent":"review-health"}' }]);
    expect(response.body).not.toContain('demo-health-cds-handler');
  });

  it('rejects a prefetched Patient for a different context and invalid patient identifiers', async () => {
    const app = await buildHealthCDS(); apps.push(app);
    const body = payload();
    body.prefetch!.patient = { ...body.prefetch!.patient, id: 'patient-b' };
    const wrong = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: body });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('patient_mismatch');
    const invalid = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: { ...payload(), context: { patientId: '../other' } } });
    expect(invalid.statusCode).toBe(400);
  });

  it('never treats missing records as a healthy assessment and excludes other patients observations', async () => {
    const app = await buildHealthCDS(); apps.push(app);
    const missing = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: payload(false) });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().cards[0].detail).toContain('No health score was calculated');
    const matching = payload();
    const ordinary = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: matching });
    const other = fixture().observations.map(observation => ({ ...observation, subject: { reference: 'Patient/patient-b' } }));
    matching.prefetch!.observations.entry.unshift(...other.map(resource => ({ resource })));
    const mixed = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: matching });
    expect(mixed.json().cards.map((card: { summary: string; indicator: string }) => [card.summary, card.indicator]))
      .toEqual(ordinary.json().cards.map((card: { summary: string; indicator: string }) => [card.summary, card.indicator]));
    expect(mixed.json().cards[0].detail).toContain('Records without an exact matching patient reference were excluded');
  });

  it('shows incomplete retrieval notices even when all four measurement domains are present', async () => {
    const app = await buildHealthCDS(); apps.push(app);
    const body = payload();
    body.prefetch!.observations = { ...body.prefetch!.observations, link: [{ relation: 'next', url: `${baseUrl}/Observation?page=2` }] };
    const response = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: body });
    expect(response.statusCode).toBe(200);
    const cards = response.json().cards;
    expect(cards[0].detail).toContain('measurement coverage: 100%');
    expect(cards.every((card: { detail: string }) => card.detail.includes('additional records may exist'))).toBe(true);
    expect(cards[0].detail).toContain('Data availability and interpretation notes');
  });

  it('requires an explicit FHIR namespace for absolute prefetch subjects without guessing a tenant', async () => {
    const app = await buildHealthCDS(); apps.push(app);
    const { fhirServer: _omitted, ...body } = payload();
    body.prefetch!.observations = bundle(fixture().observations.map(observation => ({
      ...observation, subject: { reference: `${baseUrl}/Patient/patient-a` },
    })));
    const response = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json().cards).toHaveLength(1);
    expect(response.json().cards[0].indicator).toBe('info');
    expect(response.json().cards[0].detail).toContain('Absolute patient references require a configured fhirServer');
    expect(response.json().cards[0].detail).toContain('No health score was calculated');
    expect(response.body).not.toContain('Illustrative score:');
  });

  it('pins transient FHIR authorization to an explicitly configured server and never echoes tokens', async () => {
    const snapshot = fixture();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.href.startsWith(`${baseUrl}/`)).toBe(true);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer invocation-only-secret');
      return json(url.pathname.endsWith('/Patient/patient-a') ? snapshot.patient : bundle(snapshot.observations));
    });
    const app = await buildHealthCDS({ fetch: fetcher }); apps.push(app);
    const request = { ...payload(false), fhirAuthorization: { access_token: 'invocation-only-secret', token_type: 'Bearer' } };
    const malicious = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: { ...request, fhirServer: 'https://attacker.example/fhir' } });
    expect(malicious.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const allowed = await app.inject({ method: 'POST', url: '/hooks/health-review', headers: cdsHeaders, payload: request });
    expect(allowed.statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalled();
    expect(allowed.body).not.toContain('invocation-only-secret');
    expect(allowed.json().cards[0].detail).toContain('unvalidated');
  });

  it('requires explicit production credentials and permits no default local listener on all interfaces', () => {
    expect(() => loadCDSConfig({ production: true }, {})).toThrow(/CDS_HANDLER_TOKEN/);
    expect(() => loadCDSConfig({ host: '0.0.0.0' }, {})).toThrow(/loopback/);
    expect(() => loadServiceConfig({ production: true }, {})).toThrow(/SAMPLE_SERVICE_TOKEN/);
    expect(() => loadServiceConfig({ host: '0.0.0.0' }, {})).toThrow(/loopback/);
  });
});

function descriptor(id: string, selectedInstallation: string): ActivationDescriptor {
  return {
    schemaVersion: '1.0', id, installationId: selectedInstallation, applicationId: 'app_health_service', tenantId: 'tenant_northstar',
    connectionId: 'conn_northstar', kind: 'service', status: 'ready', mode: 'gateway', context: { extensions: {} },
    grantedScopes: ['system/Patient.rs', 'system/Observation.rs'], presentation: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    gateway: { baseUrl: `${bridgeUrl}/fhir/${id}` }, upstream: { baseUrl, fhirVersion: '4.0.1' },
    refreshOwner: 'bridge', tokenExportAllowed: true,
  };
}

function fakeBridge(options: {
  descriptorFailure?: boolean; patientFailure?: boolean; searchNext?: string; secondPage?: boolean; patientCount?: number;
  absoluteSubjects?: boolean; descriptorUpstream?: string;
} = {}) {
  const requests: { url: string; method: string; authorization: string | null }[] = [];
  const sessions = new Map<string, ActivationDescriptor>();
  const closed: string[] = [];
  const snapshot = fixture();
  let sequence = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const authorization = new Headers(init?.headers).get('Authorization');
    requests.push({ url: url.href, method, authorization });
    if (url.pathname === '/api/service-activations') {
      expect(authorization).toBe('Bearer demo-health-service-key');
      const body = JSON.parse(String(init?.body));
      const id = `activation-${++sequence}`;
      const activation = descriptor(id, body.installationId);
      sessions.set(id, activation);
      return json({ activation, sessionToken: `session-secret-${id}` });
    }
    const api = /^\/api\/activations\/([^/]+)(\/credentials)?$/.exec(url.pathname);
    if (api) {
      const id = api[1]!;
      expect(authorization).toBe(`Bearer session-secret-${id}`);
      if (method === 'DELETE') { closed.push(id); return new Response(null, { status: 204 }); }
      if (options.descriptorFailure && !api[2]) return json({ message: 'Sensitive upstream diagnostic session-secret-activation-1' }, 500);
      if (api[2]) return json({ baseUrl, accessToken: `upstream-secret-${id}`, tokenType: 'Bearer', grantedScopes: [], refreshOwner: 'bridge' });
      const activation = sessions.get(id);
      return json(options.descriptorUpstream && activation ? { ...activation, upstream: { ...activation.upstream, baseUrl: options.descriptorUpstream } } : activation);
    }
    const gateway = /^\/fhir\/(activation-\d+)\/(.+)$/.exec(url.pathname);
    const path = gateway?.[2] ?? url.pathname.slice(new URL(baseUrl).pathname.length + 1);
    if (gateway) expect(authorization).toBe(`Bearer session-secret-${gateway[1]}`);
    else {
      expect(url.href.startsWith(`${baseUrl}/`)).toBe(true);
      expect(authorization).toMatch(/^Bearer upstream-secret-activation-\d+$/);
    }
    if (path === 'Patient') {
      const patients = options.patientCount ? Array.from({ length: options.patientCount }, (_, i) => ({ ...snapshot.patient, id: `patient-${i}` })) : [snapshot.patient];
      return json(bundle(patients, options.searchNext ?? (options.secondPage ? `${bridgeUrl}/fhir/${gateway![1]}/_page/page_patient2` : undefined)));
    }
    if (path.startsWith('_page/')) return json(bundle([{ ...snapshot.patient, id: 'patient-b' }]));
    if (path.startsWith('Patient/')) return options.patientFailure ? json({ resourceType: 'OperationOutcome', diagnostic: 'upstream-private-secret' }, 500)
      : json({ ...snapshot.patient, id: path.slice('Patient/'.length) });
    if (path === 'Observation') {
      const patient = url.searchParams.get('patient') ?? 'patient-a';
      return json(bundle(snapshot.observations.map(observation => ({
        ...observation, subject: { reference: `${options.absoluteSubjects ? `${baseUrl}/` : ''}Patient/${patient}` },
      }))));
    }
    throw new Error(`Unexpected test route: ${url.pathname}`);
  };
  return { fetcher, requests, closed };
}

describe('Health Compass SMART Backend Services sample', () => {
  it('authenticates callers and rejects unconfigured installations before creating any upstream activation', async () => {
    const fake = fakeBridge();
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const missing = await app.inject({ method: 'POST', url: '/assessments', payload: { installationId } });
    expect(missing.statusCode).toBe(401);
    const remote = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, remoteAddress: '192.0.2.42', payload: { installationId } });
    expect(remote.statusCode).toBe(401);
    const tenant = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId: 'inst_unconfigured' } });
    expect(tenant.statusCode).toBe(403);
    expect(fake.requests).toEqual([]);
  });

  it.each(['gateway', 'direct'] as const)('assesses selected patients through %s using ordinary FHIR HTTP, with credentials kept out of the result', async route => {
    const fake = fakeBridge();
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId, patientId: 'patient-a', route } });
    expect(response.statusCode).toBe(200);
    expect(response.json().assessments).toHaveLength(1);
    expect(response.json().assessments[0].patient.id).toBe('patient-a');
    expect(response.json().assessments[0].score.value).not.toBeNull();
    expect(response.json().route).toBe(route);
    expect(fake.closed).toEqual(['activation-1']);
    for (const secret of ['demo-health-service-key', 'session-secret', 'upstream-secret']) expect(response.body).not.toContain(secret);
    expect(fake.requests.some(request => request.url.includes('/credentials'))).toBe(route === 'direct');
  });

  it('closes an activation when SMART Flint descriptor retrieval fails, without returning raw errors', async () => {
    const fake = fakeBridge({ descriptorFailure: true });
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId, patientId: 'patient-a' } });
    expect(response.statusCode).toBe(502);
    expect(fake.closed).toEqual(['activation-1']);
    expect(response.body).not.toContain('session-secret');
    expect(response.body).not.toContain('Sensitive upstream');
  });

  it('accepts absolute upstream patient subjects while all gateway fetches stay activation-bound', async () => {
    const fake = fakeBridge({ absoluteSubjects: true });
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId, patientId: 'patient-a' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().assessments[0].score.coveragePercent).toBe(100);
    expect(fake.requests.filter(request => !request.url.includes('/api/')).every(request => request.url.startsWith(`${bridgeUrl}/fhir/activation-1/`))).toBe(true);
  });

  it('rejects a direct connection that changes tenant FHIR bases before exposing any upstream credential', async () => {
    const fake = fakeBridge({ descriptorUpstream: 'http://127.0.0.1:4010/epic/harbor/r4' });
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId, patientId: 'patient-a', route: 'direct' } });
    expect(response.statusCode).toBe(502);
    expect(fake.requests.some(request => request.url.endsWith('/credentials'))).toBe(false);
    expect(fake.requests.some(request => request.url.startsWith(baseUrl))).toBe(false);
    expect(fake.closed).toEqual(['activation-1']);
  });

  it('closes an activation when individual Patient reads fail, and reports the coverage gap', async () => {
    const fake = fakeBridge({ patientFailure: true });
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId, patientId: 'patient-a' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().assessments).toEqual([]);
    expect(response.json().issues).toContainEqual({ code: 'patient_unavailable', message: expect.any(String) });
    expect(response.body).not.toContain('upstream-private-secret');
    expect(fake.closed).toEqual(['activation-1']);
  });

  it('follows only activation-bound gateway pagination while selecting patients explicitly', async () => {
    const fake = fakeBridge({ secondPage: true });
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId } });
    expect(response.statusCode).toBe(200);
    expect(response.json().assessments).toHaveLength(2);
    expect(fake.requests.some(request => request.url.endsWith('/_page/page_patient2'))).toBe(true);
    expect(fake.closed).toEqual(['activation-1']);
  });

  it.each(['https://attacker.example/Patient?page=2', `${bridgeUrl}/fhir/other-activation/Patient?page=2`])('rejects an unapproved Patient continuation %s before sending credentials', async searchNext => {
    const fake = fakeBridge({ searchNext });
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId } });
    expect(response.statusCode).toBe(502);
    expect(fake.requests.some(request => request.url === searchNext)).toBe(false);
    expect(fake.closed).toEqual(['activation-1']);
  });

  it('bounds a bulk run to 20 patients even if a server ignores the requested count', async () => {
    const fake = fakeBridge({ patientCount: 25 });
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId } });
    expect(response.statusCode).toBe(200);
    expect(response.json().assessments).toHaveLength(20);
    expect(response.json().issues).toContainEqual({ code: 'patient_limit', message: expect.any(String) });
    expect(fake.closed).toEqual(['activation-1']);
  });

  it('keeps simultaneous service activation credentials isolated across independent operations', async () => {
    const fake = fakeBridge();
    const app = await buildHealthFHIRService({ fetch: fake.fetcher }); apps.push(app);
    const responses = await Promise.all(['patient-a', 'patient-b'].map(patientId => app.inject({
      method: 'POST', url: '/assessments', headers: serviceHeaders, payload: { installationId, patientId },
    })));
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses.map(response => response.json().assessments[0].patient.id)).toEqual(['patient-a', 'patient-b']);
    expect(fake.closed.sort()).toEqual(['activation-1', 'activation-2']);
  });
});
