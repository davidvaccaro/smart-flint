import type { Server } from 'node:https';

export interface LocalCertificates {
  directory: string;
  caCertPath: string;
  caKeyPath: string;
  certPath: string;
  keyPath: string;
}
export interface LocalHTTPSProxyOptions {
  certPath: string;
  keyPath: string;
  host?: string;
  port?: number;
  targetOrigin?: string;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}
export function setupLocalCertificates(dir: string): Promise<LocalCertificates>;
export function createLocalHTTPSProxy(options: LocalHTTPSProxyOptions): Promise<{
  server: Server;
  origin: string;
  close(): Promise<void>;
}>;
