import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createSandboxPlan, parseInstallerArgs, privateFile, savePlan, verifyImageArchive } from '../scripts/install.mjs';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function folder() { const directory = await mkdtemp(join(tmpdir(), 'flint-installer-unit-')); directories.push(directory); return directory; }
const plan = () => createSandboxPlan({ projectName: 'smart-flint-synthetic-test', image: 'synthetic-sandbox:0.1.0' });

it('creates private independent sandbox plans and publishes only loopback ports', () => {
  const first = plan(), second = plan();
  expect(first.files.find(file => file.path === 'setup-secrets.json')!.content).not.toBe(second.files.find(file => file.path === 'setup-secrets.json')!.content);
  const compose = JSON.parse(first.files.find(file => file.path === 'compose.yaml')!.content);
  expect(compose.services.sandbox.ports).toEqual(['127.0.0.1:3010:3010', '127.0.0.1:4010:4010', '127.0.0.1:4100:4100', '127.0.0.1:4101:4101', '127.0.0.1:4102:4102']);
  expect(compose.services.sandbox.read_only).toBe(true);
  expect(() => createSandboxPlan({ projectName: 'fixture', image: 'fixture:tag', port: 4100, patientPort: 4100 })).toThrow(/distinct/);
});

it('preserves keys and operator-edited config on completed resume, rejects changed mode and missing secrets', async () => {
  const directory = await folder(), initial = await savePlan(directory, plan());
  const secrets = await readFile(join(directory, 'setup-secrets.json'), 'utf8');
  await writeFile(join(directory, 'compose.yaml'), 'operator-managed-private-config\n', { mode: 0o600 });
  const resumed = await savePlan(directory);
  expect(resumed.plan).toEqual(initial.plan);
  expect(await readFile(join(directory, 'setup-secrets.json'), 'utf8')).toBe(secrets);
  expect(await readFile(join(directory, 'compose.yaml'), 'utf8')).toBe('operator-managed-private-config\n');
  await expect(savePlan(directory, { ...plan(), settings: { ...plan().settings, mode: 'deploy' } })).rejects.toThrow(/different installation mode/);
  await unlink(join(directory, 'setup-secrets.json'));
  await expect(savePlan(directory)).rejects.toThrow(/missing/);
});

it('recovers interrupted configuration from its authoritative private plan without regenerating secrets', async () => {
  const directory = await folder(), savedPlan = plan();
  await writeFile(join(directory, 'installation.json'), JSON.stringify({ format: 'smart-flint-installation-v1', configured: false, plan: savedPlan }), { mode: 0o600 });
  const resumed = await savePlan(directory);
  expect(resumed.configured).toBe(true);
  expect(await readFile(join(directory, 'setup-secrets.json'), 'utf8')).toBe(savedPlan.files.find(file => file.path === 'setup-secrets.json')!.content);
});

it('rejects unrelated directories, public input files and symlinked input files without replacing them', async () => {
  const directory = await folder();
  await writeFile(join(directory, 'unrelated.txt'), 'keep');
  await expect(savePlan(directory, plan())).rejects.toThrow(/unrelated/);
  const path = join(directory, 'input.json'); await writeFile(path, '{}', { mode: 0o644 });
  await expect(privateFile(path)).rejects.toThrow(/private regular/);
  await chmod(path, 0o600); expect(await privateFile(path)).toBe('{}');
  await symlink(path, join(directory, 'input-link.json'));
  await expect(privateFile(join(directory, 'input-link.json'))).rejects.toThrow(/symbolic links/);
  expect(await readFile(join(directory, 'unrelated.txt'), 'utf8')).toBe('keep');
});

it('authenticates exactly one image archive checksum before any Docker load', async () => {
  const directory = await folder(), path = join(directory, 'fixture-image.tar.gz'), content = Buffer.from('synthetic image fixture');
  await writeFile(path, content); const hash = createHash('sha256').update(content).digest('hex');
  await writeFile(join(directory, 'SHA256SUMS'), `${hash}  fixture-image.tar.gz\n`);
  await expect(verifyImageArchive(path)).resolves.toBeUndefined();
  await writeFile(path, 'changed image'); await expect(verifyImageArchive(path)).rejects.toThrow(/checksum does not match/);
  await writeFile(path, content); await writeFile(join(directory, 'SHA256SUMS'), `${hash}  fixture-image.tar.gz\n${hash}  fixture-image.tar.gz\n`);
  await expect(verifyImageArchive(path)).rejects.toThrow(/exactly one/);
});

it('rejects password command-line flags and invalid lifecycle choices', () => {
  expect(() => parseInstallerArgs(['--password', 'synthetic-password'])).toThrow(/Unknown installer option/);
  expect(() => parseInstallerArgs(['--action', 'delete'])).toThrow(/Choose --action/);
  expect(parseInstallerArgs(['--mode', 'sandbox', '--action', 'status']).mode).toBe('sandbox');
});
