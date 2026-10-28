import { expect, it } from 'vitest';
import { CADDY_IMAGE, createProductionPlan, httpsOrigin, issuerUrl, type ProductionOptions } from '../scripts/installer/production.mjs';

const options: ProductionOptions = { publicUrl: 'https://flint.example.com', projectName: 'flint-isolated-test', image: 'smart-flint:0.1.0-candidate', bindPort: 43111 };
const compose = (plan: ReturnType<typeof createProductionPlan>) => JSON.parse(plan.files.find(value => value.path === 'compose.yaml')!.content);

it('generates a standalone hardened production service and private PostgreSQL with only a loopback proxy backend', () => {
  const plan = createProductionPlan(options), config = compose(plan);
  expect(config.name).toBe(options.projectName);
  expect(config.services.flint).toMatchObject({ image: options.image, pull_policy: 'never', read_only: true,
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], ports: ['127.0.0.1:43111:3001'],
    environment: { NODE_ENV: 'production', DEMO_MODE: 'false', ADMIN_AUTH_MODE: 'local', ADMIN_BOOTSTRAP_ENABLED: 'true',
      BASE_URL: options.publicUrl, CONSOLE_URL: options.publicUrl } });
  expect(config.services.postgres.ports).toBeUndefined(); expect(config.services.postgres.environment.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(config.services.flint.environment).not.toHaveProperty('ADMIN_OIDC_ISSUER');
  expect(config.services.flint.environment).not.toHaveProperty('PASSWORD');
  expect(config.services.flint.build).toBeUndefined();
  expect(plan.ports).toEqual([{ hostIp: '127.0.0.1', port: 43111, protocol: 'tcp', purpose: 'Existing HTTPS proxy backend' }]);
  expect(plan.checks.tlsVerification).toBe('system'); expect(plan.checks.requiresExistingTlsProxy).toBe(true);
  expect(plan.endpoints).toMatchObject({ console: options.publicUrl, readiness: `${options.publicUrl}/ready`, proxyTarget: 'http://127.0.0.1:43111' });
  expect(plan.files.every(file => file.mode === 0o600 && !file.path.includes('/'))).toBe(true);
  expect(config.services.postgres.volumes).toEqual(['postgres-data:/var/lib/postgresql/data']);
  expect(config.volumes['postgres-data']).toEqual({});
});

it('separates safe resumable settings from generated secrets and creates fresh independent credentials', () => {
  const first = createProductionPlan(options), second = createProductionPlan(options);
  const secrets = JSON.parse(first.files.find(file => file.path === 'setup-secrets.json')!.content);
  const next = JSON.parse(second.files.find(file => file.path === 'setup-secrets.json')!.content);
  for (const name of ['encryptionKey', 'bootstrapToken', 'postgresPassword']) {
    expect(secrets[name]).not.toBe(next[name]); expect(JSON.stringify(first.settings)).not.toContain(secrets[name]);
  }
  expect(Buffer.from(secrets.encryptionKey, 'base64')).toHaveLength(32);
  expect(first.settings).not.toHaveProperty('secrets');
  expect(first.files.find(file => file.path === 'installation.md')!.content).not.toContain(secrets.bootstrapToken);
});

it('retains exact OIDC issuer identity and escapes all Compose dollar interpolation in confidential-client values', () => {
  const secret = 'literal-${UNTRUSTED_ENV}-$dollar-quote\'"backslash\\value';
  const plan = createProductionPlan({ ...options, authMode: 'oidc', oidc: {
    issuer: 'https://identity.example.com/realms/health/', clientId: 'flint-application', clientSecret: secret,
    authMethod: 'client_secret_basic', allowedOrigins: ['https://keys.example.com'], label: 'Organization $ SSO',
  } });
  const config = compose(plan), setup = JSON.parse(plan.files.find(file => file.path === 'setup-secrets.json')!.content);
  expect(config.services.flint.environment.ADMIN_OIDC_ISSUER).toBe('https://identity.example.com/realms/health/');
  expect(config.services.flint.environment.ADMIN_OIDC_CLIENT_SECRET).toBe('literal-$${UNTRUSTED_ENV}-$$dollar-quote\'"backslash\\value');
  expect(setup.oidcClientSecret).toBe(secret); expect(JSON.stringify(plan.settings)).not.toContain(secret);
  expect(config.services.flint.environment.ADMIN_OIDC_ALLOWED_ORIGINS).toBe('https://identity.example.com,https://keys.example.com');
  expect(plan.endpoints.oidcCallback).toBe(`${options.publicUrl}/api/admin/oidc/callback`);
});

