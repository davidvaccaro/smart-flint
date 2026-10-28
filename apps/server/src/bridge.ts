import { generateKeyPair, exportJWK, importJWK, SignJWT, jwtVerify, createLocalJWKSet, decodeJwt, type JWK } from 'jose';
import type { Repository } from '../../../packages/storage/src/index.js';
import { SecretVault, randomId, digest } from '../../../packages/storage/src/index.js';
import type { Activation, ActivationDescriptor, Application, AppRegistration, AuditEvent, Connection, CredentialResponse, Installation, Registration, SmartConfiguration, TokenResponse } from '../../../packages/contracts/src/index.js';
import type { Config } from './config.js';
import type { Grant, GrantSecret } from './models.js';
import { assert, Problem } from './errors.js';
import { SafeHttp, readJson } from './network.js';
import { validateAppRegistration } from './registry.js';
import { adminAuditContext } from './admin-context.js';

export const now = () => new Date().toISOString();
export const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
export function validUntil(value?: string) { return !!value && Date.parse(value) > Date.now(); }
export function publicJWK(jwk: JWK): JWK {
  const { d, p, q, dp, dq, qi, oth, k, ...pub } = jwk;
  return pub;
}
export class Bridge {
  readonly vault: SecretVault;
  readonly http: SafeHttp;
  constructor(readonly repo: Repository, readonly config: Config) {
    this.vault = new SecretVault(repo, config.encryptionKey);
    this.http = new SafeHttp(config);
  }
  async signingKey() {
    return this.repo.withLock('bridge-signing-key', async () => {
      let key = await this.vault.get<JWK>('bridge-signing');
      if (!key) {
        const pair = await generateKeyPair('ES384', { extractable: true });
        key = { ...await exportJWK(pair.privateKey), kid: randomId('key'), alg: 'ES384', use: 'sig' };
        await this.vault.set('bridge-signing', key);
      }
      return key;
    });
  }
  async audit(action: string, detail: string, info: Partial<Pick<AuditEvent, 'outcome' | 'tenantId' | 'applicationId' | 'activationId' | 'installationId' | 'actor' | 'resource'>> = {}) {
    await this.repo.put<AuditEvent>('events', { id: randomId('evt'), at: now(), action, detail, outcome: 'info', ...adminAuditContext.getStore(), ...info });
  }
  async installation(id: string, requireEnabled = true) {
    const installation = await this.repo.get<Installation>('installations', id);
    assert(installation, 404, 'installation_not_found', 'This installation does not exist.');
    assert(!requireEnabled || installation.enabled, 403, 'installation_disabled', 'This installation is disabled.');
    const [application, connection, registration] = await Promise.all([
      this.repo.get<Application>('applications', installation.applicationId),
      this.repo.get<Connection>('connections', installation.connectionId),
      this.repo.get<Registration>('registrations', installation.registrationId),
    ]);
    assert(application && connection && registration, 409, 'installation_incomplete', 'The installation references missing configuration.');
    assert(connection.tenantId === installation.tenantId, 409, 'tenant_mismatch', 'The installation connection belongs to another tenant.');
    const appRegistration = installation.appRegistrationId ? await this.repo.get<AppRegistration>('app_registrations', installation.appRegistrationId) : undefined;
    if (installation.appRegistrationId) {
      assert(appRegistration, 409, 'installation_incomplete', 'The installation references a missing app registration.');
      await validateAppRegistration(this.repo, appRegistration, application, connection, registration);
    }
    return { installation, application, connection, registration, appRegistration };
  }
  async discover(connection: Connection, registration?: Registration): Promise<SmartConfiguration> {
    const headers: Record<string, string> = { Accept: 'application/json', ...connection.discoveryHeaders };
    if (connection.vendor === 'epic' && registration) headers['Epic-Client-ID'] = registration.clientId;
    const response = await this.http.request(`${connection.fhirBaseUrl}/.well-known/smart-configuration`, connection.allowedOrigins, { headers });
    assert(response.ok, 502, 'discovery_failed', 'SMART discovery failed for this connection.');
    const smart = await readJson<SmartConfiguration>(response);
    assert(typeof smart.token_endpoint === 'string', 502, 'invalid_discovery', 'SMART discovery did not provide a token endpoint.');
    this.http.validate(smart.token_endpoint, connection.allowedOrigins);
    if (smart.authorization_endpoint) this.http.validate(smart.authorization_endpoint, connection.allowedOrigins);
    if (smart.jwks_uri) this.http.validate(smart.jwks_uri, connection.allowedOrigins);
    return smart;
  }
  async tokenRequest(connection: Connection, registration: Registration, endpoint: string, params: URLSearchParams): Promise<TokenResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    params.set('client_id', registration.clientId);
    if (registration.authMethod === 'client_secret_basic' || registration.authMethod === 'client_secret_post') {
      const secret = registration.secretRef && await this.vault.get<string>(registration.secretRef);
      assert(secret, 409, 'credentials_missing', 'The registration has no client secret.');
      if (registration.authMethod === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(registration.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
      else params.set('client_secret', secret);
    } else if (registration.authMethod === 'private_key_jwt') {
      const jwk = registration.privateKeyRef && await this.vault.get<JWK>(registration.privateKeyRef);
      assert(jwk && jwk.d, 409, 'credentials_missing', 'The registration has no signing key.');
      const alg = jwk.alg ?? 'ES384';
      const key = await importJWK(jwk, alg);
      const jwt = await new SignJWT({}).setProtectedHeader({ alg, kid: registration.keyId ?? jwk.kid })
        .setIssuer(registration.clientId).setSubject(registration.clientId).setAudience(endpoint)
        .setIssuedAt().setExpirationTime('4m').setJti(randomId('jwt')).sign(key);
      params.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      params.set('client_assertion', jwt);
    }
    const response = await this.http.request(endpoint, connection.allowedOrigins, { method: 'POST', headers, body: params.toString() });
    assert(response.ok, 502, 'upstream_authorization_failed', 'The EHR authorization server rejected the credential request. Reauthorization or registration changes may be required.');
    const token = await readJson<TokenResponse>(response);
    assert(typeof token.access_token === 'string' && token.access_token.length > 0 && typeof token.token_type === 'string', 502, 'invalid_token_response', 'The EHR returned an invalid token response.');
    assert(token.token_type.toLowerCase() === 'bearer', 422, 'token_binding_unsupported', 'This release supports bearer grants. Sender-constrained grants require a compatible proof adapter.');
    assert(token.expires_in === undefined || (typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) && token.expires_in > 0), 502, 'invalid_token_expiry', 'The upstream token expiry must be a positive duration.');
    return token;
  }
  async establish(installationId: string, token: TokenResponse, tokenEndpoint: string, mode: Installation['mode'], kind: Activation['kind'], identity?: Activation['principal']) {
    const { installation, application } = await this.installation(installationId);
    assert(!token.authorization_details, 422, 'multiple_access_targets_unsupported', 'This release requires one FHIR access target per grant. Multi-server authorization requires an access-target adapter.');
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [];
    for (const required of application.requiredScopes) assert(scopesCover(scopes, required), 403, 'required_scope_missing', `The EHR did not grant the required scope ${required}.`);
    const context: Activation['context'] = {
      ...(typeof token.patient === 'string' ? { patient: { reference: `Patient/${token.patient}` } } : {}),
      ...(typeof token.encounter === 'string' ? { encounter: { reference: `Encounter/${token.encounter}` } } : {}),
      ...(Array.isArray(token.fhirContext) ? { fhirContext: token.fhirContext } : {}),
      ...(typeof token.intent === 'string' ? { intent: token.intent } : {}),
      extensions: Object.fromEntries(Object.entries(token).filter(([k]) => !['access_token', 'refresh_token', 'id_token', 'token_type', 'expires_in', 'scope', 'patient', 'encounter', 'fhirContext', 'intent', 'need_patient_banner', 'smart_style_url'].includes(k))),
    };
    for (const required of application.requiredContext) assert(context[required], 422, 'required_context_missing', `The EHR did not provide required ${required} context.`);
    const id = randomId('act');
    const expiresAt = typeof token.expires_in === 'number' && token.expires_in > 0 ? later(token.expires_in) : undefined;
    const activation: Activation = {
      id, applicationId: application.id, tenantId: installation.tenantId, connectionId: installation.connectionId,
      installationId, kind, status: 'ready', mode, context, grantedScopes: scopes, expiresAt,
      presentation: { ...(typeof token.need_patient_banner === 'boolean' ? { needPatientBanner: token.need_patient_banner } : {}), ...(typeof token.smart_style_url === 'string' ? { smartStyleUrl: token.smart_style_url } : {}) },
      ...(identity ? { principal: identity } : {}), createdAt: now(), updatedAt: now(),
    };
    const grant: Grant = { id, activationId: id, installationId, expiresAt, refreshOwner: 'bridge', scopes, context, tokenEndpoint, updatedAt: now() };
    // Clinical context and identities are encrypted too; administrative projections are redacted.
    await this.vault.set(`activation:${id}`, activation);
    await this.repo.put('activations', { id, installationId, tenantId: installation.tenantId, status: 'ready', createdAt: activation.createdAt });
    await this.repo.put('grants', { ...grant, context: { extensions: {} } });
    await this.vault.set(`grant:${id}`, { current: token, original: token } satisfies GrantSecret);
    await this.audit('activation.ready', 'Launch requirements satisfied; application access is ready.', { outcome: 'success', tenantId: installation.tenantId, installationId, activationId: id });
    return activation;
  }
  async activation(id: string): Promise<Activation> {
    const activation = await this.vault.get<Activation>(`activation:${id}`);
    assert(activation, 404, 'activation_not_found', 'This activation does not exist.');
    return activation;
  }
  async saveActivation(activation: Activation) {
    activation.updatedAt = now();
    await this.vault.set(`activation:${activation.id}`, activation);
    await this.repo.put('activations', { id: activation.id, installationId: activation.installationId, tenantId: activation.tenantId, status: activation.status, createdAt: activation.createdAt });
  }
  async descriptor(id: string): Promise<ActivationDescriptor> {
    const activation = await this.activation(id);
    const { installation, connection } = await this.installation(activation.installationId, false);
    const grant = await this.repo.get<Grant>('grants', id);
    return { ...activation, schemaVersion: '1.0', upstream: { baseUrl: connection.fhirBaseUrl, fhirVersion: connection.fhirVersion }, gateway: { baseUrl: `${this.config.baseUrl}/fhir/${id}` }, refreshOwner: grant?.refreshOwner ?? 'bridge', tokenExportAllowed: installation.allowTokenExport };
  }
  async currentToken(id: string): Promise<{ token: TokenResponse; grant: Grant }> {
    const result = await this.repo.withLock(`grant:${id}`, async () => {
      const activation = await this.activation(id);
      assert(activation.status === 'ready', 401, 'activation_inactive', 'This activation is no longer active.');
      const { connection, registration } = await this.installation(activation.installationId);
      let grant = await this.repo.get<Grant>('grants', id);
      let secret = await this.vault.get<GrantSecret>(`grant:${id}`);
      assert(grant && secret, 401, 'grant_missing', 'The upstream grant is no longer available.');
      assert(grant.refreshOwner === 'bridge', 409, 'grant_handed_off', 'Credential lifecycle ownership was transferred. Use the upstream credentials returned by handoff.');
      const expired = grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now() + 30000;
      if (expired && grant.refreshOwner === 'bridge') {
        try {
          let token: TokenResponse;
          if (activation.kind === 'service') {
            token = await this.tokenRequest(connection, registration, grant.tokenEndpoint, new URLSearchParams({ grant_type: 'client_credentials', scope: grant.scopes.join(' ') }));
          } else {
            assert(typeof secret.current.refresh_token === 'string', 401, 'reauthorization_required', 'The grant expired and requires a new authorization.');
            token = await this.tokenRequest(connection, registration, grant.tokenEndpoint, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: secret.current.refresh_token }));
          }
          if (!token.refresh_token && secret.current.refresh_token) token.refresh_token = secret.current.refresh_token;
          if (!token.scope) token.scope = grant.scopes.join(' ');
          assert((token.patient === undefined || `Patient/${token.patient}` === activation.context.patient?.reference) && (token.encounter === undefined || `Encounter/${token.encounter}` === activation.context.encounter?.reference), 401, 'context_changed', 'The upstream launch context changed during refresh. Start a new activation.');
          if (token.id_token) {
            const smart = await this.discover(connection, registration);
            const principal = await this.identity(token, smart, connection, registration);
            assert(!activation.principal || (principal?.issuer === activation.principal.issuer && principal.subject === activation.principal.subject), 401, 'identity_changed', 'The upstream identity changed during renewal.');
          }
          const scopes = token.scope.split(/\s+/).filter(Boolean);
          const { application } = await this.installation(activation.installationId);
          for (const required of application.requiredScopes) assert(scopesCover(scopes, required), 401, 'required_scope_missing', 'Refreshed access no longer satisfies the application requirements.');
          secret = { original: secret.original, current: token };
          grant = { ...grant, scopes, expiresAt: typeof token.expires_in === 'number' ? later(token.expires_in) : undefined, updatedAt: now() };
          await this.vault.set(`grant:${id}`, secret);
          await this.repo.put('grants', grant);
          activation.expiresAt = grant.expiresAt; activation.grantedScopes = grant.scopes;
          await this.saveActivation(activation);
          await this.audit('grant.renewed', 'Upstream access renewed by SMART Flint.', { outcome: 'success', activationId: id, tenantId: activation.tenantId, installationId: activation.installationId });
        } catch {
          activation.status = 'reauthorization_required'; await this.saveActivation(activation);
          await this.audit('grant.reauthorization_required', 'The upstream grant requires a new authorization.', { outcome: 'failure', activationId: id, tenantId: activation.tenantId });
          return { reauthorizationRequired: true as const };
        }
      } else if (expired) throw new Problem(401, 'grant_expired', 'The application owns this grant and must renew it directly.');
      return { token: secret.current, grant };
    });
    // Return the failure state before throwing so PostgreSQL commits the state transition.
    assert(!('reauthorizationRequired' in result), 401, 'reauthorization_required', 'Upstream access could not be renewed. Start a new authorization.');
    return result;
  }
  async credentials(id: string): Promise<CredentialResponse> {
    const activation = await this.activation(id);
    const { installation, connection } = await this.installation(activation.installationId);
    assert(installation.allowTokenExport, 403, 'token_export_disabled', 'Upstream token access is disabled for this installation.');
    const { token, grant } = await this.currentToken(id);
    await this.audit('credentials.accessed', 'The application requested its upstream access credential.', { activationId: id, tenantId: activation.tenantId });
    return { baseUrl: connection.fhirBaseUrl, accessToken: token.access_token, tokenType: token.token_type, expiresAt: grant.expiresAt, grantedScopes: grant.scopes, refreshOwner: grant.refreshOwner };
  }
  async closeActivation(id: string) {
    return this.repo.withLock(`grant:${id}`, async () => {
      const activation = await this.activation(id);
      activation.status = 'closed'; await this.saveActivation(activation);
      await this.vault.delete(`grant:${id}`); await this.repo.delete('grants', id);
      for (const session of await this.repo.list<{ id: string; activationId: string }>('sessions')) if (session.activationId === id) await this.repo.delete('sessions', session.id);
      await this.audit('activation.closed', 'SMART Flint access closed. Exported upstream credentials retain their upstream validity.', { activationId: id, tenantId: activation.tenantId });
      return activation;
    });
  }
  async identity(token: TokenResponse, smart: SmartConfiguration, connection: Connection, registration: Registration, nonce?: string): Promise<Activation['principal']> {
    if (!token.id_token) return undefined;
    const claimedIssuer = decodeJwt(token.id_token).iss;
    const issuer = connection.oidcIssuer ?? smart.issuer;
    assert(issuer && claimedIssuer === issuer, 502, 'identity_metadata_missing', 'Configure the approved OIDC issuer for this connection before using identity tokens.');
    let jwksUri = smart.jwks_uri;
    if (!jwksUri) {
      const discovery = await this.http.request(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, connection.allowedOrigins);
      assert(discovery.ok, 502, 'identity_metadata_missing', 'The configured OIDC issuer could not be discovered.');
      const metadata = await readJson<{ issuer: string; jwks_uri: string }>(discovery);
      assert(metadata.issuer === issuer && typeof metadata.jwks_uri === 'string', 502, 'identity_metadata_invalid', 'OIDC discovery did not match the configured issuer.');
      jwksUri = metadata.jwks_uri;
    }
    const response = await this.http.request(jwksUri, connection.allowedOrigins);
    assert(response.ok, 502, 'identity_keys_unavailable', 'The identity signing keys could not be retrieved.');
    const jwks = await readJson<{ keys: JWK[] }>(response);
    const result = await jwtVerify(token.id_token, createLocalJWKSet(jwks), { issuer, audience: registration.clientId, algorithms: ['RS256', 'RS384', 'ES256', 'ES384'], clockTolerance: 5 });
    assert(!Array.isArray(result.payload.aud) || result.payload.aud.length <= 1 || result.payload.azp === registration.clientId, 401, 'identity_invalid', 'The identity token authorized party does not match the application.');
    assert((nonce === undefined || result.payload.nonce === nonce) && typeof result.payload.sub === 'string', 401, 'identity_invalid', 'The identity token does not match this authorization.');
    return { issuer: result.payload.iss!, subject: result.payload.sub, ...(typeof result.payload.fhirUser === 'string' ? { fhirUser: result.payload.fhirUser } : {}) };
  }
}

