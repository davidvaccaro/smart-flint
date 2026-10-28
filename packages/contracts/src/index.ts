export type Vendor = 'generic' | 'epic' | 'oracle' | 'meditech';
export type AccessMode = 'gateway' | 'direct' | 'handoff';
export type PrincipalKind = 'interactive' | 'service';
export type ActivationStatus = 'received' | 'authorizing' | 'ready' | 'reauthorization_required' | 'failed' | 'closed';
export type AdminRole = 'platform_admin' | 'integration_admin' | 'viewer';
export type AdminAuthMode = 'local' | 'oidc';
export interface AdminUser {
  id: string; authMethod?: AdminAuthMode; issuer?: string; subject?: string; username?: string; displayName: string; email?: string;
  role: AdminRole; organizationIds: string[]; applicationIds: string[];
  disabled: boolean; createdAt: string; updatedAt: string;
}
export interface AdminIdentity {
  id: string; displayName: string; kind: 'oidc' | 'local' | 'bootstrap' | 'demo'; username?: string;
  role: AdminRole; organizationIds: string[]; applicationIds: string[];
}
export interface AdminSessionStatus {
  authenticated: boolean; demo: boolean; oidcEnabled: boolean; oidcLoginUrl?: string; oidcLabel?: string;
  authMode?: AdminAuthMode | 'demo'; localEnabled?: boolean;
  bootstrapEnabled: boolean; identity?: AdminIdentity;
}
export type AdminResource = 'tenants' | 'applications' | 'connections' | 'registrations' | 'appRegistrations' | 'installations' | 'activations' | 'cdsServices';
export interface AdminAccess {
  identity: AdminIdentity; platformAdmin: boolean; canWrite: boolean;
  authMode?: AdminAuthMode | 'demo';
  manageable: Record<AdminResource, string[]>;
}
export interface Tenant { id: string; name: string; slug: string; createdAt: string }
/** A managed integration platform; vendor selects the protocol adapter. */
export interface EHRPlatform {
  id: string; name: string; vendor: Vendor; description: string;
  documentationUrl?: string; createdAt: string;
}
export interface Application {
  id: string; name: string; description: string; callbackUrls: string[];
  requiredContext: ('patient' | 'encounter')[]; requiredScopes: string[];
  allowedModes: AccessMode[]; createdAt: string;
}
export interface Connection {
  id: string; tenantId: string; name: string; vendor: Vendor; platformId?: string; fhirBaseUrl: string;
  environment: 'sandbox' | 'production'; fhirVersion: string;
  allowedOrigins: string[]; discoveryHeaders?: Record<string, string>;
  oidcIssuer?: string;
  status: 'unverified' | 'verified' | 'unavailable'; lastVerifiedAt?: string;
  capabilities?: string[]; smartConfiguration?: SmartConfiguration; createdAt: string;
}
export interface SmartConfiguration {
  authorization_endpoint?: string; token_endpoint: string; issuer?: string;
  jwks_uri?: string; capabilities?: string[]; scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[]; code_challenge_methods_supported?: string[];
  [key: string]: unknown;
}
export interface Registration {
  id: string; name: string; vendor: Vendor; clientId: string;
  platformId?: string; environment?: 'sandbox' | 'production' | 'unspecified';
  authMethod: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';
  secretRef?: string; privateKeyRef?: string; keyId?: string;
  createdAt: string;
}
/** A portal app registration groups its environment-specific OAuth client profiles. */
export interface AppRegistration {
  id: string; name: string; platformId: string; applicationIds: string[];
  audience: 'patient' | 'clinician' | 'backend' | 'unspecified';
  clientRegistrationIds: string[]; portalUrl?: string; createdAt: string;
}
export interface Installation {
  id: string; name: string; applicationId: string; tenantId: string;
  connectionId: string; registrationId: string; appRegistrationId?: string; mode: AccessMode;
  enabled: boolean; scopes: string[]; allowTokenExport: boolean;
  normalizationProfile: 'passthrough' | 'display-cleanup-v1'; createdAt: string;
}
export interface LaunchContext {
  patient?: { reference: string }; encounter?: { reference: string };
  fhirContext?: unknown[]; intent?: string; extensions: Record<string, unknown>;
}
export interface Activation {
  id: string; installationId: string; applicationId: string; tenantId: string;
  connectionId: string; kind: PrincipalKind; status: ActivationStatus;
  mode: AccessMode; context: LaunchContext;
  grantedScopes: string[]; expiresAt?: string;
  presentation: { needPatientBanner?: boolean; smartStyleUrl?: string };
  principal?: { issuer: string; subject: string; fhirUser?: string };
  error?: { code: string; message: string }; createdAt: string; updatedAt: string;
}
export interface ActivationDescriptor extends Activation {
  schemaVersion: '1.0'; upstream: { baseUrl: string; fhirVersion: string };
  gateway: { baseUrl: string }; refreshOwner: 'bridge' | 'application';
  tokenExportAllowed: boolean;
}
export interface TokenResponse {
  access_token: string; token_type: string; expires_in?: number; scope?: string;
  refresh_token?: string; id_token?: string; patient?: string; encounter?: string;
  [key: string]: unknown;
}
export interface CredentialResponse {
  baseUrl: string; accessToken: string; tokenType: string; expiresAt?: string;
  grantedScopes: string[]; refreshOwner: 'bridge' | 'application';
  refreshToken?: string; tokenEndpoint?: string; clientId?: string;
  clientAuthentication?: Registration['authMethod'];
}
export interface ActivationSession { activation: ActivationDescriptor; sessionToken: string }
export interface OriginalCredentialResponse {
  tokenResponse: TokenResponse; refreshOwner: 'bridge' | 'application'; refreshTokenWithheld: boolean;
}
export interface AuditEvent {
  id: string; at: string; action: string; outcome: 'success' | 'failure' | 'info';
  tenantId?: string; applicationId?: string; installationId?: string; activationId?: string;
  detail: string;
  actor?: Pick<AdminIdentity, 'id' | 'displayName' | 'kind' | 'role'>;
  resource?: { type: string; id: string };
}
export interface Registry {
  platforms: EHRPlatform[]; appRegistrations: AppRegistration[];
  tenants: Tenant[]; applications: Application[]; connections: Connection[];
  registrations: Registration[]; installations: Installation[];
}
export interface Dashboard extends Registry {
  activations: Activation[]; events: AuditEvent[];
  access?: AdminAccess;
  runtime: { version: string; storage: string; demo: boolean; baseUrl: string; consoleUrl: string;
    samples?: { patientUrl: string; cdsUrl: string; fhirUrl: string; mockEhrUrl: string } };
}
export interface LaunchRequest {
  installationId: string; redirectUri: string; codeChallenge: string;
  state: string; mode?: AccessMode; launchTicket?: string;
}
export interface LaunchStart { launchUrl: string; expiresAt: string; applicationId: string }
export interface RedeemRequest { code: string; codeVerifier: string; applicationId: string; redirectUri: string }
export interface ApiProblem { code: string; message: string; requestId?: string }
