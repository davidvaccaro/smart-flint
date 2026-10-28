import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Bridge, later, now } from './bridge.js';
import { digest } from '../../../packages/storage/src/index.js';
import { assert, Problem } from './errors.js';
import { readJson } from './network.js';

interface CDSService {
  id: string; installationId: string; hook: string; title: string; description: string;
  handlerUrl?: string; callerIssuer: string; callerJwksUrl?: string; enabled: boolean;
  allowedOrigins: string[]; handlerSecretRef?: string; createdAt: string;
  prefetch?: Record<string, string>;
}
const hookRequest = z.object({
  hook: z.string().min(1), hookInstance: z.uuid(), context: z.record(z.string(), z.unknown()),
  fhirServer: z.string().optional(), prefetch: z.record(z.string(), z.unknown()).optional(),
  fhirAuthorization: z.object({ access_token: z.string(), token_type: z.string(), expires_in: z.number().positive(), scope: z.string(), subject: z.string() }).passthrough().optional(),
}).passthrough();
const hookResponse = z.object({
  cards: z.array(z.object({ summary: z.string().min(1).max(140), indicator: z.enum(['info', 'warning', 'critical']), source: z.object({ label: z.string().min(1) }).passthrough() }).passthrough()).max(100),
}).passthrough();
async function authenticateCaller(bridge: Bridge, service: CDSService, request: FastifyRequest) {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
  if (bridge.config.demo && service.id === 'cds_demo' && loopback && token === 'demo-cds-key') return;
  assert(token && service.callerJwksUrl, 401, 'cds_authentication_required', 'A signed JWT from the configured CDS caller is required.');
  const response = await bridge.http.request(service.callerJwksUrl, service.allowedOrigins);
  assert(response.ok, 502, 'cds_keys_unavailable', 'The configured caller keys could not be loaded.');
  const keys = await readJson<{ keys: JWK[] }>(response);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, createLocalJWKSet(keys), {
      issuer: service.callerIssuer, audience: `${bridge.config.baseUrl}/cds-services/${service.id}`,
      algorithms: ['RS256', 'RS384', 'ES256', 'ES384'], maxTokenAge: '5m', requiredClaims: ['exp', 'iat', 'jti'], clockTolerance: 5,
    }));
  } catch { throw new Problem(401, 'cds_token_invalid', 'The caller assertion could not be verified.'); }
  assert(payload.exp! - payload.iat! <= 300 && typeof payload.jti === 'string', 401, 'cds_token_invalid', 'The caller assertion must be short-lived and uniquely identified.');
  await bridge.repo.withLock(`cds-replay:${digest(`${service.id}:${payload.jti}`)}`, async () => {
    const id = digest(`${service.id}:${payload.jti}`);
    assert(!await bridge.repo.get('replays', id), 401, 'cds_token_replayed', 'The caller assertion was already used.');
    await bridge.repo.put('replays', { id, expiresAt: later(360) });
  });
}
export async function registerCDS(app: FastifyInstance, bridge: Bridge) {
  if (bridge.config.demo && !await bridge.repo.get('cds_services', 'cds_demo')) {
    await bridge.repo.put<CDSService>('cds_services', {
      id: 'cds_demo', installationId: 'inst_northstar', hook: 'patient-view', title: 'Synthetic chart review',
      description: 'Local CDS Hooks transport fixture. Returns an informational card using fictional data.',
      enabled: true, callerIssuer: 'synthetic-ehr', allowedOrigins: [], createdAt: now(),
    });
  }
  app.get('/cds-services', async () => {
    const services = [];
    for (const service of await bridge.repo.list<CDSService>('cds_services')) {
      if (!service.enabled) continue;
      const installation = await bridge.repo.get<{ enabled: boolean }>('installations', service.installationId);
      if (!installation?.enabled) continue;
      services.push({ id: service.id, hook: service.hook, title: service.title, description: service.description, ...(service.prefetch ? { prefetch: service.prefetch } : {}) });
    }
    return { services };
  });
  app.post<{ Params: { id: string } }>('/cds-services/:id', async (request, reply) => {
    const service = await bridge.repo.get<CDSService>('cds_services', request.params.id);
    assert(service?.enabled, 404, 'cds_service_not_found', 'This CDS service is not available.');
    const { installation, connection } = await bridge.installation(service.installationId);
    await authenticateCaller(bridge, service, request);
    const payload = hookRequest.parse(request.body);
    assert(payload.hook === service.hook, 400, 'hook_mismatch', 'The hook does not match this CDS service.');
    if (payload.fhirServer) assert(payload.fhirServer.replace(/\/$/, '') === connection.fhirBaseUrl, 400, 'fhir_server_mismatch', 'The hook refers to a different FHIR connection.');
    assert(!payload.fhirAuthorization || payload.fhirServer, 400, 'fhir_server_required', 'FHIR authorization requires its associated FHIR server.');
    if (payload.fhirAuthorization) assert(payload.fhirAuthorization.token_type.toLowerCase() === 'bearer', 422, 'token_binding_unsupported', 'This CDS adapter supports bearer FHIR authorization.');
    let result: unknown;
    if (bridge.config.demo && service.id === 'cds_demo' && !service.handlerUrl) {
      result = { cards: [{ summary: 'SMART Flint received this synthetic patient-view hook.', indicator: 'info', source: { label: 'SMART Flint local fixture' }, detail: 'Caller authentication, hook validation and request-scoped context were processed. No clinical recommendation is being made.' }] };
    } else {
      assert(service.handlerUrl && service.handlerSecretRef, 409, 'cds_handler_missing', 'This CDS service has no configured application handler.');
      const secret = await bridge.vault.get<string>(service.handlerSecretRef);
      assert(secret, 409, 'cds_handler_credentials_missing', 'Application handler credentials are unavailable.');
      const response = await bridge.http.request(service.handlerUrl, service.allowedOrigins, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(payload),
      });
      assert(response.ok, 502, 'cds_handler_failed', 'The application CDS handler did not complete successfully.');
      result = await readJson(response);
    }
    const validated = hookResponse.safeParse(result);
    assert(validated.success, 502, 'invalid_cds_response', 'The application handler returned an invalid CDS Hooks response.');
    // Supplied clinical context, prefetch and FHIR credentials are request-bound and never persisted.
    await bridge.audit('cds.invoked', 'A CDS Hooks request completed with a validated application response.', { outcome: 'success', installationId: installation.id, tenantId: installation.tenantId });
    return reply.header('Cache-Control', 'no-store').send(validated.data);
  });
}
