/** Scan a local runtime artifact without exposing the Docker socket to the scanner. */
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, lstat, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
const { values } = parseArgs({ options: { image: { type: 'string' }, output: { type: 'string', default: '.data/security' } } });
const execute = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'flint-image-scan-'));
const report = resolve(values.output), image = values.image ?? `smart-flint:security-${randomBytes(5).toString('hex')}`;
const cache = resolve('.data/trivy-cache');
const scanner = 'aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c';
let built = false;
const run = async args => execute('docker', args, { timeout: 900_000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, BUILDX_CONFIG: process.env.BUILDX_CONFIG ?? join(directory, 'buildx') } });
try {
  for (const path of [report, cache]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('A private owned report directory is required.');
  }
  if (!values.image) { await run(['build', '--pull', '-f', 'deploy/Dockerfile', '-t', image, '.']); built = true; }
  await run(['save', '-o', join(directory, 'runtime.tar'), image]);
  const common = ['run', '--rm', ...(process.getuid ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
    '-e', 'TRIVY_CACHE_DIR=/cache', '-v', `${directory}:/scan:ro`, '-v', `${report}:/reports`, '-v', `${cache}:/cache`, scanner];
  await run([...common, 'image', '--input', '/scan/runtime.tar', '--scanners', 'vuln,secret', '--format', 'json', '--output', '/reports/container-scan.json']);
  await run([...common, 'image', '--input', '/scan/runtime.tar', '--format', 'cyclonedx', '--output', '/reports/container-sbom.cdx.json']);
  for (const file of ['container-scan.json', 'container-sbom.cdx.json']) await chmod(join(report, file), 0o600);
  const scan = JSON.parse(await readFile(join(report, 'container-scan.json'), 'utf8'));
  const vulnerabilities = (scan.Results ?? []).flatMap(value => value.Vulnerabilities ?? []);
  const secrets = (scan.Results ?? []).flatMap(value => value.Secrets ?? []);
  const blocking = vulnerabilities.filter(value => ['HIGH', 'CRITICAL'].includes(value.Severity));
  console.log(JSON.stringify({ containerScan: { vulnerabilities: vulnerabilities.length, highOrCritical: blocking.length, secrets: secrets.length }, reports: report }));
  if (blocking.length || secrets.length) process.exitCode = 1;
} catch { console.error('Container security scan could not complete. No scan pass is recorded; review the pinned scanner and registry connectivity.'); process.exitCode = 1; }
finally {
  await rm(directory, { recursive: true, force: true });
  if (built) { try { await run(['image', 'rm', image]); } catch {} }
}
