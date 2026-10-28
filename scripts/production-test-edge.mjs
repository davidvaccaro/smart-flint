// Isolated acceptance-test fixture, not a deployment reverse proxy.
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
const port = Number(process.env.TEST_TLS_PORT);
const server = https.createServer({ key: readFileSync('/fixture/key.pem'), cert: readFileSync('/fixture/cert.pem'), minVersion: 'TLSv1.2' }, (incoming, outgoing) => {
  const hostname = incoming.headers.host?.split(':')[0];
  const target = hostname === 'flint.production.test' ? 'flint' : hostname === 'identity.production.test' ? 'keycloak' : undefined;
  if (!target || !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) return outgoing.writeHead(400).end();
  const upstream = http.request({ hostname: target, port: target === 'flint' ? 3001 : 8080, method: incoming.method, path: incoming.url,
    headers: { ...incoming.headers, 'x-forwarded-host': incoming.headers.host, 'x-forwarded-proto': 'https', 'x-forwarded-port': String(port) } }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
  });
  upstream.setTimeout(30_000, () => upstream.destroy());
  upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.on('aborted', () => upstream.destroy()); incoming.pipe(upstream);
});
server.listen(port, '0.0.0.0');
process.once('SIGTERM', () => server.close(() => process.exit(0)));