/** Compare SMART permissions without broadening v2 action sets or granular constraints. */
export function scopeCovers(granted: string, required: string): boolean {
  if (granted === required) return true;
  const parse = (s: string) => /^((?:patient|user|system))\/([A-Za-z]+|\*)\.(read|write|\*|[cruds]+)(\?.+)?$/.exec(s);
  const g = parse(granted), r = parse(required);
  if (!g || !r || g[1] !== r[1] || (g[2] !== '*' && g[2] !== r[2]) || (g[4] && g[4] !== r[4])) return false;
  const actions = (a: string) => a === 'read' ? 'rs' : a === 'write' ? 'cud' : a === '*' ? 'cruds' : a;
  return [...actions(r[3]!)].every(a => actions(g[3]!).includes(a));
}
export function scopesCover(scopes: string[], required: string): boolean {
  const match = /^((?:patient|user|system)\/(?:[A-Za-z]+|\*)\.)(read|write|\*|[cruds]+)(\?.+)?$/.exec(required);
  if (!match) return scopes.includes(required);
  const actions = match[2] === 'read' ? 'rs' : match[2] === 'write' ? 'cud' : match[2] === '*' ? 'cruds' : match[2]!;
  return [...actions].every(action => scopes.some(scope => scopeCovers(scope, `${match[1]}${action}${match[3] ?? ''}`)));
}
