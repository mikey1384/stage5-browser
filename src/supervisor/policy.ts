import { type BrowserCommandInput, type BrowserCommandName, type BrowserProduct, type OperationJournal, SUPPORTED_BROWSER_PRODUCTS, type SerializedStage5BrowserError, isLaunchFailureReason } from './dependencies.js';
import type { BrowserSupervisorContext } from './runtime.js';

export const policyOperations = {
  deadlineFor<Name extends BrowserCommandName>(
    command: Name,
    payload: BrowserCommandInput<Name>,
  ): number {
    if (command === 'initialize') {
      return this.config.workerStartupTimeoutMs;
    }
    if ('timeoutMs' in payload && typeof payload.timeoutMs === 'number') {
      return payload.timeoutMs + 2_000;
    }
    return this.config.operationTimeoutMs;
  },

  requiresHardRecovery(code: SerializedStage5BrowserError['code']): boolean {
    return code === 'OPERATION_TIMEOUT' || code === 'WORKER_DISCONNECTED' || code === 'WORKER_START_FAILED';
  },

  captureLastKnownUrl(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      return;
    }
    const candidate = result as {
      lastKnownUrl?: unknown;
      page?: { url?: unknown };
      pages?: Array<{ url?: unknown }>;
    };
    if (typeof candidate.page?.url === 'string') {
      this.lastKnownUrl = candidate.page.url;
      return;
    }
    if (candidate.lastKnownUrl === null || typeof candidate.lastKnownUrl === 'string') {
      this.lastKnownUrl = candidate.lastKnownUrl;
      return;
    }
    const finalPage = candidate.pages?.at(-1);
    if (typeof finalPage?.url === 'string') {
      this.lastKnownUrl = finalPage.url;
    }
  },

  captureSelectedBrowser(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      return;
    }
    const browser = (result as { browser?: unknown }).browser;
    if (typeof browser === 'string' && this.isBrowserProduct(browser)) {
      this.selectedBrowser = browser;
    }
  },

  captureBrowserConnection(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      return;
    }
    const connected = (result as { browserConnected?: unknown }).browserConnected;
    if (typeof connected === 'boolean') {
      this.browserWasConnected = connected;
      return;
    }
    if ('page' in result) {
      this.browserWasConnected = true;
    }
  },

  captureAuthenticationState(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      return;
    }
    const candidate = result as { controlMode?: unknown; state?: unknown };
    if (typeof candidate.controlMode !== 'string' || typeof candidate.state !== 'string') {
      return;
    }
    this.humanAuthenticationInProgress =
      (candidate.controlMode === 'human_bootstrap' || candidate.controlMode === 'private_field') &&
      candidate.state === 'awaiting_user';
  },

  captureActionPolicyState(result: unknown): void {
    if (typeof result !== 'object' || result === null) return;
    const mode = (result as { mode?: unknown }).mode;
    if (mode === 'normal' || mode === 'review_only') this.actionPolicyMode = mode;
  },

  isBrowserProduct(value: string): value is BrowserProduct {
    return (SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(value);
  },

  safeJournalDiagnostic(
    error: SerializedStage5BrowserError,
  ): { diagnosticCause?: import('../diagnostics.js').LaunchFailureReason; browser?: BrowserProduct } {
    const reason = error.details?.reason;
    const browser = error.details?.browser;
    return {
      ...(isLaunchFailureReason(reason) ? { diagnosticCause: reason } : {}),
      ...(typeof browser === 'string' && this.isBrowserProduct(browser) ? { browser } : {}),
    };
  },

  async appendJournal(record: Parameters<OperationJournal['append']>[0]): Promise<void> {
    try {
      await this.operations.persist(record);
    } catch {
      // Diagnostics must never change the terminal outcome of a browser command.
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserSupervisorContext>;

export type PolicyOperations = typeof policyOperations;