it('creates public automatic HTTPS only for a valid public DNS name on ports 80/443 with no host bind mounts', () => {
  const plan = createProductionPlan({ ...options, publicUrl: 'https://flint.health-platform.net', tlsMode: 'caddy' });
  const config = compose(plan);
  expect(config.services.edge.image).toBe(CADDY_IMAGE);
  expect(config.services.edge.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  expect(config.services.edge.ports).toEqual(['80:80', '443:443']);
  expect(config.services.flint.ports).toBeUndefined(); expect(config.services.flint.expose).toEqual(['3001']);
  const rendered = Buffer.from(config.services.edge.environment.FLINT_CADDY_CONFIG, 'base64').toString();
  expect(rendered).toBe(plan.files.find(file => file.path === 'Caddyfile')!.content);
  expect(rendered).toContain('https://flint.health-platform.net'); expect(rendered).toContain('output discard');
  expect(config.services.edge.entrypoint.join(' ')).toContain('$$FLINT_CADDY_CONFIG');
  for (const service of Object.values(config.services) as { volumes?: string[] }[]) for (const mount of service.volumes ?? []) expect(mount).not.toMatch(/^(\.|\/)/);
  expect(plan.checks.requiresPublicPorts).toEqual([80, 443]);
  expect(plan.ports.map(value => value.port)).toEqual([80, 443]);
});

it('rejects automatic certificate requests for local/reserved names, literals, wildcards and custom public ports', () => {
  for (const publicUrl of ['https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://flint.internal', 'https://flint.test',
    'https://example.com', 'https://flint.example.org', 'https://*.health-platform.net', 'https://flint.health-platform.net:8443']) {
    expect(() => createProductionPlan({ ...options, tlsMode: 'caddy', publicUrl }), publicUrl).toThrow();
  }
  expect(() => createProductionPlan({ ...options, tlsMode: 'caddy', publicUrl: 'https://flint.health-platform.net', httpPort: 8080 })).toThrow();
  expect(createProductionPlan({ ...options, publicUrl: 'https://127.0.0.1:4443' }).endpoints.console).toBe('https://127.0.0.1:4443');
});

it('rejects ambiguous URLs, credentials and control/configuration injection', () => {
  for (const value of ['http://flint.example.com', 'https://user:password@flint.example.com', 'https://flint.example.com/path',
    'https://flint.example.com?token=private', 'https://flint.example.com/#fragment', 'https://flint.example.com\nINJECTED=value', 'https://flint.example.com/.']) {
    expect(() => httpsOrigin(value), value).toThrow();
  }
  expect(httpsOrigin('https://flint.example.com/')).toBe(options.publicUrl);
  expect(issuerUrl('https://identity.example.com/realms/tenant/')).toBe('https://identity.example.com/realms/tenant/');
  expect(() => issuerUrl('https://identity.example.com/realm?query=bad')).toThrow();
  expect(() => createProductionPlan({ ...options, projectName: 'flint\nservices:' })).toThrow();
  expect(() => createProductionPlan({ ...options, image: 'flint; touch /private/file' })).toThrow();
});

it('requires explicit private endpoint access and a consistent OIDC client registration', () => {
  const oidc = { issuer: 'https://127.0.0.1:4444/realm', clientId: 'flint', authMethod: 'none' as const };
  expect(() => createProductionPlan({ ...options, authMode: 'oidc', oidc })).toThrow(/Private/);
  expect(createProductionPlan({ ...options, authMode: 'oidc', oidc, allowPrivateNetworks: true }).settings.allowPrivateNetworks).toBe(true);
  for (const invalid of [{ ...oidc, issuer: 'http://identity.example.com/realm' }, { ...oidc, clientSecret: 'not-for-public-client' },
    { ...oidc, issuer: 'https://identity.example.com/realm', authMethod: 'client_secret_basic' as const },
    { ...oidc, issuer: 'https://identity.example.com/realm', allowedOrigins: ['https://user:secret@keys.example.com'] }]) {
    expect(() => createProductionPlan({ ...options, authMode: 'oidc', oidc: invalid, allowPrivateNetworks: true })).toThrow();
  }
});

it('validates secret encodings, port bounds and retention before rendering any plan', () => {
  for (const secrets of [{ encryptionKey: 'not-base64' }, { bootstrapToken: 'short' }, { postgresPassword: 'unsafe@password' }]) expect(() => createProductionPlan({ ...options, secrets })).toThrow();
  for (const bindPort of [0, 65536, 1.5, Number.NaN]) expect(() => createProductionPlan({ ...options, bindPort })).toThrow();
  for (const retentionHours of [0, 7, 8761, Number.NaN]) expect(() => createProductionPlan({ ...options, retentionHours })).toThrow();
  const secrets = { encryptionKey: Buffer.alloc(32, 5).toString('base64'), bootstrapToken: 'b'.repeat(48), postgresPassword: 'p'.repeat(48) };
  expect(compose(createProductionPlan({ ...options, secrets })).services.flint.environment.ENCRYPTION_KEY).toBe(secrets.encryptionKey);
});
