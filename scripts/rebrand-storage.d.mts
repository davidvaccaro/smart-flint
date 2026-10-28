export interface MigrationOptions {
  offline?: boolean;
  root?: string;
  sourcePath?: string;
  targetPath?: string;
  keyPath?: string;
  backupDirectory?: string;
}
export interface MigrationResult {
  status: 'migrated' | 'already_migrated';
  targetPath: string;
  backupPath?: string;
  counts?: Record<string, number>;
  verifiedSecrets?: number;
}
export function migrateStorage(options?: MigrationOptions): Promise<MigrationResult>;
