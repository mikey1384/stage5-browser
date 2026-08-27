import {
  type Browser,
  type BrowserCommandOutput,
  type BrowserContext,
  inspectProfileShutdown,
  isStage5HandoffMarkerUrl,
  nativeControlEndpoint,
  type NativeControlRecord,
  type Page,
  playwrightBrowserType,
  type ProfileStorageInspection,
  readNativeControlRecord,
  restoreNativeHumanBrowserSession,
  stage5HandoffMarkerUrl,
  Stage5BrowserError,
  writeNativeControlRecord,
} from '../dependencies.js';
import { boundedValue, type PendingHandoffRelease, remainingHandoffWorkBudget } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export interface NativeHandoffConnection {
  browser: Browser;
  context: BrowserContext;
  record: NativeControlRecord;
  targetPage: Page;
  temporary: boolean;
}

export const nativeHandoffReleaseOperations = {
  async continueNativeSameProcessHandoff(
    pending: PendingHandoffRelease,
    deadlineAt: number,
  ): Promise<BrowserCommandOutput<'requestLoginHandoff'> | null> {
    if (!(await this.exactOwnedProcessStillRunning(pending.controlledBrowserProcess))) {
      pending.releaseStrategy = 'process_relaunch';
      return null;
    }

    const connection = await this.prepareNativeHandoffConnection(pending, deadlineAt);
    let beforeStorage: ProfileStorageInspection;
    let beforeProfileShutdown: Awaited<ReturnType<typeof inspectProfileShutdown>>;
    try {
      [beforeStorage, beforeProfileShutdown] = await Promise.all([
        this.controlledProfileStorageInspector(
          pending.launchIdentity.profile,
          pending.launchIdentity.engine,
          pending.targetOrigin,
          (urls) => connection.context.cookies(urls).then((cookies) => cookies.map((cookie) => ({
            domain: cookie.domain,
            name: cookie.name,
            expires: cookie.expires,
          }))),
        ),
        inspectProfileShutdown(
          pending.profileDir,
          this.selectedBrowser,
          pending.launchIdentity.profile.profileDirectory,
        ),
      ]);
      await this.prepareNativeHandoffMarker(connection, pending, deadlineAt);
    } catch (error) {
      if (connection.temporary) await connection.browser.close().catch(() => undefined);
      throw error;
    }

    const nativeBrowser = connection.browser;
    if (!connection.temporary && this.nativeAttachedBrowser === nativeBrowser) {
      this.clearControlledBrowserState();
    }
    const detached = await boundedValue(
      nativeBrowser.close().then(() => true),
      Math.max(1, remainingHandoffWorkBudget(deadlineAt)),
      false,
    );
    if (!detached || nativeBrowser.isConnected()) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_REQUIRED',
        'Stage5 could not release its native control connection without changing the browser process.',
        {
          recoverable: true,
          details: {
            reason: 'native_control_detach_pending',
            releaseStrategy: pending.releaseStrategy,
            phase: 'close_requested',
            closeRequestCompleted: false,
            ownershipRetained: true,
            suggestedAction: 'Leave the exact dedicated browser open and call browser_request_login_handoff once more. Do not close it, delete locks, switch backends, or repeat the private step.',
          },
        },
      );
    }
    pending.closeRequestCompleted = true;
    if (!(await this.exactOwnedProcessStillRunning(pending.controlledBrowserProcess))) {
      pending.releaseStrategy = 'process_relaunch';
      return null;
    }

    const awaitingRecord = { ...connection.record, state: 'awaiting_user' as const };
    await writeNativeControlRecord(pending.profileDir, awaitingRecord);
    const session = restoreNativeHumanBrowserSession(awaitingRecord, pending.launchIdentity);
    return this.completeHumanHandoff(
      pending,
      session,
      beforeStorage,
      beforeProfileShutdown,
    );
  },

  async prepareNativeHandoffConnection(
    pending: PendingHandoffRelease,
    deadlineAt: number,
  ): Promise<NativeHandoffConnection> {
    const record = await readNativeControlRecord(pending.profileDir, this.selectedBrowser);
    if (
      record === null
      || record.processId !== pending.controlledBrowserProcess.processId
      || (record.state !== 'controlled' && record.state !== 'awaiting_user')
    ) {
      throw this.nativeHandoffUnavailable(pending, 'native_control_identity_mismatch');
    }
    const owner = await this.profileOwnerInspector(pending.profileDir, pending.launchIdentity);
    const provenRecord = owner.reconnectRecord ?? owner.handoffRecord;
    const transitionMarkerObserved = owner.evidence.ownership === 'proven'
      && owner.evidence.applicationIdentity === 'matched'
      && owner.evidence.loopbackControl === 'available'
      && owner.evidence.authenticationHandoff === 'present';
    if (
      !transitionMarkerObserved
      && (
        provenRecord === null
        || provenRecord.processId !== record.processId
        || provenRecord.port !== record.port
      )
    ) {
      throw this.nativeHandoffUnavailable(pending, 'native_control_endpoint_unverified');
    }

    const existingBrowser = this.nativeAttachedBrowser;
    const existingContext = this.usableContext();
    const temporary = existingBrowser === undefined || existingContext === undefined;
    const browser = temporary
      ? await playwrightBrowserType('chromium').connectOverCDP(
          nativeControlEndpoint(record),
          {
            artifactsDir: this.config.artifactsDir,
            isLocal: true,
            noDefaults: true,
            timeout: Math.max(1, remainingHandoffWorkBudget(deadlineAt)),
          },
        )
      : existingBrowser;
    const context = temporary ? browser.contexts()[0] : existingContext;
    if (context === undefined) {
      if (temporary) await browser.close().catch(() => undefined);
      throw this.nativeHandoffUnavailable(pending, 'native_context_unavailable');
    }

    const pages = context.pages().filter((page) => !page.isClosed());
    let targetPage: Page | undefined;
    if (record.selectedTargetId !== undefined && record.selectedTargetId !== null) {
      const targetIds = await Promise.all(pages.map((page) => this.chromiumTargetId(page)));
      targetPage = pages.find((_page, index) => targetIds[index] === record.selectedTargetId);
    } else if (!temporary) {
      const preferred = this.preferredPage();
      targetPage = preferred !== undefined && pages.includes(preferred) ? preferred : undefined;
    } else if (pages.length === 1) {
      targetPage = pages[0];
    }
    if (targetPage === undefined) {
      if (temporary) await browser.close().catch(() => undefined);
      throw this.nativeHandoffUnavailable(pending, 'selected_page_unavailable');
    }
    return { browser, context, record, targetPage, temporary };
  },

  async prepareNativeHandoffMarker(
    connection: NativeHandoffConnection,
    pending: PendingHandoffRelease,
    deadlineAt: number,
  ): Promise<void> {
    const markerPresent = connection.context.pages().some((page) => (
      !page.isClosed() && isStage5HandoffMarkerUrl(page.url())
    ));
    if (!markerPresent) {
      const marker = await connection.context.newPage();
      await marker.goto(stage5HandoffMarkerUrl(pending.handoffLabel), {
        waitUntil: 'commit',
        timeout: Math.max(1, remainingHandoffWorkBudget(deadlineAt)),
      });
    }
    await connection.targetPage.bringToFront();
    const [selectedTargetId, selectedDocumentId] = await Promise.all([
      this.chromiumTargetId(connection.targetPage),
      this.chromiumDocumentId(connection.targetPage),
    ]);
    if (selectedTargetId === null) {
      throw this.nativeHandoffUnavailable(pending, 'selected_page_identity_unavailable');
    }
    const { retainedAction, ...record } = connection.record;
    connection.record = {
      ...record,
      selectedTargetId,
      ...(selectedDocumentId === null ? {} : { selectedDocumentId }),
      ...(retainedAction !== undefined
        && retainedAction.selectedTargetId === selectedTargetId
        && retainedAction.documentId === selectedDocumentId
        ? { retainedAction }
        : {}),
    };
  },

  nativeHandoffUnavailable(
    pending: PendingHandoffRelease,
    reason: string,
  ): Stage5BrowserError {
    return new Stage5BrowserError(
      'AUTH_HANDOFF_REQUIRED',
      'Stage5 could not prove the exact same-process native handoff boundary.',
      {
        recoverable: true,
        details: {
          reason,
          releaseStrategy: pending.releaseStrategy,
          phase: 'close_requested',
          closeRequestCompleted: pending.closeRequestCompleted,
          ownershipRetained: true,
          suggestedAction: 'Leave the exact dedicated browser and profile untouched. Call browser_auth_status once and report its sanitized ownership state; do not retry private input, switch backends, close the browser, or delete locks.',
        },
      },
    );
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type NativeHandoffReleaseOperations = typeof nativeHandoffReleaseOperations;
