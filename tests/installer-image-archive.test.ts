import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { IMAGE_ARCHIVE_ERROR, prepareImageArchive } from '../scripts/installer/image-archive.mjs';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function tar(entries: [string, Buffer][]) {
  const chunks: Buffer[] = [];
  for (const [name, data] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((total, value) => total + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function fixture(oci = false, tags = ['smart-flint:example']) {
  const config = Buffer.from(JSON.stringify({ architecture: 'arm64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } }));
  const configId = hash(config), configName = oci ? `blobs/sha256/${configId}` : `${configId}.json`;
  const layer = Buffer.from('synthetic opaque image layer'), layerName = oci ? `blobs/sha256/${hash(layer)}` : 'synthetic/layer.tar';
  const manifest = Buffer.from(JSON.stringify([{ Config: configName, RepoTags: tags, Layers: [layerName] }]));
  const entries: [string, Buffer][] = [[configName, config], [layerName, layer], ['manifest.json', manifest]];
  const ids = [`sha256:${configId}`];
  if (oci) {
    const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ config: { digest: `sha256:${configId}` } }] }));
    const id = hash(descriptor); ids.push(`sha256:${id}`);
    entries.push([`blobs/sha256/${id}`, descriptor], ['index.json', Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${id}`, size: descriptor.length }] }))]);
  }
  return { entries, bytes: tar(entries), ids };
}
async function save(bytes: Buffer, name = 'image.tar') {
  const directory = await mkdtemp(join(tmpdir(), 'flint-archive-tests-')); directories.push(directory);
  const path = join(directory, name); await writeFile(path, bytes, { mode: 0o600 }); return { directory, path };
}

it('reads classic raw image metadata without extraction and allows one image with multiple tags', async () => {
  const source = fixture(false, ['smart-flint:first', 'smart-flint:second']), { directory, path } = await save(source.bytes);
  expect(await prepareImageArchive(path)).toEqual({ path, references: ['smart-flint:first', 'smart-flint:second'], expectedImageIds: source.ids, expanded: false });
  expect(await readdir(directory)).toEqual(['image.tar']);
});

it('normalizes gzip into a private raw archive and authenticates OCI/config identity candidates', async () => {
  const source = fixture(true), { path } = await save(gzipSync(source.bytes), 'image.tar.gz');
  const prepared = await prepareImageArchive(path);
  expect(prepared.expanded).toBe(true); expect(prepared.path).not.toBe(path);
  expect((await stat(prepared.path)).mode & 0o777).toBe(0o600);
  expect(await readFile(prepared.path)).toEqual(source.bytes); expect(prepared.expectedImageIds).toEqual(source.ids);
});

it('rejects truncated payloads, missing end blocks and modified tar checksums', async () => {
  const source = fixture();
  const badChecksum = Buffer.from(source.bytes); badChecksum[0] = 99;
  for (const value of [source.bytes.subarray(0, 512), source.bytes.subarray(0, source.bytes.length - 512), badChecksum]) {
    const { path } = await save(value); await expect(prepareImageArchive(path)).rejects.toThrow(IMAGE_ARCHIVE_ERROR);
  }
});

it('rejects multiple logical images, unsafe paths and inconsistent config/index digests', async () => {
  const source = fixture(true);
  const manifestIndex = source.entries.findIndex(([name]) => name === 'manifest.json');
  const multiple = [...source.entries]; const first = JSON.parse(multiple[manifestIndex]![1].toString())[0];
  multiple[manifestIndex] = ['manifest.json', Buffer.from(JSON.stringify([first, first]))];
  const badConfig = [...source.entries]; badConfig[0] = [badConfig[0]![0], Buffer.from('{}')];
  const badIndex = [...source.entries]; const index = badIndex.findIndex(([name]) => name === 'index.json');
  badIndex[index] = ['index.json', Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${'a'.repeat(64)}`, size: 2 }] }))];
  for (const value of [tar(multiple), tar([['../private.env', Buffer.from('synthetic')], ...source.entries]), tar(badConfig), tar(badIndex)]) {
    const { path } = await save(value); await expect(prepareImageArchive(path)).rejects.toThrow(IMAGE_ARCHIVE_ERROR);
  }
});

it('bounds gzip expansion and removes private raw output after corrupt or oversized archives', async () => {
  const source = fixture();
  for (const value of [gzipSync(source.bytes), Buffer.from([0x1f, 0x8b, 0, 0, 0])]) {
    const { directory, path } = await save(value, 'image.tar.gz');
    await expect(prepareImageArchive(path, { maxExpandedBytes: 1024 })).rejects.toThrow(IMAGE_ARCHIVE_ERROR);
    expect(await readdir(directory)).toEqual(['image.tar.gz']);
  }
});
