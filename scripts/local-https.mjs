import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const localHost = '127.0.0.1';

async function exists(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Local certificate paths must be regular files.');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function openssl(args) {
  try { await execute('openssl', args, { timeout: 30_000, maxBuffer: 1_048_576, windowsHide: true }); }
  catch { throw new Error('Local certificate generation failed. Check that OpenSSL is installed and the certificate directory is writable.'); }
}

async function privateFile(path) {
  const handle = await open(path, 'wx', 0o600);
  await handle.close();
}

function keyMatches(certificate, privateKey) {
  return certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(
    createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' }),
  );
}

/** Project-owned files only. This never installs software or changes an OS/browser trust store. */
export async function setupLocalCertificates(dir) {
  const directory = resolve(dir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('The local HTTPS directory must be a real directory.');
  await chmod(directory, 0o700);
  const paths = {
    directory, caCertPath: join(directory, 'ca.pem'), caKeyPath: join(directory, 'ca-key.pem'),
    certPath: join(directory, 'server.pem'), keyPath: join(directory, 'server-key.pem'),
  };
  const lockPath = join(directory, '.setup.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Another local certificate setup is running. If it stopped unexpectedly, remove .data/https/.setup.lock and retry.');
    throw error;
  }
  const created = [];
  const csrPath = join(directory, 'server.csr');
  const extensionPath = join(directory, 'server-extensions.cnf');
  try {
    const present = await Promise.all([paths.caCertPath, paths.caKeyPath, paths.certPath, paths.keyPath].map(exists));
    if (present.some(Boolean) && !present.every(Boolean)) throw new Error('Local certificate files are incomplete. Restore the complete .data/https set or remove it before creating a new development CA.');
    if (present.every(Boolean)) {
      for (const path of [paths.caCertPath, paths.caKeyPath, paths.certPath, paths.keyPath]) await chmod(path, 0o600);
      const [caPEM, caKey, leafPEM, leafKey] = await Promise.all([paths.caCertPath, paths.caKeyPath, paths.certPath, paths.keyPath].map(path => readFile(path)));
      const ca = new X509Certificate(caPEM);
      const leaf = new X509Certificate(leafPEM);
      if (!ca.ca || leaf.ca || !keyMatches(ca, caKey) || !keyMatches(leaf, leafKey) || !leaf.verify(ca.publicKey)
        || !leaf.checkIP(localHost) || !leaf.checkHost('localhost')) throw new Error('Existing local HTTPS certificates do not match the required development CA, key and loopback names.');
      if (Date.parse(ca.validFrom) > Date.now() || Date.parse(leaf.validFrom) > Date.now()
        || Date.parse(ca.validTo) <= Date.now() || Date.parse(leaf.validTo) <= Date.now()) {
        throw new Error('A local HTTPS certificate has expired. Recreate the project development certificates and review browser trust before continuing.');
      }
      return paths;
    }
    for (const path of [paths.caKeyPath, paths.caCertPath, paths.keyPath, paths.certPath, csrPath, extensionPath]) {
      await privateFile(path); created.push(path);
    }
    await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '3650',
      '-subj', '/CN=SMART Flint Local Development CA', '-keyout', paths.caKeyPath, '-out', paths.caCertPath,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    await openssl(['req', '-new', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', '/CN=localhost',
      '-keyout', paths.keyPath, '-out', csrPath]);
    await writeFile(extensionPath, [
      '[server_cert]', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1', '',
    ].join('\n'), { mode: 0o600 });
    await openssl(['x509', '-req', '-sha256', '-days', '365', '-in', csrPath, '-CA', paths.caCertPath,
      '-CAkey', paths.caKeyPath, '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-out', paths.certPath,
      '-extfile', extensionPath, '-extensions', 'server_cert']);
    for (const path of [paths.caCertPath, paths.caKeyPath, paths.certPath, paths.keyPath]) await chmod(path, 0o600);
    return paths;
  } catch (error) {
    await Promise.all(created.map(path => rm(path, { force: true })));
    throw error;
  } finally {
    await Promise.all([csrPath, extensionPath].map(path => rm(path, { force: true })));
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardedHeaders(headers) {
  const blocked = new Set(hopHeaders);
  for (const value of String(headers.connection ?? '').split(',')) blocked.add(value.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key)
    && key !== 'forwarded' && !key.startsWith('x-forwarded-') && key !== 'x-real-ip'));
}

