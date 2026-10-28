import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import {
  assessHealth, readPatientSnapshot,
  type FhirObservation, type FhirPatient, type HealthAssessment, type PatientSnapshot,
} from '@smart-flint/health-assessment';
import { DEMO_CDS_HANDLER_TOKEN, isLoopback, loadCDSConfig, normalizeFHIRBase, type HealthCDSConfig } from './config.js';

const idPattern = /^[A-Za-z0-9.-]{1,64}$/;
const hookRequest = z.object({
  hook: z.literal('patient-view'),
  hookInstance: z.uuid(),
  context: z.object({ patientId: z.string().regex(idPattern) }).passthrough(),
  fhirServer: z.string().max(2048).optional(),
  fhirAuthorization: z.object({
    access_token: z.string().min(1).max(16_384),
    token_type: z.string().optional(),
  }).passthrough().optional(),
  prefetch: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

interface Card {
  summary: string;
  indicator: 'info' | 'warning' | 'critical';
  detail: string;
  source: { label: string; url?: string };
  links?: { label: string; url: string; type: 'smart'; appContext: string }[];
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

function links(config: HealthCDSConfig): Card['links'] {
  return config.smartAppLaunchUrl ? [{
    label: 'Open Health Compass', url: config.smartAppLaunchUrl,
    type: 'smart', appContext: JSON.stringify({ intent: 'review-health' }),
  }] : undefined;
}

function recordsNeeded(config: HealthCDSConfig, detail: string): { cards: Card[] } {
  return { cards: [{
    summary: 'More patient records are needed for a health review', indicator: 'info',
    detail: `${detail} No health score was calculated. This educational sample is not a diagnosis or a validated risk score.`,
    source: { label: 'Health Compass sample' }, links: links(config),
  }] };
}

function assessmentCards(assessment: HealthAssessment, config: HealthCDSConfig): { cards: Card[] } {
  const score = assessment.score.value === null
    ? 'There are too few recent interpretable measurements to calculate a score.'
    : `Illustrative score: ${assessment.score.value}/100; measurement coverage: ${assessment.score.coveragePercent}%.`;
  const limitations = `${score} This educational score is unvalidated and is not a diagnosis. Missing records do not indicate good health; pregnancy and known conditions can change interpretation.`;
  // Engine notices contain controlled interpretation and retrieval messages, never raw upstream response bodies.
  const availability = assessment.notices.length ? `\n\nData availability and interpretation notes:\n${assessment.notices.join('\n')}` : '';
  const cards: Card[] = assessment.actions.slice(0, 4).map(action => ({
    summary: action.title.slice(0, 140),
    indicator: action.priority === 'urgent' ? 'critical' : action.priority === 'high' ? 'warning' : 'info',
    detail: `${action.description}\n\n${action.reason}\n\n${limitations}${availability}`,
    source: { label: 'Health Compass sample', url: action.sourceUrl },
  }));
  if (!cards.length) cards.push({
    summary: 'Review the available health measurements', indicator: 'info',
    detail: `${limitations} Continue routine care and discuss questions with your care team.${availability}`,
    source: { label: 'Health Compass sample' },
  });
  cards[0]!.links = links(config);
  return { cards };
}

/** A handler behind SMART Flint, which verifies the EHR caller JWT before forwarding here. */
export async function buildHealthCDS(options: { config?: Partial<HealthCDSConfig>; fetch?: typeof fetch } = {}) {
  const config = loadCDSConfig(options.config);
  const underlyingFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fetcher: typeof fetch = (input, init = {}) => underlyingFetch(input, {
    ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: false });
  app.setErrorHandler((error, _request, reply) => {
    const code = record(error)?.statusCode;
    const status = code === 400 || code === 413 ? code : 500;
    return reply.code(status).send({ code: 'handler_failed', message: 'The health review could not be completed.' });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'health-compass-cds' }));
  app.get('/', async () => ({
    name: 'Health Compass CDS sample', hook: 'patient-view', handler: '/hooks/health-review',
    discovery: 'Publish through SMART Flint /cds-services; this private handler is not the EHR-facing endpoint.',
  }));

  app.post('/hooks/health-review', async (request, reply) => {
    if (!sameSecret(request.headers.authorization, config.handlerToken)
      || (config.handlerToken === DEMO_CDS_HANDLER_TOKEN && !isLoopback(request.ip))) {
      return reply.code(401).send({ code: 'unauthorized', message: 'A valid CDS handler credential is required.' });
    }
    const parsed = hookRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'invalid_hook', message: 'A patient-view hook, UUID hookInstance and valid context.patientId are required.' });
    const body = parsed.data;
    let baseUrl: string | undefined;
    if (body.fhirServer) {
      try { baseUrl = normalizeFHIRBase(body.fhirServer, config.production); }
      catch { return reply.code(400).send({ code: 'unapproved_fhir_server', message: 'The hook FHIR server is not configured for this handler.' }); }
      if (!config.fhirBaseUrls.includes(baseUrl)) {
        return reply.code(400).send({ code: 'unapproved_fhir_server', message: 'The hook FHIR server is not configured for this handler.' });
      }
    }

    const patientId = body.context.patientId;
    const suppliedPatient = record(body.prefetch?.patient);
    if (suppliedPatient && (suppliedPatient.resourceType !== 'Patient' || suppliedPatient.id !== patientId)) {
      return reply.code(400).send({ code: 'patient_mismatch', message: 'The prefetched Patient must match context.patientId.' });
    }
    const observationBundle = record(body.prefetch?.observations);
    if (observationBundle && observationBundle.resourceType !== 'Bundle') {
      return reply.code(400).send({ code: 'invalid_prefetch', message: 'The observations prefetch must be a FHIR Bundle.' });
    }

    let snapshot: PatientSnapshot | undefined;
    if (suppliedPatient && observationBundle) {
      const issues: PatientSnapshot['issues'] = [];
      const entries = Array.isArray(observationBundle.entry) ? observationBundle.entry : [];
      if (!baseUrl && entries.some(entry => {
        const reference = record(record(record(entry)?.resource)?.subject)?.reference;
        return typeof reference === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference);
      })) {
        return recordsNeeded(config, 'Absolute patient references require a configured fhirServer identifying their FHIR namespace. Include fhirServer or supply matching relative Patient references.');
      }
      const observations: FhirObservation[] = [];
      let excluded = false;
      for (const entry of entries.slice(0, 200)) {
        const observation = record(record(entry)?.resource);
        if (!observation || observation.resourceType !== 'Observation') continue;
        const reference = record(observation.subject)?.reference;
        const approvedReferences = [`Patient/${patientId}`, ...(baseUrl ? [`${baseUrl}/Patient/${patientId}`] : [])];
        if (typeof reference !== 'string' || !approvedReferences.includes(reference)) { excluded = true; continue; }
        observations.push(observation as unknown as FhirObservation);
      }
      if (excluded) issues.push({ code: 'excluded_observations', message: 'Records without an exact matching patient reference were excluded.' });
      if (entries.length > 200 || (Array.isArray(observationBundle.link) && observationBundle.link.some(link => record(link)?.relation === 'next'))) {
        issues.push({ code: 'prefetch_truncated', message: 'Only the bounded prefetched observations were assessed; additional records may exist.' });
      }
      snapshot = {
        patient: suppliedPatient as unknown as FhirPatient, observations, issues,
        loadedAt: new Date().toISOString(), fhirBaseUrl: baseUrl,
      };
    } else if (baseUrl && body.fhirAuthorization) {
      if (body.fhirAuthorization.token_type && body.fhirAuthorization.token_type.toLowerCase() !== 'bearer') {
        return reply.code(400).send({ code: 'unsupported_token_type', message: 'This sample supports Bearer FHIR authorization only.' });
      }
      try {
        // This invocation's FHIR token is only held in this stack frame and is never a later SMART launch credential.
        snapshot = await readPatientSnapshot({
          baseUrl, patientReference: `Patient/${patientId}`, maxPages: 2, fetch: fetcher,
          getAuthorizationHeader: async () => `Bearer ${body.fhirAuthorization!.access_token}`,
        });
      } catch {
        return recordsNeeded(config, 'The authorized FHIR records could not be read. Check patient access and prefetch configuration.');
      }
    }
    if (!snapshot) return recordsNeeded(config, 'Supply the matching Patient and Observation Bundle as prefetch, or configure authorized FHIR access.');
    if (!snapshot.observations.length) return recordsNeeded(config, 'No matching observations were available in this invocation.');
    return assessmentCards(assessHealth(snapshot), config);
  });
  return app;
}
