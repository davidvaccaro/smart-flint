import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function command(args, cwd) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`SDK packaging failed (${args[0]}).\n${result.stderr || result.stdout}`);
  return result.stdout;
}

/** Only public source, compiled modules, declarations and distribution notices enter the archives. */
export async function packageNodeSDKs(output = resolve(sdkRoot, 'dist/sdk')) {
  output = resolve(output);
  await mkdir(output, { recursive: true });
  const files = [];
  for (const name of ['contracts', 'sdk']) {
    const cwd = resolve(sdkRoot, 'packages', name);
    for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      if (!(await stat(resolve(cwd, notice))).isFile()) throw new Error(`Missing ${name} distribution notice: ${notice}`);
    }
    command(['run', 'build'], cwd);
    const [packed] = JSON.parse(command(['pack', '--ignore-scripts', '--json', '--pack-destination', output], cwd));
    const paths = new Set(packed.files.map(file => file.path));
    for (const required of ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md']) {
      if (!paths.has(required)) throw new Error(`${name} archive is missing ${required}`);
    }
    if ([...paths].some(path => !/^(dist\/index\.(js|js\.map|d\.ts|d\.ts\.map)|src\/index\.ts|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|package\.json)$/.test(path))) {
      throw new Error(`${name} archive contains an unexpected file.`);
    }
    const manifest = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
    files.push({ name: manifest.name, version: manifest.version, filename: resolve(output, packed.filename), integrity: packed.integrity });
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outputIndex = process.argv.indexOf('--output');
    if (process.argv.slice(2).some((value, index, args) => value !== '--output' && args[index - 1] !== '--output')) throw new Error('Usage: node scripts/package-sdks.mjs [--output directory]');
    if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error('Supply an output directory.');
    const artifacts = await packageNodeSDKs(outputIndex === -1 ? undefined : process.argv[outputIndex + 1]);
    process.stdout.write(`${JSON.stringify({ artifacts }, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
