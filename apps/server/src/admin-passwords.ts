import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Bridge } from './bridge.js';
import { assert } from './errors.js';

// OWASP's 64 MiB scrypt profile. Parameters are pinned rather than accepted from storage.
const parameters = { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 } as const;
const saltLength = 32, keyLength = 64;
const dummySalt = randomBytes(saltLength);
const weakPasswords = new Set([
  'passwordpassword', 'password123456789', 'password1234567890', '123456789012345', '1234567890123456',
  'qwertyuiopasdfgh', 'adminadminadmin', 'adminadminadminadmin', 'administrator123', 'letmeinletmeinletmein',
  'thisisapassword', 'changemechangeme', 'smartflintsmartflint', 'smart-flint-admin',
]);

export interface LocalPasswordRecord {
  format: 'scrypt-v1';
  /** Rotated with every change; local sessions bind to this value. */
  version: string;
  salt: string;
  key: string;
}

export function normalizeUsername(value: unknown): string {
  assert(typeof value === 'string' && value.length <= 256, 400, 'invalid_username', 'Use a username of 1–64 letters, numbers, dots, underscores or hyphens.');
  const trimmed = value.trim();
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed), 400, 'invalid_username', 'Use a username of 1–64 letters, numbers, dots, underscores or hyphens.');
  return trimmed.toLowerCase();
}

export function validateAdminPassword(password: unknown): asserts password is string {
  assert(typeof password === 'string' && password.length <= 1024 && Buffer.byteLength(password, 'utf8') <= 1024
    && !/[\uD800-\uDFFF]/u.test(password), 400, 'invalid_password', 'Use a password of 15–128 Unicode characters and at most 1024 UTF-8 bytes.');
  const length = [...password].length;
  assert(length >= 15 && length <= 128, 400, 'invalid_password', 'Use a password of 15–128 Unicode characters and at most 1024 UTF-8 bytes.');
  assert(!/^\s+$/u.test(password) && !weakPasswords.has(password.toLowerCase()) && !/^(.)\1+$/su.test(password),
    400, 'weak_password', 'Choose a less common password or a longer, unique passphrase.');
}

// Bound both memory-intensive work and waiting callers. This is shared across repositories.
let active = 0;
const waiting: (() => void)[] = [];
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= 2) {
    assert(waiting.length < 8, 503, 'authentication_busy', 'Password authentication is busy. Try again shortly.');
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, keyLength, parameters, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

function validRecord(value: unknown): value is LocalPasswordRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4 && record.format === 'scrypt-v1'
    && typeof record.version === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.version)
    && typeof record.salt === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.salt)
    && Buffer.from(record.salt, 'base64url').toString('base64url') === record.salt
    && typeof record.key === 'string' && /^[A-Za-z0-9_-]{86}$/.test(record.key)
    && Buffer.from(record.key, 'base64url').toString('base64url') === record.key;
}

export async function getLocalPasswordRecord(bridge: Bridge, userId: string): Promise<LocalPasswordRecord | undefined> {
  const value = await bridge.vault.get<unknown>(`admin-password:${userId}`);
  return validRecord(value) ? value : undefined;
}

/** Caller owns admin:write so credential rotation is serialized with sign-in and user updates. */
export async function setLocalPassword(bridge: Bridge, userId: string, password: string): Promise<void> {
  validateAdminPassword(password);
  const salt = randomBytes(saltLength);
  const key = await derive(password, salt);
  try {
    await bridge.vault.set(`admin-password:${userId}`, { format: 'scrypt-v1', version: randomBytes(32).toString('base64url'),
      salt: salt.toString('base64url'), key: key.toString('base64url') } satisfies LocalPasswordRecord);
  } finally { key.fill(0); }
}

/** A missing/invalid account still performs the complete KDF before returning false. */
export async function verifyLocalPassword(bridge: Bridge, userId: string | undefined, password: string): Promise<boolean> {
  const record = userId ? await getLocalPasswordRecord(bridge, userId) : undefined;
  const actual = await derive(password, record ? Buffer.from(record.salt, 'base64url') : dummySalt);
  try { return !!record && timingSafeEqual(actual, Buffer.from(record.key, 'base64url')); }
  finally { actual.fill(0); }
}
