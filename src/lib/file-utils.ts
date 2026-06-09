export function generateRecordingFilename(mimeType: string): string {
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `recording-${stamp}.${ext}`;
}

export const canStreamToDisk: boolean =
  typeof window !== 'undefined' && 'showSaveFilePicker' in window;

/**
 * Race writable.close() against a timeout so a hung close (OS file lock,
 * antivirus scan, browser deadlock) cannot freeze the recorder UI forever.
 * On timeout, throws -- caller surfaces an error and the partial file
 * remains on disk for manual recovery.
 *
 * The timeout is cleared as soon as close() settles (win or lose) so we do
 * not leak a dangling timer slot on every successful recording.
 */
export function closeWithTimeout(
  writable: FileSystemWritableFileStream,
  ms: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`writable.close() timed out after ${ms}ms`)),
      ms,
    );
  });
  const closePromise = writable.close().finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
  return Promise.race([closePromise, timeoutPromise]);
}
