import { Bridge } from './bridge.js';
import type { Activation } from '../../../packages/contracts/src/index.js';

/** Expired protocol material is retired; clinical activation context has a bounded lifetime. */
export async function retireExpiredRecords(bridge: Bridge, at = Date.now()) {
  await bridge.repo.withLock('maintenance:retention', async () => {
    for (const collection of ['transactions', 'sessions', 'handoffs', 'continuations', 'replays']) {
      for (const row of await bridge.repo.list<{ id: string; expiresAt: string }>(collection)) {
        if (Date.parse(row.expiresAt) > at) continue;
        await bridge.repo.delete(collection, row.id);
        if (collection === 'transactions') await bridge.vault.delete(`transaction:${row.id}`);
      }
    }
    const summaries = await bridge.repo.list<{ id: string; createdAt: string; status: Activation['status'] }>('activations');
    for (const row of summaries) {
      const age = at - Date.parse(row.createdAt);
      if (age > 8 * 3600_000 && row.status !== 'closed') await bridge.closeActivation(row.id);
      if (age > bridge.config.retentionHours * 3600_000) {
        await bridge.vault.delete(`activation:${row.id}`);
        await bridge.repo.delete('activations', row.id);
      }
    }
    for (const event of await bridge.repo.list<{ id: string; at: string }>('events')) if (Date.parse(event.at) < at - 30 * 86400_000) await bridge.repo.delete('events', event.id);
  });
}
