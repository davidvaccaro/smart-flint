import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { SMARTFlintClient, type ActivationSession, type FHIRConnection } from '@smart-flint/sdk';
import { assessHealth, readPatientSnapshot, type HealthAssessment } from '@smart-flint/health-assessment';
import { DEMO_SERVICE_TOKEN, isLoopback, loadServiceConfig, normalizeBase, type HealthFHIRServiceConfig } from './config.js';

const idPattern = /^[A-Za-z0-9.-]{1,64}$/;
const assessmentRequest = z.object({
  installationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  patientId: z.string().regex(idPattern).optional(),
  route: z.enum(['gateway', 'direct']).default('gateway'),
}).strict();

interface Issue { code: string; message: string }
interface Result {
  schemaVersion: '1.0';
  generatedAt: string;
  installationId: string;
  route: 'gateway' | 'direct';
  assessments: HealthAssessment[];
  issues: Issue[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sameSecret(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** A Bundle next link may paginate Patient only within the exact selected FHIR base. */
function patientPageUrl(candidate: string, baseUrl: string, route: FHIRConnection['route'], previous?: string): string {
  const base = new URL(`${baseUrl}/`);
  const resolved = new URL(candidate, previous ?? base);
  const gatewayPage = route === 'gateway' && resolved.pathname.startsWith(`${base.pathname}_page/`)
    && /^[A-Za-z0-9_-]+$/.test(resolved.pathname.slice(`${base.pathname}_page/`.length));
  if (resolved.origin !== base.origin || (resolved.pathname !== `${base.pathname}Patient` && !gatewayPage)
    || resolved.username || resolved.password || resolved.hash) {
    throw new Error('unapproved_patient_page');
  }
  return resolved.href;
}

async function readPatientIds(connection: FHIRConnection, config: HealthFHIRServiceConfig, fetcher: typeof fetch, issues: Issue[]): Promise<string[]> {
  const found = new Set<string>();
  const visited = new Set<string>();
  let next: string | undefined = `${connection.baseUrl}/Patient?_count=${config.maxPatients}`;
  for (let page = 0; next && page < config.maxPatientPages; page++) {
    const url = patientPageUrl(next, connection.baseUrl, connection.route);
    if (visited.has(url)) throw new Error('repeated_patient_page');
    visited.add(url);
    const response = await fetcher(url, {
      headers: { Accept: 'application/fhir+json', Authorization: await connection.credentials.getAuthorizationHeader() },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('patient_search_failed');
    const bundle = record(await response.json());
    if (bundle?.resourceType !== 'Bundle' || !Array.isArray(bundle.entry ?? [])) throw new Error('invalid_patient_bundle');
    const entries = (bundle.entry ?? []) as unknown[];
    for (const entry of entries.slice(0, config.maxPatients)) {
      const patient = record(record(entry)?.resource);
      if (patient?.resourceType === 'Patient' && typeof patient.id === 'string' && idPattern.test(patient.id)) found.add(patient.id);
      if (found.size >= config.maxPatients) break;
    }
    const rawNext = Array.isArray(bundle.link) ? bundle.link.find(link => record(link)?.relation === 'next') : undefined;
    const nextValue = record(rawNext)?.url;
    // Validate before accepting the next link, including when this request's bound has already been reached.
    next = typeof nextValue === 'string' ? patientPageUrl(nextValue, connection.baseUrl, connection.route, url) : undefined;
    if (found.size >= config.maxPatients) {
      if (next || entries.length > config.maxPatients) issues.push({ code: 'patient_limit', message: `This sample limits each run to ${config.maxPatients} patients; additional patients may exist.` });
      next = undefined;
    }
  }
  if (next) issues.push({ code: 'patient_page_limit', message: 'The configured Patient page limit was reached; additional patients may exist.' });
  return [...found];
}

function assertConnection(connection: FHIRConnection, activationId: string, expectedUpstream: string, config: HealthFHIRServiceConfig): void {
  const base = normalizeBase(connection.baseUrl, config.production);
  if (connection.route === 'gateway' && base !== `${config.bridgeUrl}/fhir/${encodeURIComponent(activationId)}`) throw new Error('unexpected_gateway');
  if (connection.route === 'direct' && (!config.fhirBaseUrls.includes(base)
    || base !== normalizeBase(expectedUpstream, config.production))) throw new Error('unexpected_fhir_base');
}

/** Headless caller: system access does not have a launched user or a selected patient. */
export async function buildHealthFHIRService(options: { config?: Partial<HealthFHIRServiceConfig>; fetch?: typeof fetch } = {}) {
  const config = loadServiceConfig(options.config);
  const underlyingFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fetcher: typeof fetch = (input, init = {}) => underlyingFetch(input, {
    ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const bridge = new SMARTFlintClient({ baseUrl: config.bridgeUrl, fetch: fetcher });
  const app = Fastify({ logger: false, bodyLimit: 16_384, trustProxy: false });
  app.setErrorHandler((error, _request, reply) => {
    const code = record(error)?.statusCode;
    const status = code === 400 || code === 413 ? code : 500;
    return reply.code(status).send({ code: 'service_failed', message: 'The health review service could not complete the request.' });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'health-compass-fhir' }));
  app.get('/', async () => ({
    name: 'Health Compass backend FHIR sample', endpoint: 'POST /assessments',
    pathways: ['SMART Backend Services / system access'], patientContext: 'Explicit patientId, or a bounded Patient search.',
  }));

  app.post('/assessments', async (request, reply) => {
    if (!sameSecret(request.headers.authorization, config.callerToken)
      || (config.callerToken === DEMO_SERVICE_TOKEN && !isLoopback(request.ip))) {
      return reply.code(401).send({ code: 'unauthorized', message: 'A valid health service caller credential is required.' });
    }
    const parsed = assessmentRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'invalid_request', message: 'Supply an installationId, optional FHIR patientId and gateway or direct route.' });
    const body = parsed.data;
    if (!config.installationIds.includes(body.installationId)) {
      return reply.code(403).send({ code: 'installation_not_allowed', message: 'This service is not configured to use that installation.' });
    }
    const result: Result = {
      schemaVersion: '1.0', generatedAt: new Date().toISOString(), installationId: body.installationId,
      route: body.route, assessments: [], issues: [],
    };
    let activated: ReturnType<SMARTFlintClient['session']> | undefined;
    let failed = false;
    try {
      // The application API key stays on this server. SMART Flint signs the upstream private_key_jwt assertion.
      const session = await bridge.request<ActivationSession>('/api/service-activations', {
        method: 'POST', body: JSON.stringify({ installationId: body.installationId }),
      }, config.applicationKey);
      if (!session?.activation?.id || !session.sessionToken) throw new Error('invalid_service_activation');
      activated = bridge.session(session.activation.id, session.sessionToken);
      if (session.activation.kind !== 'service' || session.activation.status !== 'ready'
        || session.activation.installationId !== body.installationId) throw new Error('unexpected_service_activation');
      const connection = await activated.getFHIRConnection({ route: body.route });
      assertConnection(connection, session.activation.id, session.activation.upstream.baseUrl, config);
      const patientIds = body.patientId ? [body.patientId] : await readPatientIds(connection, config, fetcher, result.issues);
      for (const patientId of patientIds) {
        try {
          const snapshot = await readPatientSnapshot({
            baseUrl: connection.baseUrl, patientReference: `Patient/${patientId}`, maxPages: 2,
            subjectBaseUrl: session.activation.upstream.baseUrl,
            getAuthorizationHeader: connection.credentials.getAuthorizationHeader, fetch: fetcher,
          });
          result.assessments.push(assessHealth(snapshot));
        } catch {
          // No upstream response body, URL, Patient id or credential is copied into an operational error.
          result.issues.push({ code: 'patient_unavailable', message: 'One selected patient could not be assessed with the authorized records.' });
        }
      }
      if (!patientIds.length) result.issues.push({ code: 'no_patients', message: 'The authorized Patient search returned no patients.' });
    } catch {
      failed = true;
    } finally {
      // A new activation is isolated to this operation and closed on both success and failure.
      if (activated) {
        try { await activated.close(); }
        catch { result.issues.push({ code: 'cleanup_unconfirmed', message: 'Activation cleanup could not be confirmed. Its configured expiry still applies.' }); }
      }
    }
    if (failed) return reply.code(502).send({ code: 'assessment_failed', message: 'The selected SMART service installation could not complete the FHIR review.' });
    return result;
  });
  return app;
}
