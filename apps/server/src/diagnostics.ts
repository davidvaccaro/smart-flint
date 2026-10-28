import type { FastifyInstance } from 'fastify';
import { authenticateAdmin, allowedAdminOrigin } from './admin-auth.js';
import type { Bridge } from './bridge.js';
import { assert } from './errors.js';

type Diagnostic = { event: string; [key: string]: string | number | boolean | undefined };
export interface OperationsOptions { write?: (record: Diagnostic) => void; readinessTimeoutMs?: number }

/** Only values constructed here enter operational logs. Never serialize a request, URL, error or payload. */
export function registerOperations(app: FastifyInstance, bridge: Bridge, options: OperationsOptions = {}) {
  const enabled = bridge.config.operationsLogging ?? !bridge.config.demo;
  const write = options.write ?? (record => process.stdout.write(`${JSON.stringify(record)}\n`));
  const emit = (record: Diagnostic) => { if (enabled) { try { write(record); } catch { /* Logging must not fail a clinical request. */ } } };
  const started = Date.now();
  const counters = { requests: 0, clientErrors: 0, serverErrors: 0, readinessFailures: 0, maintenanceRuns: 0, maintenanceFailures: 0 };
  let lastMaintenanceAt: string | undefined;
  let lastMaintenanceSucceeded: boolean | undefined;
  let checking: Promise<boolean> | undefined;

  app.addHook('onResponse', async (request, reply) => {
    counters.requests++;
    if (reply.statusCode >= 500) counters.serverErrors++;
    else if (reply.statusCode >= 400) counters.clientErrors++;
    // Framework route templates contain no actual patient/resource IDs or query strings.
    emit({ event: 'http.completed', requestId: request.id, method: request.method,
      route: request.routeOptions.url ?? 'unmatched', status: reply.statusCode, durationMs: Math.round(reply.elapsedTime) });
  });
  app.addHook('onSend', async (request, reply) => { reply.header('X-Request-Id', request.id); });

  const ready = async () => {
    if (checking) return checking;
    checking = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          bridge.vault.get<{ privateJwk?: unknown }>('bridge-signing'),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('readiness_timeout')), options.readinessTimeoutMs ?? 2500); timeout.unref(); }),
        ]);
        return !!value;
      } catch { return false; }
      finally { if (timeout) clearTimeout(timeout); }
    })();
    try { return await checking; } finally { checking = undefined; }
  };

  app.get('/ready', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (_request, reply) => {
    if (!await ready()) {
      counters.readinessFailures++;
      emit({ event: 'readiness.failed' });
      return reply.code(503).send({ status: 'not_ready' });
    }
    return { status: 'ready' };
  });

  // Kept outside scoped configuration routes: only a deployment-wide owner may see process telemetry.
  app.get('/api/admin/operations', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    allowedAdminOrigin(bridge, request, false);
    const principal = await authenticateAdmin(bridge, request);
    assert(principal, 401, 'authentication_required', 'An administrative session is required.');
    assert(principal.identity.role === 'platform_admin', 403, 'platform_admin_required', 'Platform administration is required.');
    return { scope: 'process', uptimeSeconds: Math.floor((Date.now() - started) / 1000), counters: { ...counters },
      maintenance: { lastRunAt: lastMaintenanceAt, lastSucceeded: lastMaintenanceSucceeded } };
  });

  return { maintenance(succeeded: boolean) {
    counters.maintenanceRuns++;
    if (!succeeded) counters.maintenanceFailures++;
    lastMaintenanceAt = new Date().toISOString(); lastMaintenanceSucceeded = succeeded;
    emit({ event: succeeded ? 'maintenance.completed' : 'maintenance.failed' });
  } };
}
