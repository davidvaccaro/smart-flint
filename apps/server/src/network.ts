import { lookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import { Agent, fetch, type Response } from 'undici';
import type { Config } from './config.js';
import { assert, Problem } from './errors.js';

const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(network, prefix, 'ipv6');
export function privateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  return !!isIP(ip) && blocked.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}
export class SafeHttp {
  private agents = new Map<boolean, Agent>();
  constructor(private config: Config) {}
  validate(urlString: string, allowedOrigins: string[], base?: string): URL {
    let url: URL;
    try { url = new URL(urlString); } catch { throw new Problem(400, 'invalid_url', 'A valid absolute URL is required.'); }
    assert(!url.username && !url.password && !url.hash, 400, 'invalid_url', 'URL credentials and fragments are not allowed.');
    const sampleOrigin = new URL(this.config.sampleCdsUrl ?? 'http://127.0.0.1:4101');
    const localSample = this.config.demo && ['127.0.0.1', '[::1]', 'localhost'].includes(sampleOrigin.hostname)
      && url.origin === sampleOrigin.origin && url.pathname === '/hooks/health-review';
    const localDemo = (this.config.demo && url.origin === new URL(this.config.mockEhrUrl).origin) || localSample;
    assert(url.protocol === 'https:' || (localDemo && url.protocol === 'http:'), 400, 'insecure_endpoint', 'Upstream endpoints must use HTTPS. Local synthetic EHR endpoints are allowed in demo mode.');
    assert(allowedOrigins.includes(url.origin), 403, 'endpoint_not_allowed', 'The endpoint origin is not approved for this connection.');
    assert(this.config.allowPrivateNetworks || localDemo || !privateAddress(url.hostname), 403, 'private_endpoint_blocked', 'Private upstream network addresses require an explicit operator configuration.');
    if (base) {
      const target = new URL(base);
      const prefix = target.pathname.replace(/\/$/, '');
      assert(url.origin === target.origin && (url.pathname === prefix || url.pathname.startsWith(prefix + '/')), 403, 'endpoint_not_allowed', 'The URL is outside this FHIR connection.');
    }
    return url;
  }
  async request(urlString: string, allowedOrigins: string[], init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}, base?: string): Promise<Response> {
    const url = this.validate(urlString, allowedOrigins, base);
    const sampleOrigin = new URL(this.config.sampleCdsUrl ?? 'http://127.0.0.1:4101');
    const allowPrivate = this.config.allowPrivateNetworks || (this.config.demo && (url.origin === new URL(this.config.mockEhrUrl).origin || (['127.0.0.1', '[::1]', 'localhost'].includes(sampleOrigin.hostname) && url.origin === sampleOrigin.origin && url.pathname === '/hooks/health-review')));
    let dispatcher = this.agents.get(allowPrivate);
    if (!dispatcher) {
      dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
        lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error, '', 4);
          if (!allowPrivate && addresses.some(a => privateAddress(a.address))) return callback(new Error('Private upstream network address is blocked.'), '', 4);
          if (!addresses.length) return callback(new Error('No upstream address found.'), '', 4);
          if ((options as { all?: boolean }).all) (callback as unknown as (err: Error | null, records: { address: string; family: number }[]) => void)(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        });
      } } });
      this.agents.set(allowPrivate, dispatcher);
    }
    try {
      const response = await fetch(url, { ...init, body: init.body as string | undefined, redirect: 'manual', signal: AbortSignal.timeout(15000), dispatcher });
      assert(response.status === 304 || response.status < 300 || response.status >= 400, 502, 'upstream_redirect_blocked', 'An unexpected upstream redirect was blocked.');
      return response;
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem(502, 'upstream_unavailable', 'The approved upstream endpoint could not be reached.');
    }
  }
  async close() { await Promise.all([...this.agents.values()].map(a => a.close())); }
}
export async function readBody(response: Response, limit = 5 * 1024 * 1024): Promise<Buffer> {
  assert(Number(response.headers.get('content-length') ?? 0) <= limit, 502, 'response_too_large', 'The upstream response exceeds the configured size limit.');
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Problem(502, 'response_too_large', 'The upstream response exceeds the configured size limit.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  try { return JSON.parse((await readBody(response)).toString('utf8')) as T; }
  catch (error) { if (error instanceof Problem) throw error; throw new Problem(502, 'invalid_upstream_response', 'The upstream endpoint returned invalid JSON.'); }
}
