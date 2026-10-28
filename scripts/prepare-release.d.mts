export interface SourceEntry { path: string; data: Buffer; executable: boolean }
export function releaseVersion(root?: string): string;
export function sourceFiles(root?: string): SourceEntry[];
export function sourceArchive(entries: SourceEntry[], prefix: string, epoch?: number): Buffer;
export function dependencySBOM(root: string, version: string, epoch?: number): {
  spdxVersion: string; dataLicense: string; documentNamespace: string; creationInfo: { created: string };
  packages: Array<{ SPDXID: string; name: string; versionInfo: string; licenseDeclared: string; checksums?: Array<{ algorithm: string; checksumValue: string }> }>;
  annotations: Array<{ comment: string }>; [key: string]: unknown;
};
export function prepareRelease(options?: { root?: string; output?: string; sdkDirectory?: string; imageArchive?: string; imageSbom?: string; epoch?: number }): string;
