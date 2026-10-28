import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { dependencySBOM, prepareRelease, releaseVersion, sourceArchive, sourceFiles } from '../scripts/prepare-release.mjs';
import { lockedProductionDependencies, projectRoot, writeNotices } from '../scripts/generate-notices.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flint-release-tests-')); roots.push(root);
  const files = ['install.sh', 'install.ps1', '.nvmrc', '.dockerignore', '.env.example', '.gitignore', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'compose.yaml', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'];
  for (const name of files) writeFileSync(join(root, name), 'Synthetic public release fixture.\n');
  for (const name of ['apps/server', 'packages/sdk', 'packages/contracts', 'sdks/python']) mkdirSync(join(root, name), { recursive: true });
  for (const name of ['package.json', 'apps/server/package.json', 'packages/sdk/package.json', 'packages/contracts/package.json']) writeFileSync(join(root, name), JSON.stringify({ name: name === 'package.json' ? 'smart-flint' : name, version: '0.1.0' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'smart-flint', version: '0.1.0' } } }));
  writeNotices(root);
  return root;
}
function syntheticSDKs(root: string, mode = 'valid') {
  const sdk = join(root, 'dist/sdk'); mkdirSync(sdk, { recursive: true });
  const built = spawnSync('python3', ['-c', `
from pathlib import Path
import io,json,sys,tarfile,zipfile
root=Path(sys.argv[1]); sdk=Path(sys.argv[2]); mode=sys.argv[3]
license=(root/'LICENSE').read_bytes()
def archive(path,values):
    with tarfile.open(path,'w:gz') as output:
        for name,data in values.items():
            entry=tarfile.TarInfo(name); entry.size=len(data); output.addfile(entry,io.BytesIO(data))
for package in ['sdk','contracts']:
    values={'package/package.json':json.dumps({'name':'@smart-flint/'+package,'version':'0.1.0'}).encode(),
      'package/dist/index.js':b'export {};','package/dist/index.d.ts':b'export {};','package/README.md':b'Synthetic SDK',
      'package/LICENSE':license,'package/THIRD_PARTY_NOTICES.md':b'Synthetic notices'}
    archive(sdk/('smart-flint-'+package+'-0.1.0.tgz'),values)
with zipfile.ZipFile(sdk/'smart_flint-0.1.0-py3-none-any.whl','w') as wheel:
    values={'smart_flint/client.py':b'# synthetic','smart_flint/py.typed':b'',
      'smart_flint-0.1.0.dist-info/METADATA':b'Name: smart-flint\\nVersion: 0.1.0\\n',
      'smart_flint-0.1.0.dist-info/licenses/LICENSE':license if mode!='wrong-license' else b'Wrong license',
      'smart_flint-0.1.0.dist-info/licenses/THIRD_PARTY_NOTICES.md':b'Synthetic notices'}
    for name,data in values.items(): wheel.writestr(name,data)
values={'smart_flint-0.1.0/PKG-INFO':b'Name: smart-flint\\nVersion: 0.1.0\\n',
 'smart_flint-0.1.0/LICENSE':license,'smart_flint-0.1.0/THIRD_PARTY_NOTICES.md':b'Synthetic notices'}
if mode=='traversal': values['../.env']=b'Synthetic credential sentinel'
archive(sdk/'smart_flint-0.1.0.tar.gz',values)
`, root, sdk, mode], { encoding: 'utf8' });
  expect(built.status, built.stderr).toBe(0);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(projectRoot, 'scripts/verify-release-sdks.py'), join(root, 'scripts/verify-release-sdks.py'));
  return sdk;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('release source and license boundaries', () => {
  it('retains Community licensing and synchronized SDK notices without rewriting dependency licenses', () => {
    expect(readFileSync(join(projectRoot, 'LICENSE'), 'utf8')).toMatch(/^SMART Flint COMMUNITY LICENSE/);
    expect(readFileSync(join(projectRoot, 'LICENSE'), 'utf8')).toContain('USD 5,000,000');
    expect(() => writeNotices(projectRoot, true)).not.toThrow();
    const dependencies = lockedProductionDependencies(projectRoot);
    expect(dependencies.length).toBeGreaterThan(50);
    expect(dependencies.some(item => item.license === 'MIT')).toBe(true);
    expect(dependencies.every(item => !item.license.includes('SMART'))).toBe(true);
  });

  it('excludes private deployment directories and .env files while retaining the empty environment example', () => {
    const root = fixture();
    for (const path of ['.data/deployment.sqlite', '.env', 'apps/server/.env.production', 'packages/sdk/dist/private.js', 'node_modules/package/private.js']) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), 'synthetic secret sentinel');
    }
    const entries = sourceFiles(root);
    expect(entries.some(item => item.path === '.env.example')).toBe(true);
    expect(entries.some(item => item.path === '.nvmrc')).toBe(true);
    expect(entries.some(item => item.data.includes('synthetic secret sentinel'))).toBe(false);
  });

  it('rejects a source symlink instead of following it into a private location', () => {
    const root = fixture();
    writeFileSync(join(root, '.env'), 'synthetic private sentinel');
    symlinkSync(join(root, '.env'), join(root, 'apps/server/config.txt'));
    expect(() => sourceFiles(root)).toThrow(/symbolic links/);
  });

  it('rejects accidental certificates, keys and databases in allowed source directories', () => {
    const root = fixture();
    for (const name of ['developer.key', 'private.pem', 'deployment.sqlite', 'passwords.db']) {
      const path = join(root, 'apps/server', name); writeFileSync(path, 'synthetic');
      expect(() => sourceFiles(root)).toThrow(/private or unsupported/); rmSync(path);
    }
  });

  it('rejects an embedded complete private key even in an ordinary source file', () => {
    const root = fixture();
    writeFileSync(join(root, 'apps/server/config.ts'), `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(80)}\n-----END PRIVATE KEY-----`);
    expect(() => sourceFiles(root)).toThrow(/embedded private keys/);
  });

  it('builds reproducible portable archives with fixed timestamps and safe ownership', () => {
    const entries = [{ path: 'scripts/run.mjs', data: Buffer.from('synthetic public source'), executable: true }];
    const first = sourceArchive(entries, 'smart-flint-0.1.0', 1700000000);
    expect(first.equals(sourceArchive(entries, 'smart-flint-0.1.0', 1700000000))).toBe(true);
    const tar = gunzipSync(first);
    expect(tar.subarray(0, 100).toString().replace(/\0.*$/, '')).toBe('smart-flint-0.1.0/scripts/run.mjs');
    expect(parseInt(tar.subarray(100, 107).toString(), 8)).toBe(0o755);
    expect(parseInt(tar.subarray(108, 115).toString(), 8)).toBe(0);
    expect(parseInt(tar.subarray(136, 147).toString(), 8)).toBe(1700000000);
    expect(tar.subarray(512, 535).toString()).toContain('synthetic public source');
  });

  it('rejects archive traversal and invalid timestamp fields', () => {
    expect(() => sourceArchive([{ path: '../.env', data: Buffer.from('x'), executable: false }], 'smart-flint-0.1.0')).toThrow(/Unsafe archive path/);
    expect(() => sourceArchive([], 'smart-flint-0.1.0', -1)).toThrow(/Invalid archive metadata/);
  });

  it('requires matching service, public SDK and lockfile versions', () => {
    const root = fixture(); expect(releaseVersion(root)).toBe('0.1.0');
    writeFileSync(join(root, 'packages/sdk/package.json'), JSON.stringify({ version: '0.2.0' }));
    expect(() => releaseVersion(root)).toThrow(/versions must match/);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'smart-flint', version: '01.0.0' }));
    expect(() => releaseVersion(root)).toThrow(/canonical semver/);
  });

  it('does not overwrite an existing release candidate directory', () => {
    const root = fixture(), output = join(root, '.data/candidate'); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'reviewed-artifact.txt'), 'keep');
    expect(() => prepareRelease({ root, output })).toThrow();
    expect(readFileSync(join(output, 'reviewed-artifact.txt'), 'utf8')).toBe('keep');
  });

  it('keeps release outputs outside the source directories', () => {
    const root = fixture(); expect(() => prepareRelease({ root, output: join(root, 'apps/release') })).toThrow(/must use .data or dist/);
  });

  it('assembles a checked candidate without publishing and refuses a changed SDK product license', () => {
    const root = fixture(), sdkDirectory = syntheticSDKs(root), output = join(root, '.data/valid-candidate');
    expect(prepareRelease({ root, sdkDirectory, output })).toBe(output);
    const manifest = JSON.parse(readFileSync(join(output, 'release-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: '0.1.0', status: 'candidate', published: false });
    expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toContain('smart-flint-0.1.0-source.tar.gz');
    syntheticSDKs(root, 'wrong-license');
    const rejected = join(root, '.data/rejected-candidate');
    expect(() => prepareRelease({ root, sdkDirectory, output: rejected })).toThrow();
    expect(existsSync(rejected)).toBe(false);
    expect(existsSync(output)).toBe(true);
  });

  it('rejects traversal inside a supplied SDK archive before producing candidate artifacts', () => {
    const root = fixture(), sdkDirectory = syntheticSDKs(root, 'traversal'), output = join(root, '.data/rejected-candidate');
    expect(() => prepareRelease({ root, sdkDirectory, output })).toThrow();
    expect(existsSync(output)).toBe(false);
  });

  it('separates the npm SBOM scope from the image inventory and embeds the actual product license', () => {
    const root = fixture();
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.0', lockfileVersion: 3, packages: {
      '': { version: '0.1.0' },
      'node_modules/production-example': { version: '1.2.3', license: 'MIT', integrity: `sha512-${Buffer.from('synthetic-integrity').toString('base64')}` },
      'node_modules/development-example': { version: '1.2.3', license: 'MIT', dev: true },
    } }));
    const sbom = dependencySBOM(root, '0.1.0');
    expect(sbom.spdxVersion).toBe('SPDX-2.3'); expect(sbom.packages.map(item => item.name)).toEqual(['SMART Flint', 'production-example']);
    expect(sbom.packages[1]!.checksums![0]!.checksumValue).toBe(Buffer.from('synthetic-integrity').toString('hex'));
    expect(sbom.annotations[0]!.comment).toContain('Does not inventory container OS packages');
    expect(JSON.stringify(sbom)).toContain('Synthetic public release fixture.');
  });
});
