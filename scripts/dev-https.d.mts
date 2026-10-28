import type { LocalCertificates } from './local-https.mjs';

export const projectRoot: string;
export function validateDevelopmentEnvironment(root: string, environment?: NodeJS.ProcessEnv): Promise<{ sqlitePath: string; extraCAPath?: string }>;
export function prepareNodeCABundle(certificates: LocalCertificates, configuredPath?: string): Promise<string>;
export function startLocalHTTPSDevelopment(): Promise<number>;
