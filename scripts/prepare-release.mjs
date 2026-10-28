import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { lockedProductionDependencies, projectRoot, writeNotices } from './generate-notices.mjs';

const roots = ['.github', 'apps', 'deploy', 'docs', 'examples', 'packages', 'samples', 'scripts', 'sdks', 'tests'];
const files = ['install.sh', 'install.ps1', '.nvmrc', '.dockerignore', '.env.example', '.gitignore', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'compose.yaml', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'];
const excluded = new Set(['node_modules', 'dist', 'build', '.git', '.data', '.venv', '.build', '.cache', '.swiftpm', '.gradle', '.pytest_cache', '__pycache__', 'coverage', '.DS_Store']);
const sensitiveFile = /(?:\.(?:pem|key|p12|pfx|sqlite(?:-.*)?|db(?:-.*)?|crt|cer|keystore|jks|log)|(?:^|\/)\.npmrc)$/i;
const completePrivateKey = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z\d-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z\d-]*))*)?$/;
const hash = data => createHash('sha256').update(data).digest('hex');
const textFile = (path, data) => writeFileSync(path, data, { mode: 0o644, flag: 'wx' });
function fileHash(path) {
  const digest = createHash('sha256'), fd = openSync(path, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let bytes; while ((bytes = readSync(fd, buffer)) !== 0) digest.update(buffer.subarray(0, bytes)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
}

export function releaseVersion(root = projectRoot) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'smart-flint' || !semver.test(pkg.version)) throw new Error('Release requires the SMART Flint package and a canonical semver without build metadata.');
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Root package and lockfile versions differ.');
  for (const path of ['packages/contracts/package.json', 'packages/sdk/package.json', 'apps/server/package.json']) {
    if (JSON.parse(readFileSync(join(root, path), 'utf8')).version !== pkg.version) throw new Error('Service and public SDK versions must match before release.');
  }
  return pkg.version;
}

