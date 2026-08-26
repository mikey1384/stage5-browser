import { type BrowserCommandInput, type BrowserCommandOutput } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const downloadOperations = {
  async downloads(input: BrowserCommandInput<'downloads'>): Promise<BrowserCommandOutput<'downloads'>> {
    return this.downloadManager.list(input.limit);
  },

  async waitForDownload(
    input: BrowserCommandInput<'waitForDownload'>,
  ): Promise<BrowserCommandOutput<'waitForDownload'>> {
    return this.downloadManager.waitAfter(input.afterSequence, input.timeoutMs);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type DownloadOperations = typeof downloadOperations;
