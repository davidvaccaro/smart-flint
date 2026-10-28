export const MAX_IMAGE_ARCHIVE_BYTES: number;
export const IMAGE_ARCHIVE_ERROR: string;
export interface PreparedImageArchive { path: string; references: string[]; expectedImageIds: string[]; expanded: boolean }
export function prepareImageArchive(path: string, options?: { directory?: string; maxExpandedBytes?: number }): Promise<PreparedImageArchive>;
