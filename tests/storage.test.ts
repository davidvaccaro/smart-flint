import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, openRepository, pkceChallenge, SecretVault, type Repository } from '../packages/storage/src/index.js';

const repositories: Repository[] = [];
async function memory() {
  const repository = await openRepository({ sqlitePath: ':memory:' });
  repositories.push(repository);
  return repository;
}
afterEach(async () => { await Promise.all(repositories.splice(0).map(repo => repo.close())); });

describe('repository', () => {
  it('atomically consumes one-use records once under contention', async () => {
    const repo = await memory();
    await repo.put('handoffs', { id: 'code', applicationId: 'app' });
    const results = await Promise.all(Array.from({ length: 20 }, () => repo.consume('handoffs', 'code')));
    expect(results.filter(Boolean)).toEqual([{ id: 'code', applicationId: 'app' }]);
    expect(await repo.get('handoffs', 'code')).toBeUndefined();
  });

  it('serializes refresh operations sharing a grant while releasing after failure', async () => {
    const repo = await memory();
    await repo.put('grants', { id: 'grant', generation: 0 });
    await expect(repo.withLock('grant', async () => { throw new Error('interrupted'); })).rejects.toThrow('interrupted');
    await Promise.all(Array.from({ length: 12 }, () => repo.withLock('grant', async () => {
      const current = await repo.get<{ id: string; generation: number }>('grants', 'grant');
      await Promise.resolve();
      await repo.put('grants', { id: 'grant', generation: current!.generation + 1 });
    })));
    expect(await repo.get('grants', 'grant')).toEqual({ id: 'grant', generation: 12 });
  });

  it('rejects table injection and does not mutate caller records', async () => {
    const repo = await memory();
    await expect(repo.list('tenants; DROP TABLE smart_flint_secrets')).rejects.toThrow('Unknown repository collection');
    const input = { id: 'tenant', name: 'Original' };
    const returned = await repo.put('tenants', input);
    returned.name = 'Changed';
    expect(await repo.get('tenants', input.id)).toEqual(input);
  });
});

describe('secret vault', () => {
  it('encrypts at rest with randomized envelopes and authenticates the secret ID', async () => {
    const repo = await memory();
    const vault = new SecretVault(repo, randomBytes(32));
    const secret = { access_token: 'sensitive-access-token', refresh_token: 'refresh-token' };
    await vault.set('grant-a', secret);
    const first = await repo.get<Record<string, unknown>>('secrets', 'grant-a');
    expect(JSON.stringify(first)).not.toContain(secret.access_token);
    expect(await vault.get('grant-a')).toEqual(secret);
    await vault.set('grant-a', secret);
    const second = await repo.get<Record<string, unknown>>('secrets', 'grant-a');
    expect(second?.ciphertext).not.toBe(first?.ciphertext);
    await repo.put('secrets', { ...second, id: 'grant-b' });
    await expect(vault.get('grant-b')).rejects.toThrow('Secret authentication failed');
  });

  it('fails closed for the wrong key or modified ciphertext', async () => {
    const repo = await memory();
    const key = randomBytes(32);
    const vault = new SecretVault(repo, key.toString('base64'));
    await vault.set('secret', 'token');
    await expect(new SecretVault(repo, randomBytes(32)).get('secret')).rejects.toThrow('Secret authentication failed');
    const sealed = await repo.get<{ id: string; ciphertext: string }>('secrets', 'secret');
    await repo.put('secrets', { ...sealed!, ciphertext: Buffer.from('tampered').toString('base64') });
    await expect(vault.get('secret')).rejects.toThrow('Secret authentication failed');
    expect(() => new SecretVault(repo, 'invalid')).toThrow('32 bytes');
  });
});

it('produces the RFC 7636 S256 challenge', () => {
  expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  expect(digest('example')).toMatch(/^[\w-]{43}$/);
});