export function sourceFiles(root = projectRoot) {
  const result = [];
  function visit(path) {
    const rel = relative(root, path).split('\\').join('/');
    const parts = rel.split('/'), name = parts.at(-1);
    if (parts.some(part => excluded.has(part) || part.endsWith('.egg-info')) || (name.startsWith('.env') && name !== '.env.example') || /\.(?:pyc|pyo)$/.test(name)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Source archives reject symbolic links: ${rel}.`);
    if (stat.isDirectory()) { for (const child of readdirSync(path).sort()) visit(join(path, child)); return; }
    if (!stat.isFile() || sensitiveFile.test(rel) || stat.size > 20 * 1024 * 1024) throw new Error(`Source archives reject private or unsupported files: ${rel}.`);
    const data = readFileSync(path);
    if (completePrivateKey.test(data.toString('utf8'))) throw new Error(`Source archives reject embedded private keys: ${rel}.`);
    result.push({ path: rel, data, executable: !!(stat.mode & 0o111) });
  }
  for (const file of files) {
    if (!existsSync(join(root, file))) throw new Error(`Missing release source file: ${file}.`);
    visit(join(root, file));
  }
  for (const directory of roots) if (existsSync(join(root, directory))) visit(join(root, directory));
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function sourceArchive(entries, prefix, epoch = 0) {
  if (!/^smart-flint-[A-Za-z0-9.-]+$/.test(prefix) || !Number.isSafeInteger(epoch) || epoch < 0 || epoch > 8589934591) throw new Error('Invalid archive metadata.');
  const chunks = [];
  const octal = (header, value, offset, length) => {
    const field = value.toString(8).padStart(length - 1, '0');
    if (field.length >= length) throw new Error('Archive numeric value overflow.');
    header.write(`${field}\0`, offset, length, 'ascii');
  };
  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Unsafe archive path.');
    const fullName = `${prefix}/${entry.path}`;
    let name = fullName, parent = '';
    if (Buffer.byteLength(name) > 100) {
      const splits = [...fullName.matchAll(/\//g)].map(match => match.index).reverse();
      const split = splits.find(index => Buffer.byteLength(fullName.slice(index + 1)) <= 100 && Buffer.byteLength(fullName.slice(0, index)) <= 155);
      if (split === undefined) throw new Error('Source path exceeds portable archive limits.');
      name = fullName.slice(split + 1); parent = fullName.slice(0, split);
    }
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8'); octal(header, entry.executable ? 0o755 : 0o644, 100, 8);
    octal(header, 0, 108, 8); octal(header, 0, 116, 8); octal(header, entry.data.length, 124, 12); octal(header, epoch, 136, 12);
    header.fill(0x20, 148, 156); header[156] = 0x30; header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(parent, 345, 155, 'utf8');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, entry.data, Buffer.alloc((512 - entry.data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export function dependencySBOM(root, version, epoch = 0) {
  const id = `SPDXRef-SMART-Flint-${version.replace(/[^A-Za-z0-9.-]/g, '-')}`;
  const license = readFileSync(join(root, 'LICENSE'), 'utf8');
  const dependencies = lockedProductionDependencies(root);
  const seen = new Set();
  const packages = dependencies.filter(item => {
    const key = `${item.name}@${item.version}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(item => {
    const npmIntegrity = item.integrity?.split(' ').find(value => value.startsWith('sha512-'));
    return {
      SPDXID: `SPDXRef-npm-${hash(`${item.name}@${item.version}`).slice(0, 24)}`, name: item.name, versionInfo: item.version,
      downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: item.license,
      copyrightText: 'NOASSERTION', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:npm/${item.name.replace('@', '%40')}@${item.version}` }],
      ...(npmIntegrity ? { checksums: [{ algorithm: 'SHA512', checksumValue: Buffer.from(npmIntegrity.slice(7), 'base64').toString('hex') }] } : {}),
    };
  });
  return {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: `SMART Flint ${version} production npm dependency inventory`,
    documentNamespace: `https://xinonix.com/spdx/smart-flint/${version}/${hash(readFileSync(join(root, 'package-lock.json')))}`,
    creationInfo: { creators: ['Tool: smart-flint-prepare-release'], created: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z') },
    documentDescribes: [id],
    packages: [{ SPDXID: id, name: 'SMART Flint', versionInfo: version, downloadLocation: 'NOASSERTION', filesAnalyzed: false,
      licenseConcluded: 'LicenseRef-SMART-Flint-Community-1.0', licenseDeclared: 'LicenseRef-SMART-Flint-Community-1.0', copyrightText: 'Copyright (c) 2026 Xinonix Interactive Development, Inc.' }, ...packages],
    relationships: packages.map(item => ({ spdxElementId: id, relationshipType: 'DEPENDS_ON', relatedSpdxElement: item.SPDXID })),
    hasExtractedLicensingInfos: [{ licenseId: 'LicenseRef-SMART-Flint-Community-1.0', extractedText: license, name: 'SMART Flint Community License 1.0' }],
    annotations: [{ annotationType: 'OTHER', annotator: 'Tool: smart-flint-prepare-release', annotationDate: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z'),
      comment: 'Inventory of locked production npm dependencies, including optional platform packages and browser bundles. Does not inventory container OS packages, Node/Python interpreters, development tools, or platform SDKs. Image releases require a separate image SBOM.' }],
  };
}

export function prepareRelease({ root = projectRoot, output, sdkDirectory, imageArchive, imageSbom, epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 0) } = {}) {
  const version = releaseVersion(root);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('SOURCE_DATE_EPOCH must be a nonnegative integer.');
  writeNotices(root, true);
  const entries = sourceFiles(root); // Reject private sources before creating any artifact.
  const destination = resolve(output ?? join(root, '.data/releases', version));
  if (destination === root || root.startsWith(`${destination}/`)) throw new Error('Choose an isolated release output directory.');
  if (destination.startsWith(`${root}/`) && !['.data', 'dist'].includes(relative(root, destination).split('/')[0])) throw new Error('Release output inside the checkout must use .data or dist.');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 }); // Existing candidates are immutable; never overwrite them.
  try {
    const sdk = sdkDirectory ? resolve(sdkDirectory) : join(destination, 'sdk');
    if (!sdkDirectory) {
      execFileSync(process.execPath, [join(root, 'scripts/package-sdks.mjs'), '--output', sdk], { cwd: root, stdio: 'inherit' });
      execFileSync(process.env.PYTHON ?? 'python3', [join(root, 'scripts/build-python-sdk.py'), '--output', sdk], { cwd: root, stdio: 'inherit' });
    }
    const sdkFiles = readdirSync(sdk).filter(name => /\.(tgz|whl|tar\.gz)$/.test(name)).sort();
    if (sdkFiles.length !== 4 || !sdkFiles.includes(`smart-flint-sdk-${version}.tgz`) || !sdkFiles.includes(`smart-flint-contracts-${version}.tgz`)
      || sdkFiles.filter(name => name.endsWith('.whl')).length !== 1 || sdkFiles.filter(name => name.endsWith('.tar.gz')).length !== 1) throw new Error('Expected exactly two npm packages and Python wheel/source SDK artifacts.');
    execFileSync(process.env.PYTHON ?? 'python3', [join(root, 'scripts/verify-release-sdks.py'), '--directory', sdk, '--version', version, '--license', join(root, 'LICENSE')], { cwd: root, stdio: 'inherit' });
    for (const name of sdkFiles) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || !lstatSync(join(sdk, name)).isFile() || lstatSync(join(sdk, name)).isSymbolicLink()) throw new Error('Unsafe SDK artifact.');
      copyFileSync(join(sdk, name), join(destination, name), constants.COPYFILE_EXCL);
    }
    if (!!imageArchive !== !!imageSbom) throw new Error('A container image archive and its image SBOM must be supplied together.');
    for (const [input, name] of [[imageArchive, `smart-flint-${version}-image.tar.gz`], [imageSbom, 'image-sbom.cdx.json']]) {
      if (!input) continue;
      const stat = lstatSync(input);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Image artifacts must be nonempty regular files.');
      if (name.endsWith('.json')) {
        const sbom = JSON.parse(readFileSync(input, 'utf8'));
        if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) throw new Error('Expected a CycloneDX image SBOM.');
      }
      copyFileSync(input, join(destination, name), constants.COPYFILE_EXCL);
    }
    if (!sdkDirectory) rmSync(sdk, { recursive: true });
    textFile(join(destination, `smart-flint-${version}-source.tar.gz`), sourceArchive(entries, `smart-flint-${version}`, epoch));
    textFile(join(destination, 'sbom.spdx.json'), `${JSON.stringify(dependencySBOM(root, version, epoch), null, 2)}\n`);
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md']) copyFileSync(join(root, name), join(destination, name), constants.COPYFILE_EXCL);
    const artifactFiles = readdirSync(destination).sort().map(name => ({ name, bytes: lstatSync(join(destination, name)).size, sha256: fileHash(join(destination, name)) }));
    textFile(join(destination, 'release-manifest.json'), `${JSON.stringify({
      product: 'SMART Flint', version, status: 'candidate', published: false, qualification: { vendorPathways: 'additional validation deferred by operator' },
      sourceDateEpoch: epoch, runtime: { node: readFileSync(join(root, '.nvmrc'), 'utf8').trim(), database: 'PostgreSQL' },
      sourceFiles: entries.map(item => ({ path: item.path, sha256: hash(item.data) })), artifacts: artifactFiles,
    }, null, 2)}\n`);
    const checksums = readdirSync(destination).sort().map(name => `${fileHash(join(destination, name))}  ${name}`).join('\n');
    textFile(join(destination, 'SHA256SUMS'), `${checksums}\n`);
    return destination;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'sdk-dir': { type: 'string' }, 'image-archive': { type: 'string' }, 'image-sbom': { type: 'string' } } });
  const destination = prepareRelease({ output: values.output, sdkDirectory: values['sdk-dir'], imageArchive: values['image-archive'], imageSbom: values['image-sbom'] });
  process.stdout.write(`Prepared private release candidate: ${destination}\nNo registry, repository release, or container image was published.\n`);
}
