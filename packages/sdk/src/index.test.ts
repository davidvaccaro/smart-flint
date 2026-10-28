import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SMARTFlintClient, SMARTFlintError, createPKCE } from './index.js';
import type { ActivationDescriptor } from '@smart-flint/contracts';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function memoryStorage() {
  const records = new Map<string, string>();
  return { records, getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
}
const activation = {
  id: 'activation-a', mode: 'gateway', upstream: { baseUrl: 'https://ehr.example/fhir', fhirVersion: '4.0.1' },
  gateway: { baseUrl: 'https://bridge.example/fhir/activation-a' },
} as ActivationDescriptor;

describe('SMART Flint SDK', () => {
  it('creates cryptographically bound S256 transactions', async () => {
    const first = await createPKCE();
    const second = await createPKCE();
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(first.codeChallenge).toBe(createHash('sha256').update(first.codeVerifier).digest('base64url'));
    expect(first.state).not.toBe(second.state);
  });

  it('binds redemption to the original browser transaction and consumes it once', async () => {
    const storage = memoryStorage();
    let sentState = '';
    let sentChallenge = '';
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/api/launches')) {
        const body = JSON.parse(String(init?.body)); sentState = body.state; sentChallenge = body.codeChallenge;
        return response({ launchUrl: 'https://bridge.example/launch', expiresAt: new Date(Date.now() + 60000).toISOString(), applicationId: 'app-a' });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.applicationId).toBe('app-a');
      expect(body.redirectUri).toBe('https://app.example/callback');
      expect(createHash('sha256').update(body.codeVerifier).digest('base64url')).toBe(sentChallenge);
      return response({ activation, sessionToken: 'private-session' });
    });
    const client = new SMARTFlintClient({ baseUrl: 'https://bridge.example', storage, fetch: fetcher as typeof fetch });
    await client.start({ installationId: 'install-a', redirectUri: 'https://app.example/callback' });
    expect(JSON.stringify([...storage.records])).not.toContain('private-session');
    await expect(client.completeRedirect(`https://app.example/callback?code=one-use&state=wrong`)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const session = await client.completeRedirect(`https://app.example/callback?code=one-use&state=${sentState}`);
    expect(session.sessionToken).toBe('private-session');
    expect(storage.records.size).toBe(0);
    await expect(client.completeRedirect(`https://app.example/callback?code=one-use&state=${sentState}`)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a callback at a different destination without consuming valid state', async () => {
    const storage = memoryStorage();
    storage.setItem('smart-flint:launch:known', JSON.stringify({ codeVerifier: 'verifier', applicationId: 'app-a', redirectUri: 'https://app.example/callback', expiresAt: new Date(Date.now() + 60000).toISOString() }));
    const fetcher = vi.fn();
    const client = new SMARTFlintClient({ baseUrl: 'https://bridge.example', storage, fetch: fetcher });
    await expect(client.completeRedirect('https://attacker.example/callback?code=code&state=known')).rejects.toMatchObject({ code: 'callback_mismatch' });
    expect(storage.records.size).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_launch_token', 'The EHR rejected the launch token. Start a fresh launch from the EHR. If this repeats, ask the integration administrator to check the client ID and EHR environment.'],
    ['invalid_grant', 'The EHR could not validate the authorization grant (invalid_grant). Start a fresh launch from the EHR. If the same test user keeps failing, ask the integration administrator to check the launch and test-user configuration.'],
    ['authorization_denied', 'Authorization did not complete. Start a new launch to try again.'],
    ['unknown_error', 'Authorization did not complete. Start a new launch to try again.'],
  ])('handles %s with a fixed message and consumes state without redeeming a code', async (error, message) => {
    const storage = memoryStorage();
    storage.setItem('smart-flint:launch:known', JSON.stringify({ codeVerifier: 'verifier', applicationId: 'app-a', redirectUri: 'https://app.example/callback', expiresAt: new Date(Date.now() + 60000).toISOString() }));
    const fetcher = vi.fn();
    const client = new SMARTFlintClient({ baseUrl: 'https://bridge.example', storage, fetch: fetcher });
    const callback = new URL('https://app.example/callback');
    callback.searchParams.set('state', 'known');
    callback.searchParams.set('error', error);
    callback.searchParams.set('error_description', 'private-upstream-description-canary');
    await expect(client.completeRedirect(callback.href)).rejects.toMatchObject({ code: error, message });
    expect(storage.records.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.completeRedirect(callback.href)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps credentials scoped to their activation and supports any HTTP/FHIR client', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer session-a');
      if (String(input).endsWith('/credentials')) return response({ baseUrl: activation.upstream.baseUrl, accessToken: 'original-upstream-token', tokenType: 'Bearer', grantedScopes: [], refreshOwner: 'bridge' });
      return response(activation);
    });
    const client = new SMARTFlintClient({ baseUrl: 'https://bridge.example', fetch: fetcher as typeof fetch });
    const session = client.session('activation-a', 'session-a');
    const gateway = await session.getFHIRConnection();
    expect(gateway.baseUrl).toBe(activation.gateway.baseUrl);
    expect(await gateway.credentials.getAccessToken()).toBe('session-a');
    const direct = await session.getFHIRConnection({ route: 'direct' });
    expect(direct.baseUrl).toBe(activation.upstream.baseUrl);
    expect(await direct.credentials.getAccessToken()).toBe('original-upstream-token');
    expect(await direct.credentials.getAuthorizationHeader()).toBe('Bearer original-upstream-token');
    expect(JSON.stringify(session)).not.toContain('session-a');
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('/activation-a'))).toBe(true);
  });

  it('supports externally owned native/server PKCE with no browser storage', async () => {
    const fetcher = vi.fn(async () => response({ launchUrl: 'https://bridge.example/launch', applicationId: 'app-a', expiresAt: '2030-01-01T00:00:00Z' }));
    const client = new SMARTFlintClient({ baseUrl: 'https://bridge.example', fetch: fetcher as typeof fetch });
    await client.start({ installationId: 'install-a', redirectUri: 'https://app.example/callback', codeChallenge: 'challenge', state: 'state' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('creates a new app-bound PKCE transaction before resuming an EHR launch ticket', async () => {
    const storage = memoryStorage();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/bootstrap/')) return response({ installationId: 'install-a', applicationId: 'app-a', expiresAt: new Date(Date.now() + 60000).toISOString() });
      const body = JSON.parse(String(init?.body));
      expect(body.launchTicket).toBe('opaque-ticket');
      expect(body.redirectUri).toBe('https://app.example/callback');
      expect(body.codeChallenge).toHaveLength(43);
      expect(body.state.length).toBeGreaterThanOrEqual(24);
      return response({ launchUrl: 'https://bridge.example/launch/start', applicationId: 'app-a', expiresAt: new Date(Date.now() + 60000).toISOString() });
    });
    const client = new SMARTFlintClient({ baseUrl: 'https://bridge.example', storage, fetch: fetcher as typeof fetch });
    await client.resumeEHRLaunch('https://app.example/callback?smart_flint_launch=opaque-ticket');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(storage.records.size).toBe(1);
    expect(JSON.stringify([...storage.records])).not.toContain('opaque-ticket');
  });

  it('rejects insecure remote services and uses structured errors without response dumps', async () => {
    expect(() => new SMARTFlintClient({ baseUrl: 'http://remote.example' })).toThrow(SMARTFlintError);
    const client = new SMARTFlintClient({ baseUrl: 'http://localhost:3001', fetch: vi.fn(async () => response({ code: 'export_disabled', message: 'This installation keeps upstream tokens server-side.' }, 403)) as typeof fetch });
    await expect(client.session('activation-a', 'secret').credentials.current()).rejects.toMatchObject({ code: 'export_disabled', status: 403 });
  });
});
