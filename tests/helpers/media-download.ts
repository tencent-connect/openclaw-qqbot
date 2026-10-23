interface DownloadOptions { url: string; originalFilename?: string }
export const downloadFixture: { handler?: (opts: DownloadOptions) => Promise<{ path: string }> } = {};

/** Offline download adapter, optionally controlled by a test to vary completion order. */
export async function downloadRemoteMedia(opts: DownloadOptions) {
  if (!opts.url.startsWith('https://example.com/')) throw new Error('Unexpected test URL');
  if (downloadFixture.handler) return downloadFixture.handler(opts);
  return { path: `/tmp/qqbot-regression/${opts.originalFilename}` };
}
