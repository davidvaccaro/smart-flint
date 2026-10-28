export const sourceRoot: string;
export interface InstallerPlan {
  settings: Record<string, any>;
  ports: { hostIp: string; port: number; protocol: string }[];
  endpoints: Record<string, string>;
  checks: { services: string[] };
  files: { path: string; mode: number; content: string }[];
}
export function parseInstallerArgs(argv: string[]): Record<string, any>;
export function privateFile(path: string, maximum?: number): Promise<string>;
export function createSandboxPlan(options: Record<string, any>): InstallerPlan;
export function savePlan(directory: string, plan?: InstallerPlan): Promise<{ format: string; configured: boolean; plan: InstallerPlan; resolvedImageId?: string }>;
export function verifyImageArchive(path: string, checksumPath?: string): Promise<void>;
export function runInstaller(args: Record<string, any>): Promise<void>;
