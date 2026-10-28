import { X509Certificate } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupLocalCertificates } from './local-https.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
try {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    if ((await lstat(join(root, '.data'))).isSymbolicLink()) throw new Error('Project .data must not be a symbolic link when preparing local HTTPS certificates.');
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const certificates = await setupLocalCertificates(join(root, '.data/https'));
  const ca = new X509Certificate(await readFile(certificates.caCertPath));
  process.stdout.write(`Project development certificates are ready.\nLocal HTTPS origin: https://127.0.0.1:3443\nCA certificate: ${certificates.caCertPath}\nCA SHA-256 fingerprint: ${ca.fingerprint256}\nNo software was installed and no OS/browser trust settings were changed.\n`);
  if (process.platform === 'darwin') {
    process.stdout.write(`\nTo trust this project CA for SSL in your user login keychain, review and run this command yourself:\n\nsecurity add-trusted-cert -r trustRoot -p ssl -k ${quote(join(homedir(), 'Library/Keychains/login.keychain-db'))} ${quote(certificates.caCertPath)}\n\nThis changes your user's SSL trust settings so browsers can trust certificates signed by this project CA. Keep ca-key.pem private. This script never executes the trust command.\n`);
  } else process.stdout.write('\nBrowser trust is a separate user-managed step: trust the project ca.pem for local development in your browser/OS certificate settings.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Local HTTPS certificate setup failed.'}\n`);
  process.exitCode = 1;
}
