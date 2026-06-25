/**
 * ffprobe utility — video metadata extraction.
 * Full implementation in task 2.x (Downloader).
 */

export interface VideoMetadata {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number;
}

/**
 * Extract metadata from a video file using ffprobe.
 * Placeholder — full implementation in the Downloader task.
 */
export async function getVideoMetadata(_filePath: string): Promise<VideoMetadata> {
  throw new Error('ffprobe.getVideoMetadata not yet implemented');
}
