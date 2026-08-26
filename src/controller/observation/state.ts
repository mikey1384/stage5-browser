import { access, type ElementHandle, type Frame, type NavigationWarning, type RedirectHop, type Request, type Response, sanitizeUrlForJournal } from '../dependencies.js';
import { boundedValue } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const observationStateOperations = {
  consumeObservedSnapshot(
    frame: Frame,
    retainedHandle: ElementHandle<HTMLElement> | null = null,
  ): void {
    const observed = this.observedSnapshots.get(frame);
    this.observedSnapshots.delete(frame);
    if (observed === undefined) {
      return;
    }
    if (observed.scopeHandle !== retainedHandle) {
      void observed.scopeHandle.dispose().catch(() => undefined);
    }
    for (const { handle } of observed.textEditors.values()) {
      if (handle !== retainedHandle) {
        void handle.dispose().catch(() => undefined);
      }
    }
    for (const { handle } of observed.fileInputs.values()) {
      if (handle !== retainedHandle) {
        void handle.dispose().catch(() => undefined);
      }
    }
    for (const { handle } of observed.scrollContainers.values()) {
      if (handle !== retainedHandle) {
        void handle.dispose().catch(() => undefined);
      }
    }
  },

  discardObservedSnapshot(frame: Frame): void {
    this.consumeObservedSnapshot(frame);
    this.discardFormInspectionsForFrame(frame);
  },

  discardAllObservedSnapshots(): void {
    for (const frame of this.observedSnapshots.keys()) {
      this.discardObservedSnapshot(frame);
    }
  },

  documentVersion(frame: Frame): number {
    const current = this.frameDocumentVersions.get(frame);
    if (current !== undefined) {
      return current;
    }
    this.frameDocumentVersions.set(frame, 0);
    return 0;
  },

  safeObservedUrl(value: string): string {
    return sanitizeUrlForJournal(value) ?? '<unavailable>';
  },

  httpWarnings(status: number | null): NavigationWarning[] {
    if (status === null || status < 400) {
      return [];
    }
    if (status === 401) {
      return [{
        code: 'http_authentication_required',
        message: 'The navigation response requires authentication (HTTP 401).',
        status,
        suggestedAction: 'Inspect the page, then use the login handoff if authentication is required.',
      }];
    }
    if (status === 403) {
      return [{
        code: 'http_forbidden',
        message: 'The navigation response was forbidden (HTTP 403).',
        status,
        suggestedAction: 'Do not retry blindly. Inspect the page for an access or bot-protection challenge.',
      }];
    }
    if (status === 429) {
      return [{
        code: 'http_rate_limited',
        message: 'The navigation response was rate limited (HTTP 429).',
        status,
        suggestedAction: 'Pause requests and honor any visible retry guidance; do not immediately repeat the request.',
      }];
    }
    if (status >= 500) {
      return [{
        code: 'http_server_error',
        message: `The navigation response returned a server error (HTTP ${status}).`,
        status,
        suggestedAction: 'Inspect the committed response before deciding whether a later bounded retry is appropriate.',
      }];
    }
    return [{
      code: 'http_client_error',
      message: `The navigation response returned a client error (HTTP ${status}).`,
      status,
      suggestedAction: 'Inspect the response and correct the target or authentication state before retrying.',
    }];
  },

  async redirectChain(response: Response | null): Promise<RedirectHop[]> {
    if (response === null) {
      return [];
    }

    const requests: Request[] = [];
    let request: Request | null = response.request();
    while (request !== null) {
      requests.unshift(request);
      request = request.redirectedFrom();
    }

    const hops: RedirectHop[] = [];
    for (let index = 0; index < requests.length - 1; index += 1) {
      const from = requests[index];
      const to = requests[index + 1];
      if (from === undefined || to === undefined) {
        continue;
      }
      const redirectResponse = await boundedValue(from.response(), 1_000, null);
      hops.push({
        kind: 'server',
        from: this.safeObservedUrl(from.url()),
        to: this.safeObservedUrl(to.url()),
        status: redirectResponse?.status() ?? null,
      });
    }
    return hops;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationStateOperations = typeof observationStateOperations;
