import { describe, expect, it } from 'vitest';
import { openRepository } from '../packages/storage/src/index.js';
import { Bridge } from '../apps/server/src/bridge.js';
import { loadConfig } from '../apps/server/src/config.js';
import { retireExpiredRecords } from '../apps/server/src/retention.js';

describe('bounded clinical and protocol retention', () => {
  it('retires expired transaction secrets, closes old grants, and removes old clinical context', async () => {
    const repo = await openRepository({ sqlitePath: ':memory:' });
    const bridge = new Bridge(repo, loadConfig({ demo: true, baseUrl: 'http://localhost:3001', consoleUrl: 'http://localhost:3010', encryptionKey: Buffer.alloc(32).toString('base64'), retentionHours: 24 }));
    const time = Date.now();
    await repo.put('transactions', { id: 'expired', expiresAt: new Date(time - 1).toISOString() });
    await bridge.vault.set('transaction:expired', { sensitive: 'synthetic-context' });
    await repo.put('sessions', { id: 'expired-session', expiresAt: new Date(time - 1).toISOString() });
    for (const [id, hours] of [['old', 25], ['active', 1]] as const) {
      const createdAt = new Date(time - hours * 3600_000).toISOString();
      await repo.put('activations', { id, status: 'ready', createdAt });
      await bridge.vault.set(`activation:${id}`, { id, status: 'ready', createdAt, tenantId: 'synthetic', installationId: 'synthetic', context: { patient: { reference: 'Patient/synthetic' }, extensions: {} } });
      await repo.put('grants', { id }); await bridge.vault.set(`grant:${id}`, { sensitive: 'synthetic-token' });
    }
    await retireExpiredRecords(bridge, time);
    expect(await repo.get('transactions', 'expired')).toBeUndefined();
    expect(await bridge.vault.get('transaction:expired')).toBeUndefined();
    expect(await repo.get('sessions', 'expired-session')).toBeUndefined();
    expect(await bridge.vault.get('activation:old')).toBeUndefined();
    expect(await bridge.vault.get('grant:old')).toBeUndefined();
    expect(await repo.get('activations', 'old')).toBeUndefined();
    expect(await bridge.vault.get('activation:active')).toBeDefined();
    expect(await bridge.vault.get('grant:active')).toBeDefined();
    await bridge.http.close(); await repo.close();
  });
});
