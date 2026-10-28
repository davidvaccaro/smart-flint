import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import type { AdminAuthMode } from '../../../packages/contracts/src/index.js';

function findRoot() {
  let path = resolve(process.cwd());
  while (dirname(path) !== path) {
    const file = join(path, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === 'smart-flint') return path;
    path = dirname(path);
  }
  return resolve(process.cwd());
}
export const projectRoot = findRoot();
if (existsSync(join(projectRoot, '.env'))) loadEnvFile(join(projectRoot, '.env'));
export interface AdminOIDCConfig {
  issuer: string; clientId: string; clientSecret?: string;
  authMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  allowedOrigins: string[]; label: string;
}
export interface Config {
  port: number; host: string; baseUrl: string; consoleUrl: string; demo: boolean;
  adminToken: string; encryptionKey: string; databaseUrl?: string; sqlitePath: string;
  allowPrivateNetworks: boolean; mockEhrUrl: string; secureCookies: boolean;
  retentionHours: number;
  samplePatientUrl?: string; sampleCdsUrl?: string; sampleFhirUrl?: string;
  adminBootstrapEnabled?: boolean; adminOidc?: AdminOIDCConfig; adminAuthMode?: AdminAuthMode;
  operationsLogging?: boolean;
}
/** Omitted mode preserves existing local demos and OIDC deployments; no implicit password fallback. */
export function configuredAdminMode(config: Config): AdminAuthMode | 'demo' {
  return config.adminAuthMode ?? (config.demo ? 'demo' : 'oidc');
}
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const demo = overrides.demo ?? (process.env.DEMO_MODE === 'true' || (process.env.DEMO_MODE !== 'false' && process.env.NODE_ENV !== 'production'));
  const dataPath = join(projectRoot, '.data');
  let encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey && demo && !overrides.encryptionKey) {
    mkdirSync(dataPath, { recursive: true, mode: 0o700 });
    const keyFile = join(dataPath, 'encryption.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    encryptionKey = readFileSync(keyFile, 'utf8').trim();
  }
  const config: Config = {
    port: Number(process.env.PORT ?? 3001), host: process.env.HOST ?? '127.0.0.1',
    baseUrl: (process.env.BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, ''),
    consoleUrl: (process.env.CONSOLE_URL ?? (demo ? 'http://127.0.0.1:3010' : process.env.BASE_URL ?? 'http://127.0.0.1:3001')).replace(/\/$/, ''),
    demo, adminToken: process.env.ADMIN_TOKEN ?? '', encryptionKey: encryptionKey ?? '',
    databaseUrl: process.env.DATABASE_URL, sqlitePath: process.env.SQLITE_PATH ?? join(dataPath, 'smart-flint.sqlite'),
    allowPrivateNetworks: process.env.ALLOW_PRIVATE_NETWORKS === 'true',
    mockEhrUrl: (process.env.MOCK_EHR_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, ''),
    secureCookies: !demo,
    retentionHours: Number(process.env.RETENTION_HOURS ?? 24),
    samplePatientUrl: process.env.SAMPLE_PATIENT_URL ?? 'http://127.0.0.1:4100',
    sampleCdsUrl: process.env.SAMPLE_CDS_URL ?? 'http://127.0.0.1:4101',
    sampleFhirUrl: process.env.SAMPLE_FHIR_URL ?? 'http://127.0.0.1:4102',
    adminBootstrapEnabled: process.env.ADMIN_BOOTSTRAP_ENABLED === 'true',
    operationsLogging: process.env.OPERATIONS_LOGGING === undefined ? !demo : process.env.OPERATIONS_LOGGING === 'true',
    ...(process.env.ADMIN_AUTH_MODE ? { adminAuthMode: process.env.ADMIN_AUTH_MODE as AdminAuthMode } : {}),
    ...((process.env.ADMIN_OIDC_ISSUER || process.env.ADMIN_OIDC_CLIENT_ID) ? { adminOidc: {
      issuer: process.env.ADMIN_OIDC_ISSUER ?? '', clientId: process.env.ADMIN_OIDC_CLIENT_ID ?? '',
      clientSecret: process.env.ADMIN_OIDC_CLIENT_SECRET || undefined,
      authMethod: (process.env.ADMIN_OIDC_AUTH_METHOD ?? (process.env.ADMIN_OIDC_CLIENT_SECRET ? 'client_secret_basic' : 'none')) as AdminOIDCConfig['authMethod'],
      allowedOrigins: (process.env.ADMIN_OIDC_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
      label: process.env.ADMIN_OIDC_LABEL ?? 'Organization sign-in',
    } } : {}),
    ...overrides,
  };
  // TLS may terminate at a local or production proxy; bind cookies to that
  // configured public origin rather than the internal HTTP listener.
  config.secureCookies = overrides.secureCookies ?? (!config.demo || new URL(config.baseUrl).protocol === 'https:');
  if (Buffer.from(config.encryptionKey, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  for (const value of [config.baseUrl, config.consoleUrl]) {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('BASE_URL and CONSOLE_URL must be bare HTTP(S) origins.');
    if (!config.demo && url.protocol !== 'https:') throw new Error('BASE_URL and CONSOLE_URL must use HTTPS outside demo mode.');
  }
  if (config.adminAuthMode !== undefined && !['local', 'oidc'].includes(config.adminAuthMode)) throw new Error('ADMIN_AUTH_MODE must be local or oidc.');
  if (config.adminBootstrapEnabled && config.adminToken.length < 32) throw new Error('Bootstrap ADMIN_TOKEN must contain at least 32 characters.');
  if (configuredAdminMode(config) === 'local') config.adminOidc = undefined;
  if (config.adminOidc) {
    const provider = config.adminOidc;
    let issuer: URL;
    try { issuer = new URL(provider.issuer); } catch { throw new Error('ADMIN_OIDC_ISSUER must be an absolute issuer URL.'); }
    const local = config.demo && issuer.origin === new URL(config.mockEhrUrl).origin;
    if (issuer.username || issuer.password || issuer.search || issuer.hash || (issuer.protocol !== 'https:' && !(local && issuer.protocol === 'http:')))
      throw new Error('ADMIN_OIDC_ISSUER must use HTTPS without credentials, query, or fragment.');
    if (!provider.clientId?.trim() || provider.clientId.length > 512) throw new Error('ADMIN_OIDC_CLIENT_ID is required and must be at most 512 characters.');
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(provider.authMethod)) throw new Error('ADMIN_OIDC_AUTH_METHOD is not supported.');
    if (provider.authMethod !== 'none' && !provider.clientSecret) throw new Error('ADMIN_OIDC_CLIENT_SECRET is required for a confidential administrative client.');
    if (provider.authMethod === 'none' && provider.clientSecret) throw new Error('A public administrative OIDC client must not configure a client secret.');
    const allowedOrigins = [...new Set([issuer.origin, ...provider.allowedOrigins])];
    if (allowedOrigins.length > 20 || allowedOrigins.some(value => {
      try { const url = new URL(value); return url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(local && url.origin === issuer.origin)); }
      catch { return true; }
    })) throw new Error('ADMIN_OIDC_ALLOWED_ORIGINS must contain approved bare HTTPS origins.');
    const console = new URL(config.consoleUrl), runtime = new URL(config.baseUrl);
    if (console.hostname !== runtime.hostname || console.protocol !== runtime.protocol)
      throw new Error('Administrative OIDC requires the console and runtime to share a hostname and scheme so its session cookie can reach both.');
    config.adminOidc = { ...provider, allowedOrigins, label: provider.label.trim().slice(0, 120) || 'Organization sign-in' };
  }
  if (!config.demo && configuredAdminMode(config) === 'oidc' && !config.adminOidc && !config.adminBootstrapEnabled) throw new Error('Configure administrative OIDC or explicitly enable one-time bootstrap with ADMIN_BOOTSTRAP_ENABLED=true.');
  if (!config.demo && new URL(config.baseUrl).protocol !== 'https:') throw new Error('BASE_URL must use HTTPS outside demo mode.');
  if (config.demo && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('Demo mode binds to loopback only. Disable DEMO_MODE for network deployment.');
  if (!Number.isFinite(config.retentionHours) || config.retentionHours < 8 || config.retentionHours > 8760) throw new Error('RETENTION_HOURS must be between 8 and 8760.');
  return config;
}
