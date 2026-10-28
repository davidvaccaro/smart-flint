import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Activation, CredentialResponse, TokenResponse } from '../../../packages/contracts/src/index.js';
import { digest, randomId } from '../../../packages/storage/src/index.js';
import { Bridge, later, now, validUntil } from './bridge.js';
import type { Grant, GrantSecret, Session, Continuation } from './models.js';
import { assert } from './errors.js';
import { readBody } from './network.js';

export async function authenticateActivation(bridge: Bridge, request: FastifyRequest, activationId: string) {
  const token = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(request.headers.authorization ?? '')?.[1];
  assert(token, 401, 'session_required', 'An activation session credential is required.');
  const session = await bridge.repo.get<Session>('sessions', digest(token));
  assert(session && session.activationId === activationId && validUntil(session.expiresAt), 401, 'invalid_session', 'This session does not authorize the requested activation.');
  const activation = await bridge.activation(activationId);
  assert(activation.status !== 'closed', 401, 'activation_closed', 'This activation is closed.');
  await bridge.installation(activation.installationId);
  return activation;
}
function bearer(request: FastifyRequest) { return /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]; }

export function registerAccess(app: FastifyInstance, bridge: Bridge) {
  app.get<{ Params: { id: string } }>('/api/activations/:id', async request => {
    await authenticateActivation(bridge, request, request.params.id);
    return bridge.descriptor(request.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/activations/:id', async (request, reply) => {
    await authenticateActivation(bridge, request, request.params.id);
    await bridge.closeActivation(request.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/activations/:id/credentials', async request => {
    await authenticateActivation(bridge, request, request.params.id);
    return bridge.credentials(request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/activations/:id/credentials/original', async request => {
    const activation = await authenticateActivation(bridge, request, request.params.id);
    const { installation } = await bridge.installation(activation.installationId);
    assert(installation.allowTokenExport, 403, 'token_export_disabled', 'Upstream token export is disabled for this installation.');
    const secret = await bridge.vault.get<GrantSecret>(`grant:${activation.id}`);
    assert(secret, 401, 'grant_missing', 'The original token response is no longer retained.');
    await bridge.audit('credentials.original_accessed', 'The application requested its original upstream token response.', { activationId: activation.id, tenantId: activation.tenantId });
    const grant = await bridge.repo.get<Grant>('grants', activation.id);
    const { refresh_token, ...withoutRefresh } = secret.original;
    const applicationOwns = grant?.refreshOwner === 'application';
    return { tokenResponse: applicationOwns ? secret.original : withoutRefresh, refreshOwner: grant?.refreshOwner ?? 'bridge', refreshTokenWithheld: !applicationOwns && !!refresh_token };
  });
  app.post<{ Params: { id: string } }>('/api/activations/:id/credentials/handoff', async request => {
    const activation = await authenticateActivation(bridge, request, request.params.id);
    const { installation, registration, connection } = await bridge.installation(activation.installationId);
    assert(installation.allowTokenExport && activation.mode === 'handoff', 403, 'handoff_not_enabled', 'Start this installation in credential handoff mode to transfer refresh ownership.');
    await bridge.currentToken(activation.id);
    return bridge.repo.withLock(`grant:${activation.id}`, async () => {
      const grant = await bridge.repo.get<Grant>('grants', activation.id);
      const secret = await bridge.vault.get<GrantSecret>(`grant:${activation.id}`);
      assert(grant && secret && grant.refreshOwner === 'bridge', 409, 'grant_already_handed_off', 'Credential lifecycle ownership was already transferred.');
      await bridge.repo.put('grants', { ...grant, refreshOwner: 'application', updatedAt: now() });
      await bridge.audit('grant.handed_off', 'Credential lifecycle ownership transferred to the application.', { activationId: activation.id, tenantId: activation.tenantId });
      return { baseUrl: connection.fhirBaseUrl, accessToken: secret.current.access_token, tokenType: secret.current.token_type,
        expiresAt: grant.expiresAt, grantedScopes: grant.scopes, refreshOwner: 'application',
        ...(secret.current.refresh_token ? { refreshToken: secret.current.refresh_token } : {}),
        tokenEndpoint: grant.tokenEndpoint, clientId: registration.clientId, clientAuthentication: registration.authMethod,
      } satisfies CredentialResponse;
    });
  });

  app.post('/api/service-activations', async request => {
    const { installationId } = z.object({ installationId: z.string().min(1) }).strict().parse(request.body);
    const { installation, application, connection, registration } = await bridge.installation(installationId);
    const key = await bridge.vault.get<string>(`application-key:${application.id}`);
    assert(key && bearer(request) && digest(bearer(request)!) === digest(key), 401, 'application_authentication_required', 'A valid application API key is required.');
    assert(registration.authMethod === 'private_key_jwt', 422, 'backend_registration_required', 'SMART Backend Services requires an asymmetric client registration.');
    assert(installation.scopes.filter(s => /^(patient|user|system)\//.test(s)).every(s => s.startsWith('system/')), 422, 'system_scopes_required', 'Backend service installations use system-level scopes.');
    const smart = await bridge.discover(connection, registration);
    const token = await bridge.tokenRequest(connection, registration, smart.token_endpoint, new URLSearchParams({ grant_type: 'client_credentials', scope: installation.scopes.join(' ') }));
    const activation = await bridge.establish(installation.id, token, smart.token_endpoint, installation.mode, 'service');
    const sessionToken = randomId('session');
    await bridge.repo.put<Session>('sessions', { id: digest(sessionToken), activationId: activation.id, expiresAt: later(8 * 3600) });
    return { activation: await bridge.descriptor(activation.id), sessionToken };
  });

  app.route<{ Params: { id: string; '*': string } }>({
    method: ['GET', 'HEAD'], url: '/fhir/:id/*',
    handler: async (request, reply) => {
      const activation = await authenticateActivation(bridge, request, request.params.id);
      const { installation, connection, application } = await bridge.installation(activation.installationId);
      assert(application.allowedModes.includes('gateway'), 403, 'gateway_not_allowed', 'The gateway is not enabled for this application.');
      const { token, grant } = await bridge.currentToken(activation.id);
      assert(grant.refreshOwner === 'bridge', 409, 'grant_handed_off', 'The application now owns this grant. Use the upstream server directly.');
      assert(!request.headers.accept || /json|\*\/\*/i.test(request.headers.accept), 406, 'json_required', 'This release of the FHIR gateway serves JSON representations.');
      const path = request.params['*'];
      assert(!path.includes('\\') && !path.split('/').some(p => p === '..' || p === '.'), 400, 'invalid_fhir_path', 'The FHIR path is invalid.');
      const requestUrl = new URL(request.raw.url!, bridge.config.baseUrl);
      let upstream: string;
      let continuation: Continuation | undefined;
      if (path.startsWith('_page/')) {
        continuation = await bridge.repo.get<Continuation>('continuations', path.slice(6));
        assert(continuation && continuation.activationId === activation.id && validUntil(continuation.expiresAt), 400, 'continuation_invalid', 'This continuation does not belong to the active connection or has expired.');
        upstream = continuation.url;
      } else {
        assert(/^(metadata|[A-Z][A-Za-z]+(?:\/[A-Za-z0-9.-]+(?:\/_history\/[A-Za-z0-9.-]+)?)?)$/.test(path), 422, 'interaction_unsupported', 'This release supports FHIR metadata, resource reads, version reads, and searches.');
        upstream = `${connection.fhirBaseUrl}/${path}${requestUrl.search}`;
      }
      const target = bridge.http.validate(upstream, connection.allowedOrigins, connection.fhirBaseUrl);
      const relative = target.pathname.slice(new URL(connection.fhirBaseUrl).pathname.length).replace(/^\//, '');
      const [upstreamResource, resourceId] = relative.split('/');
      const resource = continuation?.resource ?? upstreamResource;
      const action = continuation?.interaction ?? (resourceId ? 'r' : 's');
      if (resource !== 'metadata') {
        assert(grant.scopes.some(scope => scopeAllowsRead(scope, resource!, action)), 403, 'scope_denied', 'The upstream grant does not permit this resource interaction.');
        assert(installation.scopes.some(scope => scopeAllowsRead(scope, resource!, action)), 403, 'installation_scope_denied', 'This installation does not permit this resource interaction.');
      }
      const headers: Record<string, string> = { Accept: 'application/fhir+json', Authorization: `${token.token_type} ${token.access_token}` };
      if (typeof request.headers['if-none-match'] === 'string' && installation.normalizationProfile === 'passthrough') headers['If-None-Match'] = request.headers['if-none-match'];
      const response = await bridge.http.request(upstream, connection.allowedOrigins, { method: request.method, headers }, connection.fhirBaseUrl);
      const raw = await readBody(response, 10 * 1024 * 1024);
      let body = raw; let transformed = false;
      const contentType = response.headers.get('content-type') ?? 'application/fhir+json';
      if (raw.length && /json/.test(contentType)) {
        let json: Record<string, unknown>;
        try { json = JSON.parse(raw.toString('utf8')); } catch { json = {}; }
        if (json.resourceType === 'CapabilityStatement') {
          json.software = { name: 'SMART Flint', version: '0.1.0' };
          json.implementation = { description: 'Activation-scoped SMART Flint read/search gateway. Upstream permissions and restrictions still apply.', url: `${bridge.config.baseUrl}/fhir/${activation.id}` };
          json.format = ['json'];
          if (Array.isArray(json.rest)) for (const rest of json.rest as Record<string, unknown>[]) {
            delete rest.operation; delete rest.interaction;
            rest.security = { description: 'Authenticate using the SMART Flint activation bearer credential. Launch and credential APIs negotiate upstream SMART authorization.' };
            if (Array.isArray(rest.resource)) rest.resource = (rest.resource as Record<string, unknown>[]).map(entry => {
              const resourceType = typeof entry.type === 'string' ? entry.type : '';
              const supported = (action: 'r' | 's') => grant.scopes.some(scope => scopeAllowsRead(scope, resourceType, action)) && installation.scopes.some(scope => scopeAllowsRead(scope, resourceType, action));
              const interactions = Array.isArray(entry.interaction) ? (entry.interaction as { code: string }[]).filter(i => (['read', 'vread'].includes(i.code) && supported('r')) || (i.code === 'search-type' && supported('s'))) : [];
              const { operation, conditionalCreate, conditionalUpdate, conditionalDelete, updateCreate, ...resourceCapabilities } = entry;
              return { ...resourceCapabilities, interaction: interactions };
            }).filter(entry => entry.interaction.length > 0);
          }
          transformed = true;
          reply.header('X-SMART-Flint-Capabilities', 'projected');
        }
        if (json.resourceType === 'Bundle' && Array.isArray(json.link)) {
          for (const link of json.link as { relation?: string; url?: string }[]) {
            if (typeof link.url !== 'string') continue;
            let paging: URL;
            try { paging = bridge.http.validate(new URL(link.url, upstream).href, connection.allowedOrigins, connection.fhirBaseUrl); }
            catch { link.url = ''; transformed = true; continue; }
            const continuationId = randomId('page');
            await bridge.repo.put<Continuation>('continuations', { id: continuationId, activationId: activation.id, url: paging.href, resource: resource!, interaction: action, expiresAt: later(900) });
            link.url = `${bridge.config.baseUrl}/fhir/${activation.id}/_page/${continuationId}`; transformed = true;
          }
        }
        if (installation.normalizationProfile === 'display-cleanup-v1') { transformed = cleanupDisplays(json) || transformed; reply.header('X-SMART-Flint-Normalization', 'display-cleanup-v1'); }
        if (transformed) body = Buffer.from(JSON.stringify(json));
      }
      reply.code(response.status).header('Content-Type', contentType).header('Cache-Control', 'no-store');
      if (!transformed) for (const header of ['etag', 'last-modified']) { const value = response.headers.get(header); if (value) reply.header(header, value); }
      for (const header of ['retry-after', 'www-authenticate']) { const value = response.headers.get(header); if (value) reply.header(header, value); }
      await bridge.audit('fhir.request', `${request.method} ${resource ?? 'FHIR'} ${response.status}`, { activationId: activation.id, tenantId: activation.tenantId, outcome: response.ok ? 'success' : 'failure' });
      return reply.send(request.method === 'HEAD' || response.status === 304 ? undefined : body);
    },
  });
}
export function scopeAllowsRead(scope: string, resource: string, action: 'r' | 's') {
  const match = /^(patient|user|system)\/([A-Za-z]+|\*)\.(read|\*|[cruds]+)(\?.+)?$/.exec(scope);
  return !!match && (match[2] === '*' || match[2] === resource) && (match[3] === 'read' || match[3] === '*' || match[3]!.includes(action));
}
function cleanupDisplays(value: unknown): boolean {
  let changed = false;
  if (Array.isArray(value)) for (const item of value) changed = cleanupDisplays(item) || changed;
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (key === 'display' && typeof child === 'string' && child !== child.trim()) { (value as Record<string, unknown>)[key] = child.trim(); changed = true; }
    else changed = cleanupDisplays(child) || changed;
  }
  return changed;
}
