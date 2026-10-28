import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AccessMode, Installation, SmartConfiguration } from '../../../packages/contracts/src/index.js';
import { digest, pkceChallenge, randomId } from '../../../packages/storage/src/index.js';
import { Bridge, later, validUntil } from './bridge.js';
import { assert, Problem } from './errors.js';
import type { Handoff, Session, Transaction } from './models.js';

const querySchema = z.record(z.string(), z.string());
// Retain standard authorization diagnostics without persisting arbitrary
// upstream strings, error descriptions, patient context or launch tokens.
const authorizationErrorCodes = new Set([
  'invalid_request', 'unauthorized_client', 'access_denied', 'unsupported_response_type',
  'invalid_scope', 'server_error', 'temporarily_unavailable',
  // Some EHRs also return this grant-validation error from /authorize.
  'invalid_grant',
  // Epic documents this extension at its authorization endpoint.
  'invalid_launch_token',
]);
const launchSchema = z.object({
  installationId: z.string().min(1), redirectUri: z.string().min(1).max(2048),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), state: z.string().min(24).max(256),
  mode: z.enum(['gateway', 'direct', 'handoff']).optional(), launchTicket: z.string().optional(),
}).strict();
function cookieName(state: string) { return `sb_oauth_${digest(state).slice(0, 16)}`; }
async function putTransaction(bridge: Bridge, transaction: Transaction) {
  await bridge.vault.set(`transaction:${transaction.id}`, transaction);
  await bridge.repo.put('transactions', { id: transaction.id, expiresAt: transaction.expiresAt });
}
async function readTransaction(bridge: Bridge, id: string) {
  const pointer = await bridge.repo.get<{ id: string; expiresAt: string }>('transactions', id);
  assert(pointer && validUntil(pointer.expiresAt), 400, 'launch_expired', 'This launch expired or was already used. Start a new launch.');
  const tx = await bridge.vault.get<Transaction>(`transaction:${id}`);
  assert(tx, 400, 'invalid_transaction', 'The launch transaction is unavailable.');
  return tx;
}
async function consumeTransaction(bridge: Bridge, id: string) {
  const record = await bridge.repo.consume('transactions', id);
  assert(record, 400, 'launch_already_used', 'This launch transaction was already used.');
  await bridge.vault.delete(`transaction:${id}`);
}
function destination(redirectUri: string, parameters: Record<string, string>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.href;
}
export function registerLaunch(app: FastifyInstance, bridge: Bridge) {
  // EHR launches first visit the registered application to establish downstream PKCE/browser binding.
  app.get<{ Params: { installationId: string } }>('/launch/:installationId', async (request, reply) => {
    const query = querySchema.parse(request.query);
    const { installation, application, connection } = await bridge.installation(request.params.installationId);
    try {
      assert(query.iss === connection.fhirBaseUrl, 400, 'issuer_mismatch', 'The launch issuer does not match this approved installation.');
      assert(query.launch && query.launch.length <= 4096, 400, 'launch_handle_missing', 'The EHR launch handle is required.');
    } catch (error) {
      if (error instanceof Problem) await bridge.audit('launch.rejected', `EHR launch rejected (${error.code}).`, { outcome: 'failure', installationId: installation.id, tenantId: installation.tenantId });
      throw error;
    }
    const id = randomId('ehr');
    await putTransaction(bridge, { id, installationId: installation.id, redirectUri: application.callbackUrls[0]!, appState: '', appCodeChallenge: '', mode: installation.mode, launch: query.launch, expiresAt: later(300) });
    await bridge.audit('launch.received', 'EHR launch received; application browser binding is required.', { installationId: installation.id, tenantId: installation.tenantId });
    return reply.redirect(destination(application.callbackUrls[0]!, { smart_flint_launch: id }));
  });

  app.get<{ Params: { ticket: string } }>('/api/launches/bootstrap/:ticket', async request => {
    const tx = await readTransaction(bridge, request.params.ticket);
    assert(tx.launch && !tx.appCodeChallenge, 400, 'invalid_launch_ticket', 'This is not an EHR bootstrap ticket.');
    const { application } = await bridge.installation(tx.installationId);
    return { installationId: tx.installationId, applicationId: application.id, expiresAt: tx.expiresAt };
  });

  app.post('/api/launches', async request => {
    const body = launchSchema.parse(request.body);
    const { installation, application } = await bridge.installation(body.installationId);
    assert(application.callbackUrls.includes(body.redirectUri), 400, 'callback_not_registered', 'This callback is not registered for the application.');
    const callback = new URL(body.redirectUri);
    assert(!callback.hash && !['code', 'state', 'error', 'error_description', 'smart_flint_launch'].some(key => callback.searchParams.has(key)), 400, 'invalid_callback', 'The application callback contains reserved parameters.');
    const mode = body.mode ?? installation.mode;
    assert(application.allowedModes.includes(mode), 403, 'mode_not_allowed', 'This application does not permit that access mode.');
    assert(mode === 'gateway' || installation.allowTokenExport, 403, 'token_export_disabled', 'Direct access requires token export to be enabled for this installation.');
    let launch: string | undefined;
    if (body.launchTicket) {
      const bootstrap = await readTransaction(bridge, body.launchTicket);
      assert(bootstrap.installationId === installation.id && bootstrap.launch && !bootstrap.appCodeChallenge, 400, 'invalid_launch_ticket', 'The EHR ticket belongs to a different installation.');
      await consumeTransaction(bridge, body.launchTicket); launch = bootstrap.launch;
    }
    const tx: Transaction = { id: randomId('launch'), installationId: installation.id, redirectUri: body.redirectUri, appState: body.state, appCodeChallenge: body.codeChallenge, mode, launch, expiresAt: later(300) };
    await putTransaction(bridge, tx);
    return { launchUrl: `${bridge.config.baseUrl}/launch/start/${tx.id}`, expiresAt: tx.expiresAt, applicationId: application.id };
  });

  app.get<{ Params: { ticket: string } }>('/launch/start/:ticket', async (request, reply) => {
    const tx = await readTransaction(bridge, request.params.ticket);
    assert(tx.appCodeChallenge, 400, 'invalid_launch', 'The application launch is not initialized.');
    const { installation, connection, registration } = await bridge.installation(tx.installationId);
    const smart = await bridge.discover(connection, registration);
    assert(smart.authorization_endpoint, 422, 'interactive_launch_unsupported', 'This connection does not advertise interactive authorization.');
    assert(!smart.code_challenge_methods_supported || smart.code_challenge_methods_supported.includes('S256'), 422, 'pkce_unsupported', 'This connection does not support S256 PKCE.');
    const state = randomId('state'), binding = randomId('browser');
    tx.id = digest(state); tx.upstreamState = state; tx.upstreamVerifier = randomBytes(32).toString('base64url');
    tx.nonce = randomId('nonce'); tx.bindingHash = digest(binding);
    tx.callbackUri = `${bridge.config.baseUrl}/oauth/callback/${connection.id}`; tx.smart = smart;
    await consumeTransaction(bridge, request.params.ticket); await putTransaction(bridge, tx);
    reply.setCookie(cookieName(state), binding, { httpOnly: true, secure: bridge.config.secureCookies, sameSite: 'lax', path: '/oauth/callback', maxAge: 300 });
    const authorize = new URL(smart.authorization_endpoint);
    const scopes = [...new Set([...installation.scopes, ...(tx.launch ? ['launch'] : [])])];
    const params: Record<string, string> = { response_type: 'code', client_id: registration.clientId, redirect_uri: tx.callbackUri, aud: connection.fhirBaseUrl, scope: scopes.join(' '), state, nonce: tx.nonce, code_challenge: pkceChallenge(tx.upstreamVerifier), code_challenge_method: 'S256' };
    if (tx.launch) params.launch = tx.launch;
    for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value);
    await bridge.audit('launch.authorizing', 'Authorization started with the configured EHR server.', { installationId: installation.id, tenantId: installation.tenantId });
    return reply.redirect(authorize.href);
  });

  app.get<{ Params: { connectionId: string } }>('/oauth/callback/:connectionId', async (request, reply) => {
    const query = querySchema.parse(request.query);
    assert(query.state, 400, 'missing_state', 'The authorization response is missing state.');
    const tx = await readTransaction(bridge, digest(query.state));
    const { installation, connection, registration } = await bridge.installation(tx.installationId);
    assert(request.params.connectionId === connection.id && tx.upstreamState === query.state, 400, 'issuer_mismatch', 'The authorization response belongs to another connection.');
    assert(tx.bindingHash && request.cookies[cookieName(query.state)] && digest(request.cookies[cookieName(query.state)]!) === tx.bindingHash, 401, 'browser_binding_failed', 'The authorization response does not match this browser transaction. Allow cookies or restart in a supported browser.');
    if (query.iss) assert(query.iss === tx.smart?.issuer, 400, 'issuer_mismatch', 'The authorization server issuer did not match.');
    await consumeTransaction(bridge, tx.id);
    reply.clearCookie(cookieName(query.state), { path: '/oauth/callback' });
    if (query.error) {
      const errorCode = authorizationErrorCodes.has(query.error) ? query.error : 'unrecognized_error';
      const detail = errorCode === 'invalid_grant' && tx.launch
        ? 'The EHR could not redeem the launch token for an authorization code (invalid_grant).'
        : `The EHR authorization did not complete (${errorCode}).`;
      await bridge.audit('launch.denied', detail, { outcome: 'failure', installationId: installation.id, tenantId: installation.tenantId });
      return reply.redirect(destination(tx.redirectUri, { error: ['invalid_launch_token', 'invalid_grant'].includes(errorCode) ? errorCode : 'authorization_denied', state: tx.appState }));
    }
    assert(query.code && tx.smart && tx.callbackUri && tx.upstreamVerifier, 400, 'invalid_authorization_response', 'The authorization response is incomplete.');
    try {
      const token = await bridge.tokenRequest(connection, registration, tx.smart.token_endpoint, new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: tx.callbackUri, code_verifier: tx.upstreamVerifier }));
      const identity = await bridge.identity(token, tx.smart as SmartConfiguration, connection, registration, tx.nonce!);
      const activation = await bridge.establish(installation.id, token, tx.smart.token_endpoint, tx.mode, 'interactive', identity);
      const code = randomId('activation');
      await bridge.repo.put<Handoff>('handoffs', { id: digest(code), activationId: activation.id, applicationId: activation.applicationId, redirectUri: tx.redirectUri, challenge: tx.appCodeChallenge, expiresAt: later(60) });
      return reply.redirect(destination(tx.redirectUri, { code, state: tx.appState }));
    } catch (error) {
      const code = error instanceof Problem ? error.code : 'launch_failed';
      await bridge.audit('launch.failed', `Authorization could not complete (${code}).`, { outcome: 'failure', installationId: installation.id, tenantId: installation.tenantId });
      return reply.redirect(destination(tx.redirectUri, { error: code, state: tx.appState }));
    }
  });

  app.post('/api/activations/redeem', async request => {
    const body = z.object({ code: z.string().min(1), codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), applicationId: z.string(), redirectUri: z.string() }).strict().parse(request.body);
    const handoff = await bridge.repo.get<Handoff>('handoffs', digest(body.code));
    assert(handoff && validUntil(handoff.expiresAt), 400, 'activation_code_invalid', 'The activation code expired or was already used.');
    assert(handoff.applicationId === body.applicationId && handoff.redirectUri === body.redirectUri && handoff.challenge === pkceChallenge(body.codeVerifier), 401, 'activation_binding_failed', 'The activation code does not match this application transaction.');
    const activation = await bridge.activation(handoff.activationId);
    assert(activation.status === 'ready', 401, 'activation_inactive', 'This activation is no longer ready.');
    await bridge.installation(activation.installationId);
    assert(await bridge.repo.consume('handoffs', handoff.id), 400, 'activation_code_used', 'The activation code was already used.');
    const sessionToken = randomId('session');
    await bridge.repo.put<Session>('sessions', { id: digest(sessionToken), activationId: handoff.activationId, expiresAt: later(8 * 3600) });
    return { activation: await bridge.descriptor(handoff.activationId), sessionToken };
  });
}
