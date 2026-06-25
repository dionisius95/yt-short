/**
 * Disk usage monitoring utility.
 * Full implementation in task 9.x (Project Management).
 */

export interface DiskUsageInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

/**
 * Get disk usage information for the given path.
 * Placeholder — full implementation in the Project Management task.
 */
export async function getDiskUsage(_dirPath: string): Promise<DiskUsageInfo> {
  throw new Error('diskUsage.getDiskUsage not yet implemented');
}

/**
 * Check whether available disk space is below the warning threshold (5 GB).
 */
export async function isBelowWarningThreshold(dirPath: string): Promise<boolean> {
  const { freeBytes } = await getDiskUsage(dirPath);
  const FIVE_GB = 5 * 1024 * 1024 * 1024;
  return freeBytes < FIVE_GB;
}
