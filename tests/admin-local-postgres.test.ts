import { randomBytes } from 'node:crypto';
import type { HTTPMethods } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/server/src/app.js';
import { getLocalPasswordRecord, setLocalPassword } from '../apps/server/src/admin-passwords.js';
import type { AdminUser } from '../packages/contracts/src/index.js';
import { digest, openRepository, randomId, type Repository } from '../packages/storage/src/index.js';

const databaseUrl = process.env.SMART_FLINT_TEST_DATABASE_URL;
const origin = 'https://local-admin-pg-flint.example';
const password = 'Independent pool local passphrase 47!';
const newPassword = 'Rotated across both service pools 82!';

describe.skipIf(!databaseUrl)('PostgreSQL local administrative authentication across service instances', () => {
  let first: Repository;
  let second: Repository;
  let runtimeA: Awaited<ReturnType<typeof buildApp>> | undefined;
  let runtimeB: Awaited<ReturnType<typeof buildApp>> | undefined;
  let ownedSigningRecord: unknown;
  let sourceAddress = 1;
  const records = new Map<string, Set<string>>();

  function own(collection: string, id: string) {
    const values = records.get(collection) ?? new Set<string>();
    values.add(id); records.set(collection, values);
  }

  beforeAll(async () => {
    first = await openRepository({ databaseUrl });
    second = await openRepository({ databaseUrl });
    if (await first.get('secrets', 'bridge-signing')) throw new Error('Use a dedicated integration test database without a pre-existing runtime signing key.');
    const config = {
      demo: false, adminAuthMode: 'local' as const, adminBootstrapEnabled: false, adminOidc: undefined,
      host: '127.0.0.1', port: 0, baseUrl: origin, consoleUrl: origin, adminToken: '',
      encryptionKey: randomBytes(32).toString('base64'), databaseUrl, sqlitePath: ':memory:',
    };
    runtimeA = await buildApp({ repository: first, seed: false, serveConsole: false, config });
    ownedSigningRecord = await first.get('secrets', 'bridge-signing');
    runtimeB = await buildApp({ repository: second, seed: false, serveConsole: false, config });
    await runtimeA.app.ready(); await runtimeB.app.ready();
  });

  afterEach(async () => {
    if (!first) return;
    for (const [collection, ids] of records) for (const id of ids) await first.delete(collection, id);
    records.clear();
  });

  afterAll(async () => {
    await runtimeA?.app.close(); await runtimeB?.app.close();
    if (first) {
      if (ownedSigningRecord && JSON.stringify(await first.get('secrets', 'bridge-signing')) === JSON.stringify(ownedSigningRecord)) await first.delete('secrets', 'bridge-signing');
      await first.close();
    }
    if (second) await second.close();
  });

  async function user() {
    const timestamp = new Date().toISOString();
    const record: AdminUser = { id: randomId('admin_local_pg_user'), authMethod: 'local', username: `pg-${randomBytes(12).toString('hex')}`,
      displayName: 'PostgreSQL local viewer', role: 'viewer', organizationIds: [], applicationIds: [], disabled: false,
      createdAt: timestamp, updatedAt: timestamp };
    own('admin_users', record.id); own('secrets', `admin-password:${record.id}`);
    own('replays', `admin-login:${digest(record.username!)}`); own('replays', `admin-password-change:${digest(record.id)}`);
    await first.withLock('admin:write', async () => {
      await setLocalPassword(runtimeA!.bridge, record.id, password);
      await first.put('admin_users', record);
    });
    return record;
  }

  async function request(runtime: NonNullable<typeof runtimeA>, method: HTTPMethods, url: string, payload?: unknown, cookie?: string) {
    // The dedicated database runs these cases serially. Capture anonymous failure-event IDs as well as named audit events.
    const existingEvents = new Set((await first.list<{ id: string }>('events')).map(event => event.id));
    const result = await runtime.app.inject({ method, url, remoteAddress: `198.51.100.${sourceAddress++}`, headers: { origin, ...(cookie ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }) });
    for (const event of await first.list<{ id: string }>('events')) if (!existingEvents.has(event.id)) own('events', event.id);
    const value = result.cookies.find(item => item.name === 'smart_flint_admin')?.value;
    if (value) own('sessions', `admin:${digest(value)}`);
    return result;
  }

  const login = (runtime: NonNullable<typeof runtimeA>, record: AdminUser, suppliedPassword = password, suppliedUsername = record.username!) =>
    request(runtime, 'POST', '/api/admin/session', { username: suppliedUsername, password: suppliedPassword });

  function cookie(result: Awaited<ReturnType<typeof login>>) {
    expect(result.statusCode, result.body).toBe(200);
    const value = result.cookies.find(item => item.name === 'smart_flint_admin')?.value;
    expect(value).toBeTruthy();
    return `smart_flint_admin=${value}`;
  }

  it('revokes every previous session on the independent pool after a password change and accepts the new password', async () => {
    const record = await user();
    const cookieA = cookie(await login(runtimeA!, record)), cookieB = cookie(await login(runtimeB!, record));
    const before = await getLocalPasswordRecord(runtimeB!.bridge, record.id);
    expect((await request(runtimeB!, 'GET', '/api/admin/session', undefined, cookieA)).json().authenticated).toBe(true);
    const changed = await request(runtimeA!, 'POST', '/api/admin/password', { currentPassword: password, newPassword }, cookieA);
    expect(changed.statusCode, changed.body).toBe(200); expect(changed.json()).toEqual({ changed: true, reauthenticationRequired: true });
    const after = await getLocalPasswordRecord(runtimeB!.bridge, record.id);
    expect(after!.version).not.toBe(before!.version);
    for (const previous of [cookieA, cookieB]) expect((await request(runtimeB!, 'GET', '/api/admin/session', undefined, previous)).json().authenticated).toBe(false);
    expect((await login(runtimeB!, record)).statusCode).toBe(401);
    const fresh = await login(runtimeB!, record, newPassword);
    expect(fresh.statusCode, fresh.body).toBe(200); expect(fresh.json().identity).toMatchObject({ id: record.id, kind: 'local', role: 'viewer' });
  });

  it('commits failed-credential counters despite 401 responses and enforces the shared normalized-username throttle', async () => {
    const record = await user(), id = `admin-login:${digest(record.username!)}`;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const runtime = attempt % 2 ? runtimeA! : runtimeB!;
      const username = attempt % 2 ? ` ${record.username!.toUpperCase()} ` : record.username!;
      const failed = await login(runtime, record, 'Wrong password used for persisted count!', username);
      expect(failed.statusCode, failed.body).toBe(401);
      expect(await second.get('replays', id)).toMatchObject({ attempts: attempt });
    }
    const blocked = await login(runtimeB!, record);
    expect(blocked.statusCode, blocked.body).toBe(429); expect(blocked.headers['retry-after']).toBe('900');
    expect(await first.get('replays', id)).toMatchObject({ attempts: 5 });
    const row = await first.get<{ id: string; attempts: number; expiresAt: string }>('replays', id);
    await first.put('replays', { ...row!, expiresAt: new Date(Date.now() - 1).toISOString() });
    const active = cookie(await login(runtimeA!, record));
    expect(await second.get('replays', id)).toBeUndefined();
    const failedChange = await request(runtimeB!, 'POST', '/api/admin/password', { currentPassword: 'Wrong current password for count!', newPassword }, active);
    expect(failedChange.statusCode, failedChange.body).toBe(401);
    expect(await first.get('replays', `admin-password-change:${digest(record.id)}`)).toMatchObject({ attempts: 1 });
    expect((await request(runtimeA!, 'POST', '/api/admin/password', { currentPassword: password, newPassword }, active)).statusCode).toBe(200);
    expect(await second.get('replays', `admin-password-change:${digest(record.id)}`)).toBeUndefined();
  });
});
