import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

export const MAX_IMAGE_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
export const IMAGE_ARCHIVE_ERROR = 'The verified image archive is invalid, unsupported or exceeds the size limit. No image was loaded.';
const metadataLimit = 1024 * 1024;
const imageReference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,511}$/.test(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const invalid = () => { throw new Error(IMAGE_ARCHIVE_ERROR); };

async function readExactly(handle, position, size) {
  const value = Buffer.alloc(size); let read = 0;
  while (read < size) {
    const result = await handle.read(value, read, size - read, position + read);
    if (!result.bytesRead) invalid();
    read += result.bytesRead;
  }
  return value;
}
function stringField(value) {
  const end = value.indexOf(0), bytes = end === -1 ? value : value.subarray(0, end);
  if (end !== -1 && !value.subarray(end).equals(Buffer.alloc(value.length - end))) invalid();
  const result = bytes.toString('utf8'); if (!Buffer.from(result).equals(bytes)) invalid(); return result;
}
function octal(value) {
  const raw = value.toString('ascii').replace(/\0/g, ' ').trim();
  if (!/^[0-7]+$/.test(raw)) invalid();
  const result = Number.parseInt(raw, 8); if (!Number.isSafeInteger(result) || result < 0) invalid(); return result;
}
function archivePath(value, directory = false) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) invalid();
  if (value.startsWith('./')) value = value.slice(2);
  if (directory && value.endsWith('/')) value = value.slice(0, -1);
  if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) invalid();
  return value;
}

async function metadata(handle, entry) {
  if (!entry || entry.directory || entry.size < 1 || entry.size > metadataLimit) invalid();
  const bytes = await readExactly(handle, entry.position, entry.size);
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { invalid(); }
  return { bytes, value };
}

async function inspectTar(path, maximum) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1024 || info.size > maximum || info.size % 512) invalid();
    const entries = new Map(); let offset = 0, ended = false;
    while (offset + 512 <= info.size) {
      const header = await readExactly(handle, offset, 512);
      if (header.equals(Buffer.alloc(512))) {
        if (offset + 1024 > info.size || !(await readExactly(handle, offset + 512, 512)).equals(Buffer.alloc(512))) invalid();
        for (let position = offset + 1024; position < info.size; position += 65536) {
          const size = Math.min(65536, info.size - position);
          if (!(await readExactly(handle, position, size)).equals(Buffer.alloc(size))) invalid();
        }
        ended = true; break;
      }
      const checksum = octal(header.subarray(148, 156)); let sum = 0;
      for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
      if (sum !== checksum) invalid();
      const flag = header[156], directory = flag === 53;
      if (![0, 48, 53].includes(flag)) invalid();
      const name = stringField(header.subarray(0, 100)), prefix = stringField(header.subarray(345, 500));
      const key = archivePath(prefix ? `${prefix}/${name}` : name, directory), size = octal(header.subarray(124, 136));
      if ((directory && size) || entries.has(key) || entries.size >= 100000) invalid();
      const position = offset + 512, next = position + Math.ceil(size / 512) * 512;
      if (!Number.isSafeInteger(next) || next > info.size) invalid();
      entries.set(key, { position, size, directory }); offset = next;
    }
    if (!ended) invalid();
    const manifest = (await metadata(handle, entries.get('manifest.json'))).value;
    if (!Array.isArray(manifest) || manifest.length !== 1 || !manifest[0] || typeof manifest[0] !== 'object') invalid();
    const image = manifest[0], configPath = archivePath(image.Config), config = await metadata(handle, entries.get(configPath));
    if (!config.value || typeof config.value !== 'object' || Array.isArray(config.value)) invalid();
    const configDigest = sha256(config.bytes);
    if (/^(?:blobs\/sha256\/)?[a-f0-9]{64}(?:\.json)?$/.test(configPath)
      && configPath.replace(/^blobs\/sha256\//, '').replace(/\.json$/, '') !== configDigest) invalid();
    if (!Array.isArray(image.Layers) || !image.Layers.length || image.Layers.length > 10000
      || image.Layers.some(layer => { const entry = entries.get(archivePath(layer)); return !entry || entry.directory; })) invalid();
    const references = image.RepoTags ?? [];
    if (!Array.isArray(references) || references.length > 128 || references.some(value => !imageReference(value))) invalid();
    const expectedImageIds = [`sha256:${configDigest}`];
    if (entries.has('index.json')) {
      const index = (await metadata(handle, entries.get('index.json'))).value;
      if (!index || index.schemaVersion !== 2 || !Array.isArray(index.manifests) || !index.manifests.length || index.manifests.length > 128) invalid();
      for (const descriptor of index.manifests) {
        if (!descriptor || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) invalid();
        const blob = await metadata(handle, entries.get(`blobs/sha256/${descriptor.digest.slice(7)}`));
        if (`sha256:${sha256(blob.bytes)}` !== descriptor.digest || !Number.isSafeInteger(descriptor.size) || descriptor.size !== blob.bytes.length) invalid();
        expectedImageIds.push(descriptor.digest);
      }
    }
    return { references: [...new Set(references)], expectedImageIds: [...new Set(expectedImageIds)] };
  } finally { await handle.close(); }
}

/** Input has already been copied privately and checksum-verified by the caller. Nothing is extracted. */
export async function prepareImageArchive(path, { directory = dirname(path), maxExpandedBytes = MAX_IMAGE_ARCHIVE_BYTES } = {}) {
  let rawPath = path, created = false;
  try {
    if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1024 || maxExpandedBytes > MAX_IMAGE_ARCHIVE_BYTES) invalid();
    const source = await lstat(path);
    if (!source.isFile() || source.isSymbolicLink() || source.size > maxExpandedBytes || source.size < 2) invalid();
    const handle = await open(path, 'r'); let magic;
    try { magic = await readExactly(handle, 0, 2); } finally { await handle.close(); }
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
      rawPath = join(directory, `.image-raw-${randomBytes(12).toString('hex')}.tar`);
      const target = await open(rawPath, 'wx', 0o600); created = true; let expanded = 0;
      try {
        await pipeline(createReadStream(path), createGunzip(), new Transform({ transform(chunk, _encoding, done) {
          expanded += chunk.length; done(expanded > maxExpandedBytes ? new Error(IMAGE_ARCHIVE_ERROR) : null, expanded > maxExpandedBytes ? undefined : chunk);
        } }), new Writable({ write(chunk, _encoding, done) {
          (async () => {
            let position = 0;
            while (position < chunk.length) {
              const { bytesWritten } = await target.write(chunk, position, chunk.length - position);
              if (!bytesWritten) invalid(); position += bytesWritten;
            }
          })().then(() => done(), done);
        } }));
        await target.sync();
      } finally { await target.close(); }
    }
    return { path: rawPath, ...await inspectTar(rawPath, maxExpandedBytes), expanded: created };
  } catch {
    if (created) await unlink(rawPath).catch(() => {});
    throw new Error(IMAGE_ARCHIVE_ERROR);
  }
}
