import { describe, expect, it } from 'vitest';
import { buildApp } from '../apps/server/src/app.js';

describe('separate development console and HTTPS launch origins', () => {
  for (const consoleProtocol of ['http', 'https'] as const) {
    it(`keeps the ${consoleProtocol.toUpperCase()} console session usable with an HTTPS launch endpoint`, async () => {
      const consoleUrl = `${consoleProtocol}://127.0.0.1:3010`;
      const { app, config } = await buildApp({ config: { demo: true, sqlitePath: ':memory:', databaseUrl: undefined, encryptionKey: Buffer.alloc(32, 21).toString('base64'), baseUrl: 'https://127.0.0.1:3443', consoleUrl }, serveConsole: false });
      try {
        expect(config.secureCookies).toBe(true);
        const login = await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin: consoleUrl }, payload: {} });
        expect(login.statusCode).toBe(200);
        const setCookie = String(login.headers['set-cookie']);
        expect(/;\s*Secure(?:;|$)/i.test(setCookie)).toBe(consoleProtocol === 'https');
        const cookie = login.cookies.map(value => `${value.name}=${value.value}`).join('; ');
        const dashboard = await app.inject({ url: '/api/admin/dashboard', headers: { cookie } });
        expect(dashboard.statusCode).toBe(200);
        expect(dashboard.json().runtime.baseUrl).toBe('https://127.0.0.1:3443');
        expect((await app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin: 'http://127.0.0.1:4100' }, payload: {} })).statusCode).toBe(403);
        const logout = await app.inject({ method: 'DELETE', url: '/api/admin/session', headers: { origin: consoleUrl, cookie } });
        expect(logout.statusCode).toBe(200);
        expect(/;\s*Secure(?:;|$)/i.test(String(logout.headers['set-cookie']))).toBe(consoleProtocol === 'https');
        expect((await app.inject({ url: '/api/admin/dashboard', headers: { cookie } })).statusCode).toBe(401);
      } finally { await app.close(); }
    });
  }
});
