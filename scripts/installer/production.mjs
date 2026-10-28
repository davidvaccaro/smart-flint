import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export const CADDY_IMAGE = 'caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f';
export const POSTGRES_IMAGE = 'postgres:17-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27';

function text(value, name, max = 2048) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Supply a valid ${name}.`);
  return value;
}

export function httpsOrigin(value, name = 'public HTTPS URL') {
  text(value, name);
  let url;
  try { url = new URL(value); } catch { throw new Error(`Supply a valid ${name}.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`Use a bare HTTPS origin for ${name}.`);
  if (value !== url.origin && value !== `${url.origin}/`) throw new Error(`Use a canonical HTTPS origin for ${name}.`);
  return url.origin;
}

export function issuerUrl(value) {
  text(value, 'OIDC issuer');
  let url;
  try { url = new URL(value); } catch { throw new Error('Supply a valid OIDC issuer.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The OIDC issuer must be an HTTPS URL without credentials, query or fragment.');
  // A significant trailing slash is retained; the provider's exact issuer is its identity.
  if (url.href !== value && !(url.pathname === '/' && url.href === `${value}/`)) throw new Error('Use the exact canonical OIDC issuer.');
  return value;
}

function privateLiteral(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!isIP(host)) return false;
  if (host.includes(':')) return host === '::' || host === '::1' || /^(fc|fd|fe[89ab]|ff)/.test(host) || /^::ffff:/.test(host);
  const octets = host.split('.').map(Number);
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
    || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function publicHostname(hostname) {
  return !isIP(hostname.replace(/^\[|\]$/g, '')) && hostname.includes('.')
    && /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
    && hostname.split('.').every(label => label.length <= 63 && !label.startsWith('-') && !label.endsWith('-') && label)
    && !/(^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(hostname)
    && !/(^|\.)(?:example\.com|example\.net|example\.org)$/.test(hostname);
}

function port(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`Supply a TCP port from 1 to 65535 for ${name}.`);
  return value;
}

function imageReference(value) {
  text(value, 'local runtime image', 512);
  if (!/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?)$/.test(value)) throw new Error('Supply an explicit local runtime image reference or SHA-256 image identifier.');
  return value;
}

function credentials(supplied = {}) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(key => !['encryptionKey', 'bootstrapToken', 'postgresPassword'].includes(key))) throw new Error('Invalid deployment secret input.');
  const values = {
    encryptionKey: supplied.encryptionKey ?? randomBytes(32).toString('base64'),
    bootstrapToken: supplied.bootstrapToken ?? randomBytes(48).toString('base64url'),
    postgresPassword: supplied.postgresPassword ?? randomBytes(32).toString('base64url'),
  };
  if (typeof values.encryptionKey !== 'string' || Buffer.from(values.encryptionKey, 'base64').length !== 32 || Buffer.from(values.encryptionKey, 'base64').toString('base64') !== values.encryptionKey)
    throw new Error('The supplied encryption key must encode exactly 32 bytes as canonical base64.');
  if (typeof values.bootstrapToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(values.bootstrapToken)) throw new Error('The supplied bootstrap token must be a URL-safe random value of at least 32 characters.');
  if (typeof values.postgresPassword !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(values.postgresPassword)) throw new Error('The supplied database password must be a URL-safe random value of at least 32 characters.');
  return values;
}

function oidcConfig(value, privateNetworks) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OIDC deployment requires your identity-provider client configuration.');
  const issuer = issuerUrl(value.issuer), clientId = text(value.clientId, 'OIDC client ID', 512);
  const authMethod = value.authMethod ?? 'client_secret_basic';
  if (!['none', 'client_secret_basic', 'client_secret_post'].includes(authMethod)) throw new Error('Choose a supported OIDC client authentication method.');
  const clientSecret = value.clientSecret ?? '';
  if (authMethod === 'none' ? clientSecret !== '' : !clientSecret) throw new Error('A confidential OIDC client requires its secret; a public client must not supply one.');
  if (clientSecret) text(clientSecret, 'OIDC client secret', 8192);
  const allowedOrigins = value.allowedOrigins ?? [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 19) throw new Error('Supply at most 19 additional approved OIDC origins.');
  const origins = [...new Set([new URL(issuer).origin, ...allowedOrigins.map(item => httpsOrigin(item, 'approved OIDC origin'))])];
  if (!privateNetworks && origins.some(item => privateLiteral(new URL(item).hostname))) throw new Error('Private OIDC endpoints require explicit private-network access.');
  return { issuer, clientId, authMethod, clientSecret, allowedOrigins: origins, label: text(value.label ?? 'Organization sign-in', 'OIDC label', 120) };
}

// Compose interpolation applies even to JSON strings. Escape dollars in every literal,
// including provider secrets, so they cannot name environment variables or expressions.
function composeLiteral(value) {
  if (typeof value === 'string') return value.replaceAll('$', () => '$$');
  if (Array.isArray(value)) return value.map(composeLiteral);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, composeLiteral(item)]));
  return value;
}

