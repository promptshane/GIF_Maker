/**
 * Errors surfaced directly to the user. Everything that can fail during import,
 * rendering or export throws one of these so the UI never has to show a raw
 * exception string (or worse, fail silently).
 */
export class MediaError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'MediaError';
    this.hint = hint;
  }
}

export function describeError(error: unknown): { message: string; hint?: string } {
  if (error instanceof MediaError) return { message: error.message, hint: error.hint };
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError' || error.name === 'NotReadableError') {
      return {
        message: 'The browser ran out of room while handling this file.',
        hint: 'Try a shorter clip, fewer photos, or a smaller output size.',
      };
    }
    if (error.name === 'AbortError') return { message: 'Cancelled.' };
    return { message: error.message || error.name };
  }
  if (error instanceof Error) {
    // Out-of-memory in Safari usually arrives as a plain RangeError.
    if (error.name === 'RangeError') {
      return {
        message: 'This is too large for the browser to process.',
        hint: 'Reduce the output size, frame rate, or duration and try again.',
      };
    }
    return { message: error.message };
  }
  return { message: String(error) };
}
