import { serviceVersion } from './version.js';
import type { FastifyInstance } from 'fastify';
import type { Bridge } from './bridge.js';

type Json = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonResponse = (schema: Json = { type: 'object' }, description = 'Successful response') => ({ description, content: { 'application/json': { schema } } });
const requestBody = (schema: Json) => ({ required: true, content: { 'application/json': { schema } } });
const parameter = (name: string, location: 'path' | 'query', description: string, required = location === 'path') => ({ name, in: location, required, description, schema: { type: 'string' } });
const adminSecurity = [{ adminBearer: [] }, { adminCookie: [] }];
const activationSecurity = [{ activationBearer: [] }];

function operation(summary: string, tag: string, options: Json = {}): Json {
  return {
    summary, tags: [tag], responses: {
      '200': jsonResponse(), '400': jsonResponse(ref('Problem'), 'Invalid request or protocol binding'),
      '401': jsonResponse(ref('Problem'), 'Authentication or reauthorization required'),
      '403': jsonResponse(ref('Problem'), 'Policy, origin or scope does not permit this request'),
    }, ...options,
  };
}

export function apiSchema(bridge: Bridge): Json {
  const paths: Record<string, Json> = {
    '/ready': { get: operation('Check database and encryption-key readiness', 'Operations', { responses: { '200': jsonResponse({ type: 'object', properties: { status: { const: 'ready' } } }), '503': jsonResponse({ type: 'object', properties: { status: { const: 'not_ready' } } }, 'A required dependency is unavailable') } }) },
    '/api/admin/operations': { get: operation('Read aggregate process operational counters', 'Operations', { security: adminSecurity, description: 'Platform administrator only. Process-local request, readiness and maintenance counters; contains no patient data or request URLs.' }) },
    '/health': { get: operation('Check service health', 'Operations') },
    '/api/openapi.json': { get: operation('Read this OpenAPI contract', 'Operations') },
    '/api/admin/session': {
      get: operation('Check administrative identity and sign-in methods', 'Administration', { responses: { '200': jsonResponse(ref('AdminSessionStatus')) } }),
      post: operation('Sign in with the configured local credentials or initial bootstrap method', 'Administration', { description: 'ADMIN_AUTH_MODE=local accepts username/password. OIDC-only deployments reject local password sign-in. Bootstrap and passwordless demo access are independently gated; production bootstrap ends after an enabled owner for the selected method exists.', requestBody: requestBody({ oneOf: [ref('AdminLocalLogin'), { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', writeOnly: true, description: 'Explicit first-owner setup token. Empty only for approved loopback demo login.' } } }] }) }),
      delete: operation('Close the administrative session', 'Administration', { security: adminSecurity }),
    },
    '/api/admin/password': {
      post: operation('Change the signed-in local administrator password', 'Administration', { security: [{ adminCookie: [] }], description: 'Local mode only. Requires the current password, a named local session and an approved Origin. Available to all local roles, including viewers. Rotates the credential version and invalidates all earlier local sessions; sign in again afterward.', requestBody: requestBody({ type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false, properties: { currentPassword: { type: 'string', writeOnly: true, maxLength: 1024 }, newPassword: { type: 'string', writeOnly: true, minLength: 15, maxLength: 128 } } }), responses: { '200': jsonResponse({ type: 'object', properties: { changed: { const: true }, reauthenticationRequired: { const: true } } }), '429': jsonResponse(ref('Problem'), 'Too many password verification attempts') } }),
    },
    '/api/admin/oidc/login': {
      get: operation('Start organization OIDC sign-in with PKCE and browser binding', 'Administration', { responses: { '302': { description: 'Redirect to the configured identity provider or a fixed console failure page' } } }),
    },
    '/api/admin/oidc/callback': {
      get: operation('Validate the OIDC response and create a named administrative session', 'Administration', { description: 'Configured identity-provider callback. Single-use state, browser binding, PKCE, nonce and signed ID-token validation are required. Exact issuer and subject must match a provisioned active user.', responses: { '302': { description: 'Return to the configured console; token material is never returned in the redirect' } } }),
    },
    '/api/admin/users': {
      get: operation('List named administrative users', 'Administration', { security: adminSecurity, description: 'Platform administrator only.', responses: { '200': jsonResponse({ type: 'array', items: ref('AdminUser') }) } }),
      post: operation('Provision a local or identity-provider administrator and assign access', 'Administration', { security: adminSecurity, description: 'Platform administrator only. Local mode accepts a username and write-only initial password. OIDC mode accepts an exact immutable issuer/subject identity. Passwords and password hashes are never included in user metadata. Email and identity-provider group claims never authorize access.', requestBody: requestBody(ref('AdminUserInput')), responses: { '201': jsonResponse(ref('AdminUser')) } }),
    },
    '/api/admin/users/{userId}': {
      parameters: [parameter('userId', 'path', 'Named administrative user ID')],
      patch: operation('Update a user role, assignments, display information or disabled state', 'Administration', { security: adminSecurity, description: 'Platform administrator only. Permissions change on the next request, including existing sessions. The final enabled platform administrator cannot be disabled or demoted.', requestBody: requestBody(ref('AdminUserPatch')), responses: { '200': jsonResponse(ref('AdminUser')) } }),
    },
    '/api/admin/dashboard': { get: operation('Read assigned configuration, redacted activations and operational events', 'Administration', { security: adminSecurity, description: 'Organization and application assignments both apply. Shared metadata is projected to visible associations; access describes per-resource manageability. Audit records include named actors and resource targets.' }) },
    '/api/admin/platforms/{platformId}': {
      parameters: [parameter('platformId', 'path', 'Managed EHR integration platform ID')],
      get: operation('Read an EHR integration platform', 'Administration', { security: adminSecurity }),
      patch: operation('Update EHR platform metadata', 'Administration', { security: adminSecurity, requestBody: requestBody(ref('PlatformPatch')), description: 'Built-in adapter vendors and referenced platform adapter vendors cannot be changed.' }),
    },
    '/api/admin/app-registrations/{appRegistrationId}': {
      parameters: [parameter('appRegistrationId', 'path', 'Logical EHR portal registration ID')],
      get: operation('Read an EHR portal app registration', 'Administration', { security: adminSecurity }),
      patch: operation('Update portal registration metadata and application associations', 'Administration', { security: adminSecurity, requestBody: requestBody(ref('AppRegistrationPatch')), description: 'Application associations referenced by installations cannot be removed. OAuth client profiles retain their IDs and credentials.' }),
    },
    '/api/admin/app-registrations/{appRegistrationId}/clients': {
      parameters: [parameter('appRegistrationId', 'path', 'Logical EHR portal registration ID')],
      post: operation('Add an environment-specific OAuth client profile to a portal registration', 'Administration', { security: adminSecurity, requestBody: requestBody(ref('RegistrationInput')), description: 'The EHR platform and vendor are inherited from the portal registration. Select sandbox, production or unspecified environment. Secrets and private signing keys are encrypted and never returned.', responses: { '201': jsonResponse() } }),
    },
    '/api/admin/applications/{applicationId}': {
      parameters: [parameter('applicationId', 'path', 'Configured application ID')],
      patch: operation('Update application configuration', 'Administration', { security: adminSecurity, requestBody: requestBody(ref('ApplicationPatch')) }),
    },
    '/api/admin/tenants/{tenantId}': {
      parameters: [parameter('tenantId', 'path', 'Healthcare organization ID')],
      patch: operation('Update an organization name', 'Administration', { security: adminSecurity, requestBody: requestBody({ type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 } } }) }),
    },
    '/api/admin/applications/{applicationId}/credentials': {
      parameters: [parameter('applicationId', 'path', 'Configured application ID')],
      post: operation('Rotate an application API key and return it once', 'Administration', {
        security: adminSecurity, responses: { '200': jsonResponse({ type: 'object', properties: { applicationId: { type: 'string' }, apiKey: { type: 'string', description: 'Sensitive one-time delivery; do not log.' } } }, 'New key. Store securely; it is not included in the dashboard.') },
      }),
    },
    '/api/admin/installations/{installationId}': {
      parameters: [parameter('installationId', 'path', 'Configured installation ID')],
      patch: operation('Update installation access and normalization policy', 'Administration', { security: adminSecurity, requestBody: requestBody({ type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, enabled: { type: 'boolean' }, mode: ref('AccessMode'), allowTokenExport: { type: 'boolean' }, normalizationProfile: { enum: ['passthrough', 'display-cleanup-v1'] } } }) }),
    },
    '/api/admin/connections/{connectionId}/verify': {
      parameters: [parameter('connectionId', 'path', 'Configured tenant connection ID')],
      post: operation('Verify SMART discovery for a connection', 'Administration', { security: adminSecurity, description: 'Discovery verification does not establish end-to-end launch or resource compatibility. An optional registrationId selects client-dependent discovery.', requestBody: { ...requestBody({ type: 'object', properties: { registrationId: { type: 'string' } }, additionalProperties: false }), required: false } }),
    },
    '/api/admin/installations/{installationId}/worksheet': {
      parameters: [parameter('installationId', 'path', 'Configured installation ID')],
      get: operation('Generate exact vendor registration URLs and remaining onboarding tasks', 'Administration', { security: adminSecurity }),
    },
    '/api/admin/activations/{activationId}/close': {
      parameters: [parameter('activationId', 'path', 'Activation to close')],
      post: operation('Close bridge access for an activation', 'Administration', { security: adminSecurity, description: 'Exported upstream credentials retain upstream validity until expiry or upstream revocation.' }),
    },
    '/api/admin/cds-services': {
      get: operation('List configured CDS service trust and handler metadata', 'Administration', { security: adminSecurity }),
      post: operation('Configure a CDS service and return its handler secret once', 'Administration', { security: adminSecurity, requestBody: requestBody(ref('CdsServiceInput')), responses: { '201': jsonResponse({ type: 'object', properties: { service: { type: 'object' }, handlerSecret: { type: 'string', description: 'Sensitive one-time delivery; do not log.' } } }) } }),
    },
    '/launch/{installationId}': {
      parameters: [parameter('installationId', 'path', 'Registered application installation'), parameter('iss', 'query', 'Exact approved upstream FHIR base URL', true), parameter('launch', 'query', 'Opaque upstream launch handle', true)],
      get: operation('Receive an EHR launch and establish application browser binding', 'Interactive launch', { responses: { '302': { description: 'Redirect to an approved application callback with a short-lived bootstrap ticket' } } }),
    },
    '/api/launches/bootstrap/{ticket}': {
      parameters: [parameter('ticket', 'path', 'Short-lived EHR bootstrap ticket')],
      get: operation('Resolve an EHR bootstrap ticket to its installation', 'Interactive launch'),
    },
    '/api/launches': {
      post: operation('Create a downstream PKCE-bound launch transaction', 'Interactive launch', { requestBody: requestBody(ref('LaunchRequest')), responses: { '200': jsonResponse(ref('LaunchStart')) } }),
    },
    '/launch/start/{ticket}': {
      parameters: [parameter('ticket', 'path', 'Short-lived prepared launch ticket')],
      get: operation('Start upstream SMART authorization in the browser', 'Interactive launch', { responses: { '302': { description: 'Redirect to the configured upstream authorization endpoint' } } }),
    },
    '/oauth/callback/{connectionId}': {
      parameters: [parameter('connectionId', 'path', 'Connection bound to the authorization transaction'), parameter('state', 'query', 'Upstream authorization state', true), parameter('code', 'query', 'Upstream authorization code'), parameter('error', 'query', 'Upstream OAuth error')],
      get: operation('Complete upstream authorization and deliver a one-use application code', 'Interactive launch', { responses: { '302': { description: 'Redirect to the exact application callback with an activation code or safe error code' } } }),
    },
    '/api/activations/redeem': {
      post: operation('Redeem a one-use activation code with the downstream PKCE verifier', 'Interactive launch', { requestBody: requestBody(ref('RedeemRequest')), responses: { '200': jsonResponse(ref('ActivationSession')) } }),
    },
    '/api/activations/{activationId}': {
      parameters: [parameter('activationId', 'path', 'Activation bound to the supplied bearer session')],
      get: operation('Read activation context, endpoints and access capabilities', 'Activation access', { security: activationSecurity, responses: { '200': jsonResponse(ref('ActivationDescriptor')) } }),
      delete: operation('Close the application activation session', 'Activation access', { security: activationSecurity }),
    },
    '/api/activations/{activationId}/credentials': {
      parameters: [parameter('activationId', 'path', 'Activation bound to the supplied bearer session')],
      get: operation('Obtain current original upstream access credentials', 'Activation access', { security: activationSecurity, description: 'Requires token export policy. SMART Flint renews access when it owns refresh. Response must not be cached or logged.', responses: { '200': jsonResponse(ref('CredentialResponse')) } }),
    },
    '/api/activations/{activationId}/credentials/original': {
      parameters: [parameter('activationId', 'path', 'Activation bound to the supplied bearer session')],
      get: operation('Retrieve the original upstream token response', 'Activation access', { security: activationSecurity, description: 'Sensitive response envelope. The original access token may have expired; use current credentials for active requests. A refresh token is withheld while SMART Flint owns renewal. Complete an explicit compatible handoff to transfer refresh ownership.', responses: { '200': jsonResponse(ref('OriginalCredentialResponse')) } }),
    },
    '/api/activations/{activationId}/credentials/handoff': {
      parameters: [parameter('activationId', 'path', 'Activation bound to the supplied bearer session')],
      post: operation('Transfer supported credential lifecycle ownership to the application', 'Activation access', { security: activationSecurity, description: 'Requires enabled export and a compatible upstream grant. Confidential-client refresh credentials and sender-constrained grants cannot be made portable by token export alone.' }),
    },
    '/api/service-activations': {
      post: operation('Acquire preauthorized backend FHIR access', 'Backend services', { security: [{ applicationKey: [] }], requestBody: requestBody({ type: 'object', required: ['installationId'], additionalProperties: false, properties: { installationId: { type: 'string' } } }), responses: { '200': jsonResponse(ref('ActivationSession')) } }),
    },
    '/fhir/{activationId}/{resourcePath}': {
      parameters: [parameter('activationId', 'path', 'Activation bound to the supplied bearer session'), parameter('resourcePath', 'path', 'FHIR resource read/search path, possibly containing slashes')],
      get: operation('Read or search through the activation-bound FHIR gateway', 'FHIR gateway', { security: activationSecurity, description: 'Use an ordinary FHIR client with this activation base URL and bearer credential. Release 0.1 supports reads/searches, controlled pagination and explicit display cleanup. Clinical writes and arbitrary operations are rejected.', responses: { '200': { description: 'FHIR resource, Bundle or OperationOutcome; upstream status and supported headers are preserved', content: { 'application/fhir+json': { schema: { type: 'object' } } } } } }),
      head: operation('Read gateway response headers', 'FHIR gateway', { security: activationSecurity }),
    },
    '/cds-services': { get: operation('Discover enabled CDS Hooks services', 'CDS Hooks') },
    '/cds-services/{serviceId}': {
      parameters: [parameter('serviceId', 'path', 'Configured CDS service ID')],
      post: operation('Execute an authenticated synchronous CDS Hooks request', 'CDS Hooks', { security: [{ cdsCallerJwt: [] }], description: 'Caller JWT trust and request FHIR authorization are distinct. Prefetch and any delegated FHIR access are invocation-bound.', requestBody: requestBody({ type: 'object', required: ['hook', 'hookInstance', 'context'], properties: { hook: { type: 'string' }, hookInstance: { type: 'string' }, context: { type: 'object' }, fhirServer: { type: 'string' }, fhirAuthorization: { type: 'object', writeOnly: true }, prefetch: { type: 'object' } } }) }),
    },
    '/.well-known/jwks.json': { get: operation('Read public bridge signing keys', 'Operations') },
    '/.well-known/jwks/{registrationId}': {
      parameters: [parameter('registrationId', 'path', 'Upstream registration ID')],
      get: operation('Read public signing keys for an upstream registration', 'Operations'),
    },
  };
  for (const [collection, schema] of [['tenants', 'TenantInput'], ['platforms', 'PlatformInput'], ['applications', 'ApplicationInput'], ['connections', 'ConnectionInput'], ['app-registrations', 'AppRegistrationInput'], ['registrations', 'RegistrationInput'], ['installations', 'InstallationInput']] as const) {
    paths[`/api/admin/${collection}`] = { post: operation(`Create ${collection.slice(0, -1)} configuration`, 'Administration', { security: adminSecurity, requestBody: requestBody(ref(schema)), responses: { '201': jsonResponse(), '400': jsonResponse(ref('Problem'), 'Invalid configuration'), '409': jsonResponse(ref('Problem'), 'Conflicting configuration') } }) };
  }
  for (const collection of ['platforms', 'app-registrations', 'registrations']) {
    paths[`/api/admin/${collection}`]!.get = operation(`List ${collection} metadata`, 'Administration', { security: adminSecurity, responses: { '200': jsonResponse({ type: 'array', items: { type: 'object' } }) } });
  }
  const stringArray = { type: 'array', items: { type: 'string' } };
  return {
    openapi: '3.1.0', info: { title: 'SMART Flint API', version: serviceVersion, description: 'Self-hosted SMART launch, credential and FHIR integration foundation. SDK use and FHIR gateway use are independently optional. Synthetic local environments do not establish vendor certification.' },
    servers: [{ url: bridge.config.baseUrl }], paths,
    tags: ['Administration', 'Interactive launch', 'Activation access', 'Backend services', 'FHIR gateway', 'CDS Hooks', 'Operations'].map(name => ({ name })),
    components: {
      securitySchemes: {
        adminBearer: { type: 'http', scheme: 'bearer', description: 'Explicit first-owner bootstrap ADMIN_TOKEN only; disabled in production after an enabled platform administrator exists. Local demo tokens are development-only.' },
        adminCookie: { type: 'apiKey', in: 'cookie', name: 'smart_flint_admin', description: 'Opaque administrative session; cookie-authenticated mutations require an approved Origin header.' },
        activationBearer: { type: 'http', scheme: 'bearer', description: 'Application session credential scoped to one activation; not an upstream FHIR access token.' },
        applicationKey: { type: 'http', scheme: 'bearer', description: 'Application API key issued by the administrative credential endpoint.' },
        cdsCallerJwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Short-lived signed caller JWT verified against configured issuer, audience and keys.' },
      },
      schemas: {
        AdminRole: { type: 'string', enum: ['platform_admin', 'integration_admin', 'viewer'] },
        AdminIdentity: { type: 'object', required: ['id', 'displayName', 'kind', 'role', 'organizationIds', 'applicationIds'], properties: {
          id: { type: 'string' }, displayName: { type: 'string' }, kind: { enum: ['local', 'oidc', 'bootstrap', 'demo'] }, username: { type: 'string' }, role: ref('AdminRole'), organizationIds: stringArray, applicationIds: stringArray,
        } },
        AdminSessionStatus: { type: 'object', required: ['authenticated', 'demo', 'oidcEnabled', 'bootstrapEnabled'], properties: {
          authenticated: { type: 'boolean' }, demo: { type: 'boolean' }, authMode: { enum: ['demo', 'local', 'oidc'] }, localEnabled: { type: 'boolean' }, oidcEnabled: { type: 'boolean' }, oidcLoginUrl: { type: 'string', format: 'uri' }, oidcLabel: { type: 'string' }, bootstrapEnabled: { type: 'boolean' }, identity: ref('AdminIdentity'),
        } },
        AdminUser: { type: 'object', required: ['id', 'displayName', 'role', 'organizationIds', 'applicationIds', 'disabled', 'createdAt', 'updatedAt'], properties: {
          id: { type: 'string' }, authMethod: { enum: ['local', 'oidc'] }, username: { type: 'string' }, issuer: { type: 'string', format: 'uri' }, subject: { type: 'string' }, displayName: { type: 'string' }, email: { type: 'string', format: 'email' }, role: ref('AdminRole'), organizationIds: stringArray, applicationIds: stringArray, disabled: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
        } },
        AdminOidcUserInput: { type: 'object', additionalProperties: false, required: ['issuer', 'subject', 'displayName', 'role', 'organizationIds', 'applicationIds'], properties: {
          authMethod: { const: 'oidc' }, issuer: { type: 'string', format: 'uri', maxLength: 2048 }, subject: { type: 'string', minLength: 1, maxLength: 512 }, displayName: { type: 'string', minLength: 1, maxLength: 120 }, email: { type: 'string', format: 'email', maxLength: 320 }, role: ref('AdminRole'), organizationIds: stringArray, applicationIds: stringArray, disabled: { type: 'boolean', default: false },
        } },
        AdminUserInput: { oneOf: [ref('AdminLocalUserInput'), ref('AdminOidcUserInput')] },
        AdminLocalLogin: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', writeOnly: true, maxLength: 1024 } } },
        AdminLocalUserInput: { type: 'object', additionalProperties: false, required: ['username', 'password', 'displayName', 'role', 'organizationIds', 'applicationIds'], properties: {
          authMethod: { const: 'local' }, username: { type: 'string', minLength: 1, maxLength: 64, description: 'ASCII letters/digits plus dots, underscores or hyphens; normalized case-insensitively.' }, password: { type: 'string', writeOnly: true, minLength: 15, maxLength: 128 }, displayName: { type: 'string', minLength: 1, maxLength: 120 }, email: { type: 'string', format: 'email', maxLength: 320 }, role: ref('AdminRole'), organizationIds: stringArray, applicationIds: stringArray, disabled: { type: 'boolean', default: false },
        } },
        AdminUserPatch: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 120 }, email: { type: 'string', format: 'email', maxLength: 320 }, role: ref('AdminRole'), organizationIds: stringArray, applicationIds: stringArray, disabled: { type: 'boolean' },
        } },
        AccessMode: { type: 'string', enum: ['gateway', 'direct', 'handoff'] },
        Problem: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } } },
        TenantInput: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', maxLength: 120 }, slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' } } },
        PlatformInput: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', maxLength: 120 }, vendor: { enum: ['generic', 'epic', 'oracle', 'meditech'] }, description: { type: 'string', maxLength: 2000 }, documentationUrl: { type: 'string', format: 'uri' } } },
        PlatformPatch: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: { type: 'string', maxLength: 120 }, vendor: { enum: ['generic', 'epic', 'oracle', 'meditech'] }, description: { type: 'string', maxLength: 2000 }, documentationUrl: { type: 'string', format: 'uri' } } },
        AppRegistrationInput: { type: 'object', additionalProperties: false, required: ['name', 'platformId'], properties: { name: { type: 'string', maxLength: 120 }, platformId: { type: 'string' }, applicationIds: stringArray, audience: { enum: ['patient', 'clinician', 'backend', 'unspecified'] }, clientRegistrationIds: stringArray, portalUrl: { type: 'string', format: 'uri' } } },
        AppRegistrationPatch: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: { type: 'string', maxLength: 120 }, applicationIds: stringArray, audience: { enum: ['patient', 'clinician', 'backend', 'unspecified'] }, portalUrl: { type: 'string', format: 'uri' } } },
        ApplicationInput: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, callbackUrls: stringArray, requiredContext: { type: 'array', items: { enum: ['patient', 'encounter'] } }, requiredScopes: stringArray, allowedModes: { type: 'array', items: ref('AccessMode') } } },
        ApplicationPatch: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: { type: 'string' }, description: { type: 'string' }, callbackUrls: stringArray, requiredContext: { type: 'array', items: { enum: ['patient', 'encounter'] } }, requiredScopes: stringArray, allowedModes: { type: 'array', items: ref('AccessMode') } } },
        ConnectionInput: { type: 'object', additionalProperties: false, required: ['name', 'tenantId', 'fhirBaseUrl'], properties: { name: { type: 'string' }, tenantId: { type: 'string' }, platformId: { type: 'string' }, vendor: { enum: ['generic', 'epic', 'oracle', 'meditech'] }, fhirBaseUrl: { type: 'string', format: 'uri' }, oidcIssuer: { type: 'string', format: 'uri' }, environment: { enum: ['sandbox', 'production'] }, fhirVersion: { type: 'string' }, allowedOrigins: stringArray, discoveryHeaders: { type: 'object', additionalProperties: { type: 'string' } } } },
        RegistrationInput: { type: 'object', additionalProperties: false, required: ['name', 'clientId'], properties: { name: { type: 'string' }, platformId: { type: 'string' }, environment: { enum: ['sandbox', 'production', 'unspecified'] }, vendor: { enum: ['generic', 'epic', 'oracle', 'meditech'] }, clientId: { type: 'string' }, authMethod: { enum: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'] }, secret: { type: 'string', writeOnly: true }, privateKey: { oneOf: [{ type: 'string' }, { type: 'object' }], writeOnly: true }, keyId: { type: 'string' } } },
        InstallationInput: { type: 'object', additionalProperties: false, required: ['name', 'applicationId', 'tenantId', 'connectionId', 'registrationId', 'scopes'], properties: { name: { type: 'string' }, applicationId: { type: 'string' }, tenantId: { type: 'string' }, connectionId: { type: 'string' }, registrationId: { type: 'string' }, appRegistrationId: { type: 'string' }, mode: ref('AccessMode'), enabled: { type: 'boolean' }, scopes: stringArray, allowTokenExport: { type: 'boolean' }, normalizationProfile: { enum: ['passthrough', 'display-cleanup-v1'] } } },
        CdsServiceInput: { type: 'object', additionalProperties: false, required: ['installationId', 'hook', 'title', 'description', 'handlerUrl', 'callerIssuer', 'callerJwksUrl'], properties: { installationId: { type: 'string' }, hook: { enum: ['patient-view', 'encounter-start', 'order-select', 'order-sign'] }, title: { type: 'string' }, description: { type: 'string' }, handlerUrl: { type: 'string', format: 'uri' }, callerIssuer: { type: 'string' }, callerJwksUrl: { type: 'string', format: 'uri' }, prefetch: { type: 'object', additionalProperties: { type: 'string' }, description: 'CDS Hooks FHIR prefetch templates published in discovery.' } } },
        LaunchRequest: { type: 'object', additionalProperties: false, required: ['installationId', 'redirectUri', 'codeChallenge', 'state'], properties: { installationId: { type: 'string' }, redirectUri: { type: 'string' }, codeChallenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, state: { type: 'string', minLength: 24, maxLength: 256 }, mode: ref('AccessMode'), launchTicket: { type: 'string' } } },
        LaunchStart: { type: 'object', required: ['launchUrl', 'expiresAt', 'applicationId'], properties: { launchUrl: { type: 'string', format: 'uri' }, expiresAt: { type: 'string', format: 'date-time' }, applicationId: { type: 'string' } } },
        RedeemRequest: { type: 'object', additionalProperties: false, required: ['code', 'codeVerifier', 'applicationId', 'redirectUri'], properties: { code: { type: 'string' }, codeVerifier: { type: 'string', minLength: 43, maxLength: 128, writeOnly: true }, applicationId: { type: 'string' }, redirectUri: { type: 'string' } } },
        ActivationSession: { type: 'object', required: ['activation', 'sessionToken'], properties: { activation: ref('ActivationDescriptor'), sessionToken: { type: 'string', description: 'Sensitive bearer session credential; do not persist in browser storage.' } } },
        ActivationDescriptor: { type: 'object', required: ['schemaVersion', 'id', 'installationId', 'applicationId', 'tenantId', 'connectionId', 'kind', 'status', 'mode', 'context', 'upstream', 'gateway', 'refreshOwner', 'tokenExportAllowed'], properties: { schemaVersion: { const: '1.0' }, id: { type: 'string' }, installationId: { type: 'string' }, applicationId: { type: 'string' }, tenantId: { type: 'string' }, connectionId: { type: 'string' }, kind: { enum: ['interactive', 'service'] }, status: { enum: ['received', 'authorizing', 'ready', 'reauthorization_required', 'failed', 'closed'] }, mode: ref('AccessMode'), context: { type: 'object' }, upstream: { type: 'object', properties: { baseUrl: { type: 'string' }, fhirVersion: { type: 'string' } } }, gateway: { type: 'object', properties: { baseUrl: { type: 'string' } } }, refreshOwner: { enum: ['bridge', 'application'] }, tokenExportAllowed: { type: 'boolean' }, grantedScopes: stringArray, expiresAt: { type: 'string', format: 'date-time' } } },
        CredentialResponse: { type: 'object', required: ['baseUrl', 'accessToken', 'tokenType', 'grantedScopes', 'refreshOwner'], properties: { baseUrl: { type: 'string', format: 'uri' }, accessToken: { type: 'string', description: 'Sensitive original upstream credential; do not cache or log.' }, tokenType: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' }, grantedScopes: stringArray, refreshOwner: { enum: ['bridge', 'application'] } } },
        OriginalCredentialResponse: { type: 'object', required: ['tokenResponse', 'refreshOwner', 'refreshTokenWithheld'], properties: { tokenResponse: { type: 'object', description: 'Original response fields. refresh_token is withheld while bridge-managed; access-token and vendor extension values remain unchanged.', additionalProperties: true }, refreshOwner: { enum: ['bridge', 'application'] }, refreshTokenWithheld: { type: 'boolean' } } },
      },
    },
  };
}

export function registerOpenApi(app: FastifyInstance, bridge: Bridge): void {
  app.get('/api/openapi.json', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return apiSchema(bridge);
  });
}
