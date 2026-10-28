import { afterEach, expect, it } from 'vitest';
import http from 'node:http';
import { sandboxPorts, sandboxEdge, startSandbox } from '../scripts/sandbox-runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('refuses accidental host execution before opening data or public listeners', async () => {
  await expect(startSandbox({})).rejects.toThrow('Docker sandbox launcher');
});

it('validates distinct unprivileged sandbox ports and keeps configurable host/server origins aligned', () => {
  expect(sandboxPorts({})).toEqual({ console: 3010, mock: 4010, patient: 4100, cds: 4101, fhir: 4102 });
  expect(sandboxPorts({ SMART_FLINT_SANDBOX_PORT: '53110', SMART_FLINT_MOCK_PORT: '54110' }).console).toBe(53110);
  for (const value of ['0', '80', '65536', 'nan', '3010/evil', '3e3', '']) expect(() => sandboxPorts({ SMART_FLINT_SANDBOX_PORT: value })).toThrow();
  expect(() => sandboxPorts({ SMART_FLINT_SANDBOX_PORT: '4010' })).toThrow();
});

it('uses a fixed upstream, preserves browser Host/Origin and strips hop/forwarding headers', async () => {
  let received: http.IncomingHttpHeaders | undefined;
  const upstream = http.createServer((request, response) => { received = request.headers; response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fixture=value; HttpOnly' }); response.end(JSON.stringify({ path: request.url })); });
  await new Promise<void>(yes => upstream.listen(0, '127.0.0.1', yes));
  cleanups.push(() => new Promise<void>(yes => upstream.close(() => yes())));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  const probe = http.createServer(); await new Promise<void>(yes => probe.listen(0, '127.0.0.1', yes));
  const edgeAddress = probe.address(); if (!edgeAddress || typeof edgeAddress === 'string') throw new Error('Missing probe');
  await new Promise<void>(yes => probe.close(() => yes()));
  cleanups.push(await sandboxEdge(edgeAddress.port, address.port));
  const response = await fetch(`http://127.0.0.1:${edgeAddress.port}/fixture?code=synthetic`, { headers: { Origin: `http://127.0.0.1:${edgeAddress.port}`, 'X-Forwarded-For': 'untrusted', 'Proxy-Authorization': 'synthetic' } });
  expect(await response.json()).toEqual({ path: '/fixture?code=synthetic' });
  expect(received?.host).toBe(`127.0.0.1:${edgeAddress.port}`); expect(received?.origin).toBe(`http://127.0.0.1:${edgeAddress.port}`);
  expect(received?.['x-forwarded-for']).toBeUndefined(); expect(received?.['proxy-authorization']).toBeUndefined();
});
