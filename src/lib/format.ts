/** Formats a byte count the way the export screen shows it, e.g. "8.73 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Compact size used inside estimate ranges. */
export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "1.5s" for short clips, "1:04.2" once past a minute. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s';
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/** Timeline timestamps, e.g. "0:03.42". */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

export const uid = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
