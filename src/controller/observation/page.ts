import { type Browser, type BrowserCommandInput, type BrowserCommandOutput, chmod, type ElementHandle, type Frame, inspectTargetState, type Locator, MAX_SCROLL_CONTAINERS_PER_SNAPSHOT, mkdir, type NavigationWarning, observeScrollContainers, path, randomUUID, type Response, Stage5BrowserError, validateNavigationUrl, withScrollContainerSemanticDetails } from '../dependencies.js';
import { boundedValue, MAX_FILE_INPUTS_PER_SNAPSHOT, MAX_POPUP_RENDERED_STATE_CANDIDATES, type ObservedReferenceSemantic, POPUP_OPTION_ROLES, POPUP_RENDERED_STATE_ROLES, POPUP_SURFACE_ROLES, remainingUntil, SCREENSHOT_RENDER_SETTLE_MS } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { discardOmittedSnapshotCapabilities, selectSnapshotView } from './snapshot-view.js';

export const observationPageOperations = {
  async open(input: BrowserCommandInput<'open'>): Promise<BrowserCommandOutput<'open'>> {
    const context = await this.ensureContext();
    const page = input.newTab ? await context.newPage() : await this.ensureActivePage(context);
    this.activePage = page;
    const stateRisk = input.newTab
      ? null
      : this.pageStateRiskManager.preflightNavigation(
        page,
        input.acknowledgeStateRisk ?? false,
        'navigation',
      );
    await this.persistNativePageStateRisk(page);
    if (
      this.authenticationHandoff?.state === 'awaiting_user' &&
      !this.authenticationHandoff.session.state().running &&
      this.authenticationHandoff.profileShutdown?.state === 'unclean'
    ) {
      this.authenticationHandoff = null;
    }

    if (this.authenticationHandoff !== null) {
      this.authenticationHandoff.page = page;
    }

    const targetUrl = validateNavigationUrl(input.url);
    const requestedUrl = this.safeObservedUrl(targetUrl);
    const observedUrls: string[] = [];
    const recordObservedUrl = (value: string): void => {
      const sanitized = this.safeObservedUrl(value);
      if (observedUrls.at(-1) !== sanitized) {
        observedUrls.push(sanitized);
      }
    };
    recordObservedUrl(targetUrl);
    const onFrameNavigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) {
        recordObservedUrl(frame.url());
      }
    };
    page.on('framenavigated', onFrameNavigated);
    const startedAt = Date.now();
    let response: Response | null;
    try {
      response = await page.goto(targetUrl, {
        waitUntil: 'commit',
        timeout: input.timeoutMs,
      });
    } catch (error) {
      page.off('framenavigated', onFrameNavigated);
      throw error;
    }

    this.lastKnownUrl = page.url();
    let readiness: 'commit' | 'domcontentloaded' = 'commit';
    const warnings: NavigationWarning[] = [];
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(250, input.timeoutMs - elapsed);

    try {
      await page.waitForLoadState('domcontentloaded', {
        timeout: Math.min(this.config.readinessTimeoutMs, remaining),
      });
      readiness = 'domcontentloaded';
    } catch {
      warnings.push({
        code: 'dom_readiness_timeout',
        message: 'Navigation committed, but DOM readiness did not arrive before the bounded readiness deadline.',
        status: response?.status() ?? null,
        suggestedAction: 'Inspect the committed page before deciding whether another navigation is necessary.',
      });
    }

    const requestedStabilizationMs = input.stabilizationMs ?? 750;
    const stabilizationMs = Math.min(
      requestedStabilizationMs,
      Math.max(0, input.timeoutMs - (Date.now() - startedAt)),
    );
    if (stabilizationMs > 0) {
      await page.waitForTimeout(stabilizationMs);
    }
    if (warnings.some((warning) => warning.code === 'dom_readiness_timeout')) {
      const reconciledReadyState = await boundedValue(
        page.evaluate(() => document.readyState),
        Math.min(250, Math.max(1, input.timeoutMs - (Date.now() - startedAt))),
        'loading',
      );
      if (reconciledReadyState === 'interactive' || reconciledReadyState === 'complete') {
        readiness = 'domcontentloaded';
        const staleWarningIndex = warnings.findIndex((warning) => warning.code === 'dom_readiness_timeout');
        if (staleWarningIndex >= 0) warnings.splice(staleWarningIndex, 1);
      }
    }
    page.off('framenavigated', onFrameNavigated);
    recordObservedUrl(page.url());
    this.lastKnownUrl = page.url();
    if (this.authenticationHandoff !== null) {
      this.authenticationHandoff.targetOrigin = this.urlOrigin(page.url());
    }

    const responseStatus = response?.status() ?? null;
    warnings.push(...this.httpWarnings(responseStatus));
    const redirectChain = await this.redirectChain(response);
    const finalUrl = this.safeObservedUrl(page.url());
    await this.persistNativeSelectedPage(page);

    return {
      page: await this.pageSummary(page),
      stateRisk,
      requestedUrl,
      finalUrl,
      responseStatus,
      readiness,
      redirected: redirectChain.length > 0 || finalUrl !== requestedUrl,
      redirectChain,
      observedUrls,
      stabilizationMs,
      warnings,
    };
  },

  async snapshot(input: BrowserCommandInput<'snapshot'>): Promise<BrowserCommandOutput<'snapshot'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const documentVersion = this.documentVersion(frame);
    const deadlineAt = Date.now() + input.timeoutMs;
    const root = await this.snapshotRoot(frame);
    const rawSnapshot = await root.locator.ariaSnapshot({
      mode: 'ai',
      depth: input.depth,
      boxes: input.boxes,
      timeout: Math.max(1, remainingUntil(deadlineAt)),
    });
    const baseSnapshot = await this.filterInactivePopupSnapshot(frame, rawSnapshot, deadlineAt);
    const baseRefs = new Set(
      baseSnapshot.match(/\[ref=([^\]]+)\]/g)?.map((value) => value.slice(5, -1)) ?? [],
    );
    let scopeHandle: ElementHandle<HTMLElement> | null = null;
    let observedTextEditors: Awaited<ReturnType<BrowserControllerContext['observeTextEditors']>> | null = null;
    let observedFileInputs: Awaited<ReturnType<BrowserControllerContext['observeFileInputs']>> | null = null;
    let observedScrollContainers: Awaited<ReturnType<typeof observeScrollContainers>> | null = null;
    let retained = false;
    try {
      scopeHandle = await boundedValue(
        root.locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (scopeHandle === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The semantic snapshot scope could not be retained.', {
          recoverable: true,
          details: {
            reason: 'snapshot_scope_handle_unavailable',
            suggestedAction: 'Wait for the current page or modal to stabilize, then take one fresh snapshot.',
          },
        });
      }
      observedTextEditors = await this.observeTextEditors(root.locator, baseRefs, deadlineAt);
      observedFileInputs = await this.observeFileInputs(root.locator);
      observedScrollContainers = await observeScrollContainers(root.locator);
      const completeSnapshot = await withScrollContainerSemanticDetails({
        frame,
        snapshot: baseSnapshot,
        containers: observedScrollContainers.containers,
        requestedDepth: input.depth,
        boxes: input.boxes,
        deadlineAt,
        filterInactivePopupSnapshot: (detail) =>
          this.filterInactivePopupSnapshot(frame, detail, deadlineAt),
      });
      const viewed = selectSnapshotView(completeSnapshot, input.view);
      const { snapshot } = viewed;
      const refs = new Set(
        snapshot.match(/\[ref=([^\]]+)\]/g)?.map((value) => value.slice(5, -1)) ?? [],
      );
      await discardOmittedSnapshotCapabilities(observedTextEditors.editors, refs);
      if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
        throw new Stage5BrowserError(
          'TARGET_NOT_FOUND',
          'The document changed while the semantic snapshot was being captured.',
          {
            recoverable: true,
            details: {
              reason: 'document_changed_during_snapshot',
              suggestedAction: 'Wait for the current page to stabilize, then take one fresh snapshot.',
            },
          },
        );
      }
      const snapshotId = randomUUID();
      this.discardObservedSnapshot(frame);
      this.observedSnapshots.set(frame, {
        id: snapshotId,
        documentVersion,
        scope: root.scope,
        scopeHandle,
        refs,
        refSemantics: this.snapshotReferenceSemantics(snapshot, refs),
        textEditors: observedTextEditors.editors,
        fileInputs: observedFileInputs.inputs,
        scrollContainers: observedScrollContainers.containers,
      });
      retained = true;

      this.lastKnownUrl = page.url();
      if (
        this.authenticationHandoff?.state === 'ready_for_agent_verification' &&
        this.authenticationHandoff.page === page
      ) {
        this.authenticationHandoff = null;
      }
      return {
        page: await this.pageSummary(page),
        frame: this.frameSummary(frame, page),
        snapshotId,
        refCount: refs.size,
        fileInputCount: observedFileInputs.inputs.size,
        fileInputs: [...observedFileInputs.inputs.values()].map(({ observation }) => observation),
        scrollContainerCount: observedScrollContainers.containers.size,
        scrollContainers: [...observedScrollContainers.containers.values()].map(({ observation }) => observation),
        scope: root.scope,
        visibleModalCount: root.visibleModalCount,
        warnings: [
          ...root.warnings,
          ...(observedFileInputs.truncated
            ? [{
                code: 'file_input_list_truncated' as const,
                message: `The frame contains more than ${MAX_FILE_INPUTS_PER_SNAPSHOT} file inputs; only the first bounded set was observed.`,
                suggestedAction: 'Narrow to the intended frame or page state before selecting a file input; Stage5 Browser will not guess among unobserved controls.',
              }]
            : []),
          ...(observedScrollContainers.truncated
            ? [{
                code: 'scroll_container_list_truncated' as const,
                message: `The snapshot scope contains more than ${MAX_SCROLL_CONTAINERS_PER_SNAPSHOT} vertical scroll surfaces; only the first bounded set was observed.`,
                suggestedAction: 'Narrow to the intended modal or frame before scrolling; Stage5 Browser will not guess among unobserved containers.',
              }]
            : []),
        ],
        ...viewed,
      };
    } finally {
      if (!retained) {
        await scopeHandle?.dispose().catch(() => undefined);
        for (const { handle } of observedTextEditors?.editors.values() ?? []) {
          await handle.dispose().catch(() => undefined);
        }
        for (const { handle } of observedFileInputs?.inputs.values() ?? []) {
          await handle.dispose().catch(() => undefined);
        }
        for (const { handle } of observedScrollContainers?.containers.values() ?? []) {
          await handle.dispose().catch(() => undefined);
        }
      }
    }
  },

  async screenshot(input: BrowserCommandInput<'screenshot'>): Promise<BrowserCommandOutput<'screenshot'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const pageActivation = await this.activateSelectedPageForInput(page, 1);
    if (!this.pageIsActivatedForInput(pageActivation)) {
      throw new Stage5BrowserError(
        'OPERATION_FAILED',
        'The controller-selected page could not become visible before screenshot capture.',
        {
          recoverable: true,
          details: {
            reason: 'capture_page_not_active',
            pageActivation,
            suggestedAction: 'Call browser_tabs, explicitly select the intended tab, then capture once more.',
          },
        },
      );
    }
    const screenshotDir = path.join(this.config.artifactsDir, 'screenshots');
    await mkdir(screenshotDir, { recursive: true, mode: 0o700 });
    const screenshotPath = path.join(
      screenshotDir,
      `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.png`,
    );
    let data = await page.screenshot({
      path: screenshotPath,
      type: 'png',
      fullPage: input.fullPage,
      timeout: input.timeoutMs,
    });
    const semanticContentPresent = await boundedValue(
      page.locator('body').evaluate((body) => {
        const text = body instanceof HTMLElement ? body.innerText.trim() : body.textContent?.trim() ?? '';
        return text.length > 0 || body.querySelector('canvas, img, svg, video') !== null;
      }),
      500,
      false,
    );
    let artifactClassification = this.screenshotArtifactClassification(data);
    let retryUsed = false;
    if (artifactClassification === 'possibly_uniform' && semanticContentPresent) {
      retryUsed = true;
      await page.waitForTimeout(SCREENSHOT_RENDER_SETTLE_MS);
      data = await page.screenshot({
        path: screenshotPath,
        type: 'png',
        fullPage: input.fullPage,
        timeout: input.timeoutMs,
      });
      artifactClassification = this.screenshotArtifactClassification(data);
    }
    await chmod(screenshotPath, 0o600);

    return {
      page: await this.pageSummary(page),
      path: screenshotPath,
      mimeType: 'image/png',
      dataBase64: data.toString('base64'),
      captureEvidence: {
        pageActivation,
        pngBytes: data.byteLength,
        artifactClassification,
        semanticContentPresent,
        retryUsed,
      },
    };
  },

  snapshotReferenceSemantics(
    snapshot: string,
    refs: Set<string>,
  ): Map<string, ObservedReferenceSemantic> {
    const semantics = new Map<string, ObservedReferenceSemantic>();
    const lines = snapshot.split('\n');
    const decodeScalar = (value: string): string => {
      const trimmed = value.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
          return JSON.parse(trimmed) as string;
        } catch {
          return trimmed;
        }
      }
      if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1).replaceAll("''", "'");
      }
      return trimmed;
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const ref = line.match(/\[ref=([^\]]+)\]/u)?.[1];
      if (ref === undefined || !refs.has(ref)) continue;
      const semantic = line.match(/^\s*-\s+([a-z][a-z0-9_-]*)(?:\s+"((?:\\.|[^"\\])*)")?/iu);
      const role = semantic?.[1]?.toLocaleLowerCase();
      if (role === undefined) continue;
      let name = '';
      if (semantic?.[2] !== undefined) {
        try {
          name = JSON.parse(`"${semantic[2]}"`) as string;
        } catch {
          name = semantic[2];
        }
      }
      const indentation = line.match(/^\s*/u)?.[0].length ?? 0;
      let url: string | null = null;
      for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
        const child = lines[childIndex] ?? '';
        if (child.trim() === '') continue;
        const childIndentation = child.match(/^\s*/u)?.[0].length ?? 0;
        if (childIndentation <= indentation) break;
        const observedUrl = childIndentation === indentation + 2
          ? child.match(/^\s*-\s+\/url:\s*(.*)$/u)?.[1]
          : undefined;
        if (observedUrl !== undefined) {
          url = decodeScalar(observedUrl);
          break;
        }
      }
      semantics.set(ref, { role, name, url });
    }
    return semantics;
  },

  async filterInactivePopupSnapshot(
    frame: Frame,
    snapshot: string,
    deadlineAt: number,
  ): Promise<string> {
    const lines = snapshot.split('\n');
    const popupLines = lines.flatMap((line, index) => {
      const semantic = line.match(/^(\s*)-\s+([a-z][a-z0-9_-]*)(?:\s|$)/iu);
      const role = semantic?.[2]?.toLocaleLowerCase();
      if (role === undefined || !POPUP_RENDERED_STATE_ROLES.has(role)) return [];
      return [{
        index,
        indentation: semantic?.[1]?.length ?? 0,
        role,
        ref: line.match(/\[ref=([^\]]+)\]/u)?.[1] ?? null,
      }];
    });
    if (popupLines.length === 0) return snapshot;

    const renderedByLine = new Map<number, boolean | null>();
    const inspected = await Promise.all(popupLines.map(async (entry, candidateIndex) => {
      if (
        candidateIndex >= MAX_POPUP_RENDERED_STATE_CANDIDATES ||
        remainingUntil(deadlineAt) <= 0
      ) {
        return { index: entry.index, rendered: false };
      }
      if (entry.ref === null) {
        return {
          index: entry.index,
          rendered: POPUP_SURFACE_ROLES.has(entry.role) ? null : false,
        };
      }
      const locator = frame.locator(`aria-ref=${entry.ref}`);
      const count = await boundedValue(
        locator.count(),
        Math.max(1, remainingUntil(deadlineAt)),
        -1,
      );
      if (count !== 1) return { index: entry.index, rendered: false };
      const state = await boundedValue(
        inspectTargetState(locator),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      return {
        index: entry.index,
        rendered: state?.visible === true && state.inViewport,
      };
    }));
    for (const observation of inspected) {
      renderedByLine.set(observation.index, observation.rendered);
    }

    const suppressedRoots = new Set<number>();
    for (const entry of popupLines) {
      if (renderedByLine.get(entry.index) === false) {
        suppressedRoots.add(entry.index);
      }
      if (!POPUP_SURFACE_ROLES.has(entry.role)) continue;
      const descendantOptions = popupLines.filter((candidate) =>
        candidate.index > entry.index &&
        candidate.indentation > entry.indentation &&
        POPUP_OPTION_ROLES.has(candidate.role) &&
        !lines.slice(entry.index + 1, candidate.index + 1).some((line) => {
          if (line.trim() === '') return false;
          const indentation = line.match(/^\s*/u)?.[0].length ?? 0;
          return indentation <= entry.indentation;
        }));
      if (
        descendantOptions.length > 0 &&
        descendantOptions.every((candidate) => renderedByLine.get(candidate.index) !== true)
      ) {
        suppressedRoots.add(entry.index);
      }
    }

    const filtered: string[] = [];
    let suppressedIndentation: number | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const indentation = line.match(/^\s*/u)?.[0].length ?? 0;
      if (suppressedIndentation !== null) {
        if (line.trim() === '' || indentation > suppressedIndentation) continue;
        suppressedIndentation = null;
      }
      if (suppressedRoots.has(index)) {
        suppressedIndentation = indentation;
        continue;
      }
      filtered.push(line);
    }
    return filtered.join('\n');
  },

  async semanticForExactReference(
    locator: Locator,
    deadlineAt: number,
  ): Promise<ObservedReferenceSemantic | null> {
    const snapshot = await boundedValue(
      locator.ariaSnapshot({
        mode: 'ai',
        depth: 2,
        boxes: false,
        timeout: Math.max(1, remainingUntil(deadlineAt)),
      }),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (snapshot === null) return null;
    const refs = new Set(snapshot.match(/\[ref=([^\]]+)\]/gu)?.map((value) => value.slice(5, -1)) ?? []);
    return this.snapshotReferenceSemantics(snapshot, refs).values().next().value ?? null;
  },

  sameObservedReferenceSemantic(
    expected: ObservedReferenceSemantic,
    observed: ObservedReferenceSemantic,
  ): boolean {
    return expected.role === observed.role &&
      expected.name === observed.name &&
      (expected.url === null || expected.url === observed.url);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationPageOperations = typeof observationPageOperations;
