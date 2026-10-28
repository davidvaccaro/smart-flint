/** Compiled local sandbox only. Public container edges forward to private loopback listeners. */
import Fastify, { type FastifyInstance } from 'fastify';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../apps/server/src/app.js';
import { buildMockEHR } from '../apps/mock-ehr/src/app.js';
import { buildHealthCDS } from '../samples/cds-service/src/app.js';
import { buildHealthFHIRService } from '../samples/fhir-service/src/app.js';

export const sandboxPortDefaults = { console: 3010, mock: 4010, patient: 4100, cds: 4101, fhir: 4102 } as const;
export const sandboxPortVariables = {
  console: 'SMART_FLINT_SANDBOX_PORT', mock: 'SMART_FLINT_MOCK_PORT', patient: 'SMART_FLINT_PATIENT_PORT',
  cds: 'SMART_FLINT_CDS_PORT', fhir: 'SMART_FLINT_FHIR_PORT',
} as const;
export function sandboxPorts(env: Record<string, string | undefined> = process.env): Record<keyof typeof sandboxPortDefaults, number> {
  const ports = Object.fromEntries(Object.entries(sandboxPortDefaults).map(([key, fallback]) => {
    const raw = env[sandboxPortVariables[key as keyof typeof sandboxPortDefaults]];
    const port = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Sandbox ports must be distinct integers from 1024 through 65535.');
    return [key, port];
  })) as Record<keyof typeof sandboxPortDefaults, number>;
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('Sandbox ports must be distinct integers from 1024 through 65535.');
  return ports;
}

const forwardedHeaders = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
  const result: http.OutgoingHttpHeaders = { ...headers };
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...(headers.connection?.split(',').map(value => value.trim().toLowerCase()) ?? [])]) delete result[name];
  delete result['x-forwarded-for']; delete result['x-forwarded-host']; delete result['x-forwarded-proto'];
  return result;
};

/** Fixed routing only: never resolve a target from request headers, paths or query parameters. */
export async function sandboxEdge(port: number, targetPort: number | (() => number | undefined)) {
  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (incoming, outgoing) => {
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.includes('\\') || Number(incoming.headers['content-length'] ?? 0) > 1_048_576) {
      outgoing.writeHead(400, { 'Cache-Control': 'no-store' }).end(); return;
    }
    const target = typeof targetPort === 'function' ? targetPort() : targetPort;
    if (!target) { outgoing.writeHead(503, { 'Cache-Control': 'no-store' }).end(); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: target, method: incoming.method, path: incoming.url, headers: forwardedHeaders(incoming.headers) }, response => {
      outgoing.writeHead(response.statusCode ?? 502, forwardedHeaders(response.headers)); response.pipe(outgoing);
      response.on('error', () => outgoing.destroy());
    });
    let bytes = 0;
    incoming.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_048_576) { upstream.destroy(); outgoing.destroy(); } });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502, { 'Cache-Control': 'no-store' }); outgoing.end(); });
    incoming.on('aborted', () => upstream.destroy()); incoming.on('error', () => upstream.destroy()); incoming.pipe(upstream);
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, '0.0.0.0', () => { server.removeListener('error', no); yes(); }); });
  return async () => { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); };
}

async function patientApp(baseUrl: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  const directory = resolve('samples/patient-app/dist');
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff'); });
  app.get('/health', async () => ({ status: 'ok', service: 'health-compass-patient' }));
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const filename = request.params['*'];
    if (!/^[A-Za-z0-9._-]+\.(?:js|css|svg|woff2?)$/.test(filename)) return reply.code(404).send();
    try {
      const bytes = await readFile(join(directory, 'assets', filename));
      if (filename.endsWith('.js')) return reply.type('application/javascript').send(bytes.toString('utf8').replaceAll('__SMART_FLINT_RUNTIME_URL__', baseUrl));
      return reply.type(filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2').send(bytes);
    } catch { return reply.code(404).send(); }
  });
  app.get('/*', async (_request, reply) => reply.type('text/html').send(await readFile(join(directory, 'index.html'))));
  return app;
}

export async function startSandbox(env = process.env) {
  // Do not infer container status from /.dockerenv: some Docker engines omit it.
  // The dedicated image installs this immutable marker; source/installer hosts do not.
  if (env.SMART_FLINT_CONTAINER_SANDBOX !== 'true' || !existsSync('/opt/smart-flint-sandbox/image-marker')) {
    throw new Error('The Docker sandbox launcher must run inside its dedicated container.');
  }
  if (env.DATABASE_URL) throw new Error('The local sandbox does not accept an external database.');
  const ports = sandboxPorts(env);
  const origin = (port: number) => `http://127.0.0.1:${port}`;
  const baseUrl = origin(ports.console), mockUrl = origin(ports.mock), patientUrl = origin(ports.patient);
  Object.assign(process.env, { NODE_ENV: 'development', DEMO_MODE: 'true', HOST: '127.0.0.1',
    BASE_URL: baseUrl, CONSOLE_URL: baseUrl, MOCK_EHR_URL: mockUrl, SAMPLE_PATIENT_URL: patientUrl,
    SAMPLE_CDS_URL: origin(ports.cds), SAMPLE_FHIR_URL: origin(ports.fhir), SMART_FLINT_URL: baseUrl,
    SQLITE_PATH: '/app/.data/smart-flint.sqlite' });
  delete process.env.ADMIN_AUTH_MODE; delete process.env.ADMIN_OIDC_ISSUER; delete process.env.ADMIN_OIDC_CLIENT_ID;
  const closers: (() => Promise<void>)[] = [];
  const privatePorts = new Map<number, number>();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { for (const close of closers.reverse()) { try { await close(); } catch {} } })();
  const listen = async (app: FastifyInstance, edge: number) => {
    await app.listen({ port: 0, host: '127.0.0.1' }); closers.push(() => app.close());
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('Sandbox listener unavailable.');
    privatePorts.set(edge, address.port);
  };
  try {
    // Reserve every published port before requesting private ephemeral ports.
    // This avoids a random internal listener taking a later configured public port.
    for (const port of Object.values(ports)) closers.push(await sandboxEdge(port, () => privatePorts.get(port)));
    const fhirBaseUrls = [['epic', 'northstar'], ['epic', 'harbor'], ['oracle', 'lakeside'], ['meditech', 'cedar']].map(([vendor, tenant]) => `${mockUrl}/${vendor}/${tenant}/r4`);
    await listen(await buildMockEHR({ baseUrl: mockUrl, bridgeBaseUrl: baseUrl, consoleUrl: baseUrl }), ports.mock);
    await listen(await buildHealthCDS({ config: { production: false, host: '127.0.0.1', fhirBaseUrls } }), ports.cds);
    await listen(await buildHealthFHIRService({ config: { production: false, host: '127.0.0.1', bridgeUrl: baseUrl, fhirBaseUrls } }), ports.fhir);
    await listen(await patientApp(baseUrl), ports.patient);
    const runtime = await buildApp({ config: { demo: true, host: '127.0.0.1', baseUrl, consoleUrl: baseUrl, mockEhrUrl: mockUrl,
      samplePatientUrl: patientUrl, sampleCdsUrl: origin(ports.cds), sampleFhirUrl: origin(ports.fhir), operationsLogging: false } });
    await listen(runtime.app, ports.console);
    process.stdout.write('SMART Flint local sandbox is ready. Synthetic fixtures only.\n');
    return { stop, ports };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const runtime = await startSandbox();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void runtime.stop().then(() => process.exit(0)); });
  } catch { process.stderr.write('The local sandbox could not start. Check isolated storage and configured ports.\n'); process.exit(1); }
}