/** Loopback TLS termination for the existing HTTP API. It is not a general-purpose forward proxy. */
export async function createLocalHTTPSProxy(options) {
  const host = options.host ?? localHost;
  const port = options.port ?? 3443;
  if (host !== localHost) throw new Error('The local HTTPS proxy must bind only to 127.0.0.1.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('The local HTTPS port is invalid.');
  const target = new URL(options.targetOrigin ?? 'http://127.0.0.1:3001');
  if (target.protocol !== 'http:' || target.hostname !== localHost || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash) throw new Error('The local HTTPS target must be a fixed HTTP origin on 127.0.0.1.');
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
  for (const value of [requestTimeoutMs, maxRequestBytes, maxResponseBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Local HTTPS limits must be positive integers.');
  }
  const [key, cert] = await Promise.all([readFile(options.keyPath), readFile(options.certPath)]);
  const sockets = new Set();
  const server = https.createServer({ key, cert, minVersion: 'TLSv1.2', requestTimeout: requestTimeoutMs, headersTimeout: Math.min(requestTimeoutMs, 15_000) }, (incoming, outgoing) => {
    let upstream;
    let upstreamResponse;
    let finished = false;
    let timeout;
    const finish = () => { finished = true; clearTimeout(timeout); };
    const fail = (status) => {
      if (finished) return;
      finish();
      incoming.unpipe(); incoming.resume();
      upstream?.destroy(); upstreamResponse?.destroy();
      if (outgoing.headersSent) return outgoing.destroy();
      const message = status === 413 ? 'The local HTTPS request exceeds its size limit.'
        : status === 504 ? 'The local HTTPS upstream request timed out.' : 'The local HTTPS upstream request could not be completed.';
      outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
      outgoing.end(JSON.stringify({ code: 'local_https_request_failed', message }));
    };
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.includes('\\')) return fail(400);
    if (Number(incoming.headers['content-length'] ?? 0) > maxRequestBytes) return fail(413);
    timeout = setTimeout(() => fail(504), requestTimeoutMs);
    let requestBytes = 0;
    const requestLimiter = new Transform({ transform(chunk, _encoding, callback) {
      requestBytes += chunk.length;
      callback(requestBytes > maxRequestBytes ? new Error('request_limit') : null, requestBytes > maxRequestBytes ? undefined : chunk);
    } });
    requestLimiter.on('error', () => fail(413));
    upstream = http.request({ hostname: target.hostname, port: target.port || 80, method: incoming.method,
      path: incoming.url, headers: forwardedHeaders(incoming.headers) }, response => {
      upstreamResponse = response;
      if (finished) return response.destroy();
      if (Number(response.headers['content-length'] ?? 0) > maxResponseBytes) return fail(502);
      outgoing.writeHead(response.statusCode ?? 502, forwardedHeaders(response.headers));
      let responseBytes = 0;
      const responseLimiter = new Transform({ transform(chunk, _encoding, callback) {
        responseBytes += chunk.length;
        callback(responseBytes > maxResponseBytes ? new Error('response_limit') : null, responseBytes > maxResponseBytes ? undefined : chunk);
      } });
      responseLimiter.on('error', () => fail(502));
      response.on('error', () => fail(502));
      response.pipe(responseLimiter).pipe(outgoing);
    });
    upstream.on('error', () => fail(502));
    incoming.on('aborted', () => { finish(); upstream.destroy(); upstreamResponse?.destroy(); });
    incoming.on('error', () => fail(502));
    outgoing.on('finish', finish);
    outgoing.on('close', () => { finish(); upstream.destroy(); upstreamResponse?.destroy(); });
    incoming.pipe(requestLimiter).pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise((resolveListen, rejectListen) => {
    const onError = error => rejectListen(error);
    server.once('error', onError);
    server.listen({ host, port }, () => { server.off('error', onError); resolveListen(); });
  });
  const address = server.address();
  let closing;
  return {
    server, origin: `https://${localHost}:${address.port}`,
    close() {
      closing ??= new Promise((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
