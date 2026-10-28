import type { LaunchContext, TokenResponse } from '../../../packages/contracts/src/index.js';
export interface Transaction {
  id: string; installationId: string; redirectUri: string; appState: string;
  appCodeChallenge: string; mode: 'gateway' | 'direct' | 'handoff';
  upstreamState?: string; upstreamVerifier?: string; nonce?: string;
  callbackUri?: string; bindingHash?: string; expiresAt: string;
  smart?: { authorization_endpoint?: string; token_endpoint: string; issuer?: string; jwks_uri?: string; [key: string]: unknown };
  launch?: string;
}
export interface Handoff { id: string; activationId: string; applicationId: string; redirectUri: string; challenge: string; expiresAt: string }
export interface Session { id: string; activationId: string; expiresAt: string }
export interface Grant {
  id: string; activationId: string; installationId: string; expiresAt?: string;
  refreshOwner: 'bridge' | 'application'; scopes: string[]; context: LaunchContext;
  tokenEndpoint: string; updatedAt: string;
}
export interface GrantSecret { current: TokenResponse; original: TokenResponse }
export interface AdminSession { id: string; expiresAt: string }
export interface Continuation { id: string; activationId: string; url: string; resource: string; interaction: 'r' | 's'; expiresAt: string }
