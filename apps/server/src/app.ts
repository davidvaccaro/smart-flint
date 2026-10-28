import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { openRepository, type Repository } from '../../../packages/storage/src/index.js';
import type { Application } from '../../../packages/contracts/src/index.js';
import { loadConfig, projectRoot, type Config } from './config.js';
import { Bridge, publicJWK } from './bridge.js';
import { Problem } from './errors.js';
import { registerAdmin } from './admin.js';
import { seedDemo } from './seed.js';
import { seedSamples } from './sample-seed.js';
import { registerLaunch } from './launch.js';
import { registerAccess } from './access.js';
import { registerCDS } from './cds.js';
import { retireExpiredRecords } from './retention.js';
import { migrateRegistry } from './registry.js';
import { registerOperations, type OperationsOptions } from './diagnostics.js';
import { serviceVersion } from './version.js';

export interface BuildOptions { config?: Partial<Config>; repository?: Repository; seed?: boolean; serveConsole?: boolean; operations?: OperationsOptions }
export async function buildApp(options: BuildOptions = {}) {
  const config = loadConfig(options.config);
  const repo = options.repository ?? await openRepository({ databaseUrl: config.databaseUrl, sqlitePath: config.sqlitePath });
  const bridge = new Bridge(repo, config);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false, requestTimeout: 30000,
    genReqId: () => randomUUID(), requestIdHeader: false });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", config.baseUrl, ...(config.demo ? [config.mockEhrUrl] : [])],
      imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"], formAction: ["'self'"],
    } },
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(rateLimit, { max: config.demo ? 1000 : 300, timeWindow: '1 minute' });
  await app.register(cors, {
    credentials: true,
    origin: async (origin: string | undefined) => {
      if (!origin || origin === 'null') return false;
      if ([new URL(config.consoleUrl).origin, new URL(config.baseUrl).origin].includes(origin)) return true;
      const applications = await repo.list<Application>('applications');
      return applications.some(application => application.callbackUrls.some(callback => new URL(callback).origin === origin));
    },
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'If-None-Match'], exposedHeaders: ['ETag', 'Retry-After', 'X-SMART-Flint-Normalization', 'X-Request-Id'],
  });
  app.addHook('onSend', async (request, reply) => {
    if (!request.url.startsWith('/assets/')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Problem) return reply.code(error.status).send({ code: error.code, message: error.message, requestId: request.id });
    if (error instanceof ZodError) return reply.code(400).send({ code: 'invalid_request', message: error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '), requestId: request.id });
    const reportedStatus = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500;
    const status = reportedStatus >= 400 && reportedStatus < 500 ? reportedStatus : 500;
    return reply.code(status).send({ code: status === 500 ? 'internal_error' : 'request_rejected', message: status === 500 ? 'The request could not be completed.' : 'The request was rejected.', requestId: request.id });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'SMART Flint', version: serviceVersion, storage: repo.kind, demo: config.demo }));
  const operations = registerOperations(app, bridge, options.operations);
  app.get('/.well-known/jwks.json', async () => ({ keys: [publicJWK(await bridge.signingKey())] }));
  await bridge.signingKey();
  if (options.seed !== false) { await seedDemo(bridge); await seedSamples(bridge); }
  await migrateRegistry(repo);
  registerAdmin(app, bridge);
  registerLaunch(app, bridge);
  registerAccess(app, bridge);
  await registerCDS(app, bridge);
  // OpenAPI is built from the public transport contract; SDKs are optional.
  const { registerOpenApi } = await import('./openapi.js');
  registerOpenApi(app, bridge);
  await retireExpiredRecords(bridge);
  let maintaining = false;
  const maintenance = setInterval(() => {
    if (maintaining) return;
    maintaining = true;
    void retireExpiredRecords(bridge).then(() => operations.maintenance(true), () => operations.maintenance(false)).finally(() => { maintaining = false; });
  }, 60000);
  maintenance.unref();
  const consoleDirectory = join(projectRoot, 'apps/console/dist');
  if (options.serveConsole !== false && existsSync(join(consoleDirectory, 'index.html'))) {
    await app.register(staticFiles, { root: consoleDirectory, prefix: '/', wildcard: false, index: false });
    for (const route of ['/', '/platforms', '/organizations', '/connections', '/applications', '/installations', '/activations', '/developer', '/settings', '/reference-app']) app.get(route, async (_request, reply) => reply.sendFile('index.html'));
  } else app.get('/', async () => ({ service: 'SMART Flint', console: config.consoleUrl, openapi: `${config.baseUrl}/api/openapi.json` }));
  app.addHook('onClose', async () => { clearInterval(maintenance); await bridge.http.close(); if (!options.repository) await repo.close(); });
  return { app, bridge, config };
}
