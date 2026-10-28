import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../apps/server/src/app.js';

const runtimes: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.app.close(); vi.restoreAllMocks(); });
async function setup() {
  const logs: unknown[] = [];
  const runtime = await buildApp({ seed: false, serveConsole: false,
    config: { demo: true, adminAuthMode: undefined, databaseUrl: undefined, sqlitePath: ':memory:',
      encryptionKey: randomBytes(32).toString('base64'), adminToken: 'synthetic-operations-owner', operationsLogging: true,
      baseUrl: 'http://127.0.0.1:3001', consoleUrl: 'http://127.0.0.1:3010' },
    operations: { write: record => logs.push(record), readinessTimeoutMs: 25 } });
  runtimes.push(runtime); return { ...runtime, logs };
}

it('separates liveness from database/key readiness and returns no dependency error details', async () => {
  const { app, bridge } = await setup();
  expect((await app.inject('/health')).statusCode).toBe(200);
  expect((await app.inject('/ready')).json()).toEqual({ status: 'ready' });
  const get = vi.spyOn(bridge.vault, 'get').mockRejectedValue(new Error('postgresql://user:private-password@private-db sensitive-token'));
  const unavailable = await app.inject('/ready');
  expect(unavailable.statusCode).toBe(503); expect(unavailable.json()).toEqual({ status: 'not_ready' });
  expect((await app.inject('/health')).statusCode).toBe(200);
  get.mockImplementation(() => new Promise(() => {}));
  expect((await app.inject('/ready')).statusCode).toBe(503);
});

it('logs only route templates and generated correlation IDs without headers, resource IDs, bodies, query strings or thrown messages', async () => {
  const { app, logs } = await setup();
  app.post<{ Params: { id: string } }>('/private-fixture/:id', async () => { throw new Error('private-error-canary'); });
  const response = await app.inject({ method: 'POST', url: '/private-fixture/private-patient-canary?token=private-query-canary',
    headers: { authorization: 'Bearer private-authorization-canary', 'x-request-id': 'private-header-canary', 'content-type': 'application/json' },
    payload: { secret: 'private-body-canary' } });
  expect(response.statusCode).toBe(500);
  expect(response.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/);
  const serialized = JSON.stringify(logs);
  expect(serialized).not.toMatch(/private-(patient|query|authorization|header|body|error)-canary/);
  expect(logs).toContainEqual(expect.objectContaining({ event: 'http.completed', route: '/private-fixture/:id', status: 500 }));
});

it('restricts aggregate operational counters to platform administrators', async () => {
  const { app, config } = await setup();
  expect((await app.inject('/api/admin/operations')).statusCode).toBe(401);
  const owner = await app.inject({ url: '/api/admin/operations', headers: { authorization: `Bearer ${config.adminToken}` } });
  expect(owner.statusCode).toBe(200); expect(owner.json()).toMatchObject({ scope: 'process', counters: { clientErrors: 1 } });
  expect(owner.body).not.toContain(config.encryptionKey); expect(owner.body).not.toContain(config.adminToken);
});
