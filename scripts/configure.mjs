import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { values } = parseArgs({ options: { 'base-url': { type: 'string' }, 'auth-mode': { type: 'string', default: 'local' }, output: { type: 'string', default: '.env' } } });
if (!values['base-url']) throw new Error('Supply --base-url=https://your-smart-flint-domain.example');
const url = new URL(values['base-url']);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a bare HTTPS origin for --base-url.');
const origin = url.origin;
if (!['local', 'oidc'].includes(values['auth-mode'])) throw new Error('Use --auth-mode=local or --auth-mode=oidc.');
const content = [
  '# Generated local configuration. Keep this file and the encryption key private.',
  'NODE_ENV=production', 'DEMO_MODE=false', 'HOST=127.0.0.1', 'PORT=3001',
  `BASE_URL=${origin}`, `CONSOLE_URL=${origin}`,
  `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
  `ADMIN_TOKEN=${randomBytes(48).toString('base64url')}`,
  `ADMIN_AUTH_MODE=${values['auth-mode']}`,
  'ADMIN_BOOTSTRAP_ENABLED=true',
  '# OIDC mode requires your administrative identity provider before provisioning its first owner.',
  'ADMIN_OIDC_ISSUER=', 'ADMIN_OIDC_CLIENT_ID=', 'ADMIN_OIDC_CLIENT_SECRET=', 'ADMIN_OIDC_AUTH_METHOD=none',
  'ADMIN_OIDC_ALLOWED_ORIGINS=', 'ADMIN_OIDC_LABEL=Organization sign-in',
  `POSTGRES_PASSWORD=${randomBytes(32).toString('base64url')}`,
  'ALLOW_PRIVATE_NETWORKS=false', 'RETENTION_HOURS=24', '',
].join('\n');
writeFileSync(values.output, content, { mode: 0o600, flag: 'wx' });
process.stdout.write(`Created ${values.output}. Credentials were written to the file and are not printed.\nUse an HTTPS reverse proxy in front of port 3001. Docker Compose supplies DATABASE_URL.\nAdministrative authentication: ${values['auth-mode']}. One-time bootstrap is enabled; provision the first platform administrator for the selected sign-in method. Bootstrap access ends automatically when that account is active. See docs/administration.md.\n`);
