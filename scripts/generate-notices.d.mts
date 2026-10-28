export const projectRoot: string;
export function lockedProductionDependencies(root?: string): Array<{ name: string; version: string; license: string; integrity?: string; path: string }>;
export function generateNotices(root?: string): string;
export function writeNotices(root?: string, check?: boolean): string;
