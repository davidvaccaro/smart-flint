export const CADDY_IMAGE: string;
export const POSTGRES_IMAGE: string;
export interface ProductionOptions {
  publicUrl: string;
  projectName: string;
  image: string;
  authMode?: 'local' | 'oidc';
  tlsMode?: 'external' | 'caddy';
  bindPort?: number;
  httpPort?: number;
  httpsPort?: number;
  allowPrivateNetworks?: boolean;
  retentionHours?: number;
  oidc?: { issuer: string; clientId: string; authMethod?: 'none' | 'client_secret_basic' | 'client_secret_post'; clientSecret?: string; allowedOrigins?: string[]; label?: string };
  secrets?: { encryptionKey?: string; bootstrapToken?: string; postgresPassword?: string };
}
export interface ProductionPlan {
  settings: {
    mode: 'deploy'; publicUrl: string; projectName: string; image: string; tlsMode: 'external' | 'caddy'; authMode: 'local' | 'oidc';
    bindPort?: number; allowPrivateNetworks: boolean; retentionHours: number;
    oidc?: { issuer: string; clientId: string; authMethod: string; allowedOrigins: string[]; label: string };
  };
  files: { path: string; content: string; mode: number }[];
  endpoints: { console: string; readiness: string; internalReadiness?: string; proxyTarget?: string; oidcCallback?: string };
  ports: { hostIp: string; port: number; protocol: 'tcp'; purpose: string }[];
  checks: { services: string[]; tlsVerification: 'system'; readinessUrl: string; publicDnsHostname?: string; requiresPublicPorts?: number[]; requiresExistingTlsProxy?: boolean };
}
export function httpsOrigin(value: string, name?: string): string;
export function issuerUrl(value: string): string;
export function createProductionPlan(options: ProductionOptions): ProductionPlan;
