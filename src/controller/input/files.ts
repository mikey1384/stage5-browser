import { type BrowserCommandInput, type BrowserCommandOutput, type FileSelectionWarning, Stage5BrowserError } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputFilesOperations = {
  async setInputFiles(
    input: BrowserCommandInput<'setInputFiles'>,
  ): Promise<BrowserCommandOutput<'setInputFiles'>> {
    const phases = this.actionPhases.begin('set_input_files', input.timeoutMs);
    try {
    phases.enter('observe');
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const observed = this.observedSnapshots.get(frame);
    if (
      observed === undefined ||
      observed.id !== input.snapshotId ||
      observed.documentVersion !== this.documentVersion(frame)
    ) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The file-input reference does not belong to the latest snapshot of the current document.',
        {
          details: {
            reason: 'stale_or_unknown_snapshot',
            snapshotId: input.snapshotId,
            frameId: input.frameId,
          },
        },
      );
    }
    const target = observed.fileInputs.get(input.ref);
    if (target === undefined) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The requested file-input reference was not present in that snapshot.',
        {
          details: {
            reason: 'file_input_reference_not_observed',
            ref: input.ref,
            snapshotId: input.snapshotId,
          },
        },
      );
    }
    phases.enter('plan');
    phases.enter('preflight');
    const files = await this.preflightLocalFiles(input.paths);
    const liveInput = await this.inspectFileInput(target.handle);
    if (liveInput === null) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The observed file input is no longer attached to the current document.',
        {
          details: {
            reason: 'file_input_detached',
            ref: input.ref,
            snapshotId: input.snapshotId,
          },
        },
      );
    }
    if (liveInput.disabled) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The observed file input is disabled.', {
        recoverable: true,
        details: {
          reason: 'file_input_disabled',
          ref: input.ref,
          suggestedAction: 'Inspect the current page state and obtain a fresh snapshot after the upload control becomes enabled.',
        },
      });
    }
    if (!liveInput.multiple && files.length > 1) {
      throw new Stage5BrowserError('INVALID_FILE', 'The observed file input accepts only one file.', {
        details: {
          reason: 'file_input_does_not_accept_multiple',
          suppliedFileCount: files.length,
        },
      });
    }

    const diagnosticsBefore = this.pageDiagnostics.snapshot(page);
    phases.enter('prepare');
    const processingBaseline = {
      completeVisible: input.completion?.expectedComplete === null || input.completion === null
        ? false
        : await this.visibleExpectationObserved(page, input.completion.expectedComplete),
      errorVisible: input.completion?.expectedError === null || input.completion === null
        ? false
        : await this.visibleExpectationObserved(page, input.completion.expectedError),
      progress: await this.progressSample(frame),
    };
    const startedAtMs = Date.now();
    this.consumeObservedSnapshot(frame, target.handle);
    const eventObservationKey = await this.armFileInputEventObservation(target.handle);
    phases.beginDispatch();
    try {
      await target.handle.setInputFiles(
        files.map((file) => file.canonicalPath),
        { timeout: input.timeoutMs },
      );
    } catch (error) {
      phases.concludeDispatch({ actionDispatched: 'unknown' });
      phases.enter('reconcile');
      if (eventObservationKey !== null) {
        await this.collectFileInputEventObservation(target.handle, eventObservationKey);
      }
      await target.handle.dispose().catch(() => undefined);
      throw new Stage5BrowserError(
        'OPERATION_FAILED',
        'The browser could not set the observed file input.',
        {
          recoverable: true,
          details: {
            reason: 'file_selection_failed',
            fileSelectionDispatched: 'unknown',
            actionOutcome: 'file_selection_outcome_unknown',
            suggestedAction: 'Inspect the current composer before selecting the file again; the failed operation is not replayed automatically.',
          },
          cause: error,
        },
      );
    }
    phases.concludeDispatch({ actionDispatched: true });
    phases.enter('reconcile');
    const selectedFiles = await this.selectedFileMetadata(target.handle);
    const eventObservation = eventObservationKey === null
      ? null
      : await this.collectFileInputEventObservation(target.handle, eventObservationKey);
    await target.handle.dispose().catch(() => undefined);
    const retainedSelectionConfirmed = this.fileMetadataMatches(selectedFiles, files);
    const eventSelectionConfirmed = eventObservation !== null
      && (eventObservation.inputEventObserved || eventObservation.changeEventObserved)
      && this.fileMetadataMatches(eventObservation.files, files);
    const selectionConfirmed = retainedSelectionConfirmed || eventSelectionConfirmed;
    if (!selectionConfirmed) {
      throw new Stage5BrowserError(
        'POSTCONDITION_FAILED',
        'The file selection was dispatched, but the browser did not expose the expected file metadata during selection.',
        {
          recoverable: true,
          details: {
            reason: 'file_selection_not_confirmed',
            fileSelectionDispatched: true,
            actionOutcome: 'file_selection_dispatched_postcondition_failed',
            expectedFileCount: files.length,
            observedFileCount: selectedFiles.length,
            selectionEventObserved:
              eventObservation?.inputEventObserved === true || eventObservation?.changeEventObserved === true,
            suggestedAction: 'Inspect the current composer before any retry. Do not select the file again unless a fresh snapshot proves no attachment exists.',
          },
        },
      );
    }

    const processing = await this.observeFileProcessing(
      page,
      frame,
      input.completion,
      input.observationMs,
      Math.max(0, input.timeoutMs - (Date.now() - startedAtMs)),
      diagnosticsBefore,
      processingBaseline,
    );

    let attachmentPreview: BrowserCommandOutput<'setInputFiles'>['attachmentPreview'] = {
      observation: 'bounded_semantic_preview',
      available: false,
      depth: input.previewDepth,
      snapshotId: null,
      snapshot: null,
    };
    const warnings: FileSelectionWarning[] = [...processing.warnings];
    try {
      const remaining = Math.max(100, input.timeoutMs - (Date.now() - startedAtMs));
      const preview = await this.snapshot({
        depth: input.previewDepth,
        boxes: false,
        frameId: input.frameId,
        timeoutMs: remaining,
      });
      attachmentPreview = {
        observation: 'bounded_semantic_preview',
        available: true,
        depth: input.previewDepth,
        snapshotId: preview.snapshotId,
        snapshot: preview.snapshot,
      };
    } catch {
      warnings.push({
        code: 'attachment_preview_unavailable',
        message: 'The browser input event confirmed the selected file, but a bounded semantic preview could not be captured.',
        suggestedAction: 'Do not select the file again. Take one fresh snapshot to inspect attachment and processing state.',
      });
    }

    this.lastKnownUrl = page.url();
    phases.beginFinalization();
    const result: BrowserCommandOutput<'setInputFiles'> = {
      page: await this.pageSummary(page),
      frame: this.frameSummary(frame, page),
      selection: {
        dispatched: true,
        confirmedByInput: true,
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
        files: files.map(({ name, sizeBytes }) => ({ name, sizeBytes })),
      },
      attachmentPreview,
      processing: processing.result,
      warnings,
    };
    phases.complete('succeeded');
    return result;
    } finally {
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputFilesOperations = typeof inputFilesOperations;