export function createProductionPlan(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Supply deployment options.');
  const publicUrl = httpsOrigin(options.publicUrl);
  const projectName = text(options.projectName, 'isolated Compose project name', 63);
  if (!/^[a-z0-9][a-z0-9_-]{2,62}$/.test(projectName)) throw new Error('Use 3–63 lowercase letters, digits, underscores or hyphens for the Compose project.');
  const image = imageReference(options.image), authMode = options.authMode ?? 'local', tlsMode = options.tlsMode ?? 'external';
  if (!['local', 'oidc'].includes(authMode)) throw new Error('Choose local or OIDC administrative authentication.');
  if (!['external', 'caddy'].includes(tlsMode)) throw new Error('Choose existing external TLS or automatic Caddy HTTPS.');
  if (options.allowPrivateNetworks !== undefined && typeof options.allowPrivateNetworks !== 'boolean') throw new Error('Private-network access must be an explicit boolean.');
  const allowPrivateNetworks = options.allowPrivateNetworks === true;
  const retentionHours = options.retentionHours ?? 24;
  if (!Number.isFinite(retentionHours) || retentionHours < 8 || retentionHours > 8760) throw new Error('Choose retention between 8 and 8760 hours.');
  const bindPort = port(options.bindPort ?? 3011, 'the existing TLS proxy backend');
  if (tlsMode === 'caddy') {
    if (!publicHostname(new URL(publicUrl).hostname) || new URL(publicUrl).port) throw new Error('Automatic HTTPS requires a public DNS hostname on standard HTTPS port 443. Use existing TLS for IP addresses, private names or custom HTTPS ports.');
    if ((options.httpPort ?? 80) !== 80 || (options.httpsPort ?? 443) !== 443) throw new Error('Automatic HTTPS requires host ports 80 and 443; use existing TLS for custom edge ports.');
  }
  const secret = credentials(options.secrets);
  const oidc = authMode === 'oidc' ? oidcConfig(options.oidc, allowPrivateNetworks) : undefined;
  const environment = {
    NODE_ENV: 'production', DEMO_MODE: 'false', HOST: '0.0.0.0', PORT: '3001', BASE_URL: publicUrl, CONSOLE_URL: publicUrl,
    ENCRYPTION_KEY: secret.encryptionKey, ADMIN_TOKEN: secret.bootstrapToken, ADMIN_AUTH_MODE: authMode, ADMIN_BOOTSTRAP_ENABLED: 'true',
    DATABASE_URL: `postgresql://smart-flint:${secret.postgresPassword}@postgres:5432/smart-flint`,
    ALLOW_PRIVATE_NETWORKS: String(allowPrivateNetworks), RETENTION_HOURS: String(retentionHours), OPERATIONS_LOGGING: 'true',
    ...(oidc ? { ADMIN_OIDC_ISSUER: oidc.issuer, ADMIN_OIDC_CLIENT_ID: oidc.clientId, ADMIN_OIDC_AUTH_METHOD: oidc.authMethod,
      ADMIN_OIDC_CLIENT_SECRET: oidc.clientSecret, ADMIN_OIDC_ALLOWED_ORIGINS: oidc.allowedOrigins.join(','), ADMIN_OIDC_LABEL: oidc.label } : {}),
  };
  const compose = {
    name: projectName,
    services: {
      flint: {
        image, pull_policy: 'never', restart: 'unless-stopped', environment,
        ...(tlsMode === 'external' ? { ports: [`127.0.0.1:${bindPort}:3001`] } : { expose: ['3001'] }),
        depends_on: { postgres: { condition: 'service_healthy' } }, read_only: true,
        tmpfs: ['/tmp:size=16m,noexec,nosuid'], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
        healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3001/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: '10s', timeout: '5s', retries: 12, start_period: '20s' },
      },
      postgres: {
        image: POSTGRES_IMAGE, restart: 'unless-stopped',
        environment: { POSTGRES_DB: 'smart-flint', POSTGRES_USER: 'smart-flint', POSTGRES_PASSWORD: secret.postgresPassword },
        volumes: ['postgres-data:/var/lib/postgresql/data'], security_opt: ['no-new-privileges:true'],
        healthcheck: { test: ['CMD', 'pg_isready', '-U', 'smart-flint', '-d', 'smart-flint'], interval: '5s', timeout: '5s', retries: 30 },
      },
    },
    volumes: { 'postgres-data': {} },
  };
  const files = [];
  if (tlsMode === 'caddy') {
    const caddyfile = `# Review copy; the active configuration is embedded in compose.yaml.\n{\n\tadmin off\n\tpersist_config off\n\tlog default {\n\t\toutput discard\n\t}\n}\n${publicUrl} {\n\treverse_proxy flint:3001 {\n\t\theader_up -X-Forwarded-For\n\t\theader_up -Forwarded\n\t}\n}\n`;
    compose.services.edge = { image: CADDY_IMAGE, restart: 'unless-stopped', ports: ['80:80', '443:443'],
      environment: { FLINT_CADDY_CONFIG: Buffer.from(caddyfile).toString('base64') },
      entrypoint: ['/bin/sh', '-ec', 'printf %s "$FLINT_CADDY_CONFIG" | base64 -d > /tmp/Caddyfile; exec caddy run --config /tmp/Caddyfile --adapter caddyfile'],
      volumes: ['caddy-data:/data', 'caddy-config:/config'],
      depends_on: { flint: { condition: 'service_healthy' } }, security_opt: ['no-new-privileges:true'],
      read_only: true, tmpfs: ['/tmp:size=16m,noexec,nosuid'],
    };
    compose.volumes['caddy-data'] = {}; compose.volumes['caddy-config'] = {};
    files.push({ path: 'Caddyfile', mode: 0o600, content: caddyfile });
  }
  files.push({ path: 'compose.yaml', mode: 0o600, content: `${JSON.stringify(composeLiteral(compose), null, 2)}\n` });
  files.push({ path: 'setup-secrets.json', mode: 0o600, content: `${JSON.stringify({ format: 'smart-flint-installation-secrets-v1', ...secret,
    ...(oidc?.clientSecret ? { oidcClientSecret: oidc.clientSecret } : {}) }, null, 2)}\n` });
  const instructions = [
    '# SMART Flint installation', '', `Public console: ${publicUrl}`, `Compose project: ${projectName}`, `Authentication: ${authMode}`, '',
    'This directory contains private deployment secrets. Keep it private and back up the encryption key separately from PostgreSQL.',
    'Use the bootstrap token in setup-secrets.json for Initial deployment setup. Add the first platform administrator in Settings & API → Users & access.',
    'After first-owner handoff, bootstrap access is retired automatically. Remove ADMIN_TOKEN and set ADMIN_BOOTSTRAP_ENABLED=false in compose.yaml, then recreate the service.',
    '', 'Start: docker compose --file compose.yaml up --detach', 'Stop: docker compose --file compose.yaml stop',
    'Status: docker compose --file compose.yaml ps', 'Never use docker compose down --volumes unless you intentionally want to destroy the installation database.',
    '', ...(tlsMode === 'external' ? [`Configure your existing HTTPS proxy to forward ${publicUrl} to http://127.0.0.1:${bindPort}.`,
      'Keep that backend listener on loopback. Do not bypass certificate validation when checking the public URL.'] : [
      'Automatic HTTPS requires this public hostname to resolve to this server and inbound TCP ports 80 and 443 to reach it.',
      'Caddy obtains and renews certificates. The installer does not change DNS, routers, firewalls or system trust.',
      'Proxy request/error logging is discarded to keep SMART launch query strings and clinical request paths out of edge logs. Monitor public HTTPS readiness and certificate expiry.',
    ]), '', ...(oidc ? [`Register the exact administrative callback ${publicUrl}/api/admin/oidc/callback with your identity provider.`,
      'Provision the first OIDC owner using its exact configured issuer and subject. Matching email addresses do not grant access.'] : []), '',
  ].join('\n');
  files.push({ path: 'installation.md', mode: 0o600, content: instructions });
  const ports = tlsMode === 'caddy' ? [{ hostIp: '0.0.0.0', port: 80, protocol: 'tcp', purpose: 'ACME and HTTPS redirect' }, { hostIp: '0.0.0.0', port: 443, protocol: 'tcp', purpose: 'Public HTTPS' }]
    : [{ hostIp: '127.0.0.1', port: bindPort, protocol: 'tcp', purpose: 'Existing HTTPS proxy backend' }];
  const settings = { mode: 'deploy', publicUrl, projectName, image, tlsMode, authMode, bindPort: tlsMode === 'external' ? bindPort : undefined,
    allowPrivateNetworks, retentionHours, ...(oidc ? { oidc: { issuer: oidc.issuer, clientId: oidc.clientId, authMethod: oidc.authMethod,
      allowedOrigins: oidc.allowedOrigins, label: oidc.label } } : {}) };
  return {
    settings, files,
    endpoints: { console: publicUrl, readiness: `${publicUrl}/ready`, ...(tlsMode === 'external' ? { internalReadiness: `http://127.0.0.1:${bindPort}/ready`, proxyTarget: `http://127.0.0.1:${bindPort}` } : {}),
      ...(oidc ? { oidcCallback: `${publicUrl}/api/admin/oidc/callback` } : {}) },
    ports, checks: { services: Object.keys(compose.services), tlsVerification: 'system', readinessUrl: `${publicUrl}/ready`,
      ...(tlsMode === 'caddy' ? { publicDnsHostname: new URL(publicUrl).hostname, requiresPublicPorts: [80, 443] } : { requiresExistingTlsProxy: true }) },
  };
}
