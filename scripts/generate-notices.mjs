import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['', 'packages/sdk', 'packages/contracts', 'sdks/python'];
const safeName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

export function lockedProductionDependencies(root = projectRoot) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion !== 3) throw new Error('Release inventory requires package-lock v3.');
  return Object.entries(lock.packages).filter(([path, entry]) => path.includes('node_modules/') && !entry.dev && !entry.link).map(([path, entry]) => {
    const name = entry.name ?? path.split('node_modules/').at(-1);
    if (!safeName.test(name) || !entry.version || typeof entry.license !== 'string') throw new Error('A production dependency has incomplete licensing metadata.');
    if (!path.split('/').every(part => part && part !== '.' && part !== '..')) throw new Error('Unsafe dependency path.');
    return { name, version: entry.version, license: entry.license, integrity: entry.integrity, path };
  }).sort((a, b) => `${a.name}@${a.version}:${a.path}`.localeCompare(`${b.name}@${b.version}:${b.path}`, 'en'));
}

function noticeFiles(root, dependency) {
  let directory = join(root, dependency.path);
  if (dependency.name.startsWith('@esbuild/')) directory = join(root, 'node_modules/esbuild');
  if (!existsSync(directory)) throw new Error(`Install dependencies before generating notices: ${dependency.name}.`);
  const files = readdirSync(directory).filter(name => /^(licen[cs]e|copying|notice|copyright)([._-].*)?$/i.test(name)).sort();
  if (files.length) return files.map(name => {
    const path = join(directory, name), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Dependency notices must be bounded regular files.');
    return { source: `${dependency.name}/${name}`, text: readFileSync(path, 'utf8').trim() };
  });
  if (['pg-types', 'pgpass'].includes(dependency.name)) {
    const readme = readFileSync(join(directory, 'README.md'), 'utf8');
    const start = readme.search(/^##?\s+licen[cs]e\s*$/im);
    if (start < 0 || !/Permission is hereby granted/.test(readme.slice(start))) throw new Error('Expected complete README license text.');
    return [{ source: `${dependency.name}/README.md license section`, text: readme.slice(start).trim() }];
  }
  if (dependency.name === 'abstract-logging' && dependency.version === '2.0.1') return [{
    source: 'abstract-logging@2.0.1 published MIT declaration and author notice (docs/licensing/third-party/abstract-logging-2.0.1.txt)',
    text: readFileSync(join(root, 'docs/licensing/third-party/abstract-logging-2.0.1.txt'), 'utf8').trim(),
  }];
  throw new Error(`Review and retain the dependency's license notice: ${dependency.name}@${dependency.version}.`);
}

export function generateNotices(root = projectRoot) {
  const dependencies = lockedProductionDependencies(root);
  const grouped = new Map();
  const entries = dependencies.map(dependency => {
    const refs = noticeFiles(root, dependency).map(notice => {
      const hash = createHash('sha256').update(notice.text).digest('hex').slice(0, 16);
      const item = grouped.get(hash) ?? { text: notice.text, sources: new Set(), names: new Set() };
      item.sources.add(notice.source); item.names.add(`${dependency.name}@${dependency.version}`); grouped.set(hash, item);
      return hash;
    });
    return { ...dependency, refs };
  });
  const lines = [
    '# Third-party notices', '',
    'SMART Flint’s Community License applies to its own code. Third-party components retain their original licenses and notices.', '',
    'This inventory covers the locked production npm dependency tree, including browser bundles and platform-specific optional packages. It may include components absent from a particular SDK or build. Development tools, the Python interpreter/standard library, operating-system images, and platform SDKs have their own terms. Container releases additionally supply an image SBOM. Python SDK source uses only its standard library.', '',
    'Generated from package-lock.json and installed package notices by `node scripts/generate-notices.mjs`. esbuild platform packages share the notice supplied by the matching esbuild package. License text supplied in package README files is retained below.', '',
    '| Component | Declared license | Retained notice |', '| --- | --- | --- |',
    ...entries.map(entry => `| ${entry.name}@${entry.version} | ${entry.license} | ${entry.refs.map(hash => `[${hash}](#notice-${hash})`).join(', ')} |`), '',
  ];
  for (const [hash, notice] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) lines.push(
    `<a id="notice-${hash}"></a>`, '', `## ${[...notice.names].sort().join(', ')}`, '',
    `Source: ${[...notice.sources].sort().join('; ')}`, '', '````text', notice.text, '````', '',
  );
  return `${lines.join('\n')}\n`;
}

export function writeNotices(root = projectRoot, check = false) {
  const content = generateNotices(root), license = readFileSync(join(root, 'LICENSE'), 'utf8');
  for (const target of targets) {
    const dir = join(root, target);
    for (const [name, value] of [['THIRD_PARTY_NOTICES.md', content], ...(target ? [['LICENSE', license]] : [])]) {
      const path = join(dir, name);
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('License output must not be a symbolic link.');
      if (check) {
        if (!existsSync(path) || readFileSync(path, 'utf8') !== value) throw new Error(`Outdated license artifact: ${target}/${name}. Run npm run notices:generate.`);
      } else writeFileSync(path, value, { mode: 0o644 });
    }
  }
  return content;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/generate-notices.mjs [--check]');
  writeNotices(projectRoot, process.argv.includes('--check'));
  process.stdout.write(`Third-party notices ${process.argv.includes('--check') ? 'verified' : 'generated'}; SDK license copies are synchronized.\n`);
}
