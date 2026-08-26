import { access, type Browser, type ElementHandle, type FileInputObservation, type Frame, fsConstants, type Locator, lstat, path, randomUUID, realpath, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type FileInputEventObservation, type LocalFileSelection, MAX_FILE_INPUTS_PER_SNAPSHOT, MAX_TEXT_EDITORS_PER_SNAPSHOT, type ObservedFileInput, type ObservedTextEditor, remainingUntil, type SnapshotRoot } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const observationSnapshotInputsOperations = {
  async snapshotRoot(frame: Frame): Promise<SnapshotRoot> {
    const dialogs = frame.locator(
      '[role="dialog"]:visible, dialog[open]:visible, [aria-modal="true"]:visible',
    );
    const visibleModalCount = await dialogs.count();
    if (visibleModalCount === 0) {
      return {
        locator: frame.locator('body'),
        scope: 'document',
        visibleModalCount,
        warnings: [],
      };
    }

    const modalIndex = await dialogs.evaluateAll((elements) => {
      if (elements.length === 1) {
        return 0;
      }
      const activeElement = document.activeElement;
      const containingActiveElement = elements
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => activeElement !== null && element.contains(activeElement));
      if (containingActiveElement.length === 1) {
        return containingActiveElement[0]?.index ?? -1;
      }
      const explicitModals = elements
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => element.getAttribute('aria-modal') === 'true');
      return explicitModals.length === 1 ? explicitModals[0]?.index ?? -1 : -1;
    });

    if (modalIndex >= 0) {
      return {
        locator: dialogs.nth(modalIndex),
        scope: 'modal',
        visibleModalCount,
        warnings: [],
      };
    }

    return {
      locator: frame.locator('body'),
      scope: 'document',
      visibleModalCount,
      warnings: [{
        code: 'ambiguous_visible_modals',
        message: 'Multiple visible dialogs were present, but no unique active modal could be established.',
        suggestedAction: 'Inspect the document snapshot and use a unique semantic target; Stage5 Browser did not choose a dialog arbitrarily.',
      }],
    };
  },

  async observeTextEditors(
    root: Locator,
    snapshotRefs: Set<string>,
    deadlineAt: number,
  ): Promise<{ editors: Map<string, ObservedTextEditor> }> {
    const locator = root.locator(
      'input:not([type="button"]):not([type="checkbox"]):not([type="file"]):not([type="hidden"]):not([type="image"]):not([type="password"]):not([type="radio"]):not([type="range"]):not([type="reset"]):not([type="submit"]):visible, '
      + 'textarea:visible, [contenteditable]:visible, [role="textbox"]:not(input):not(textarea):not([contenteditable]):visible',
    );
    const total = await boundedValue(
      locator.count(),
      Math.max(1, remainingUntil(deadlineAt)),
      -1,
    );
    if (total === -1) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Text-editor capability capture exceeded the snapshot deadline.', {
        recoverable: true,
        details: {
          reason: 'text_editor_capability_timeout',
          suggestedAction: 'Wait for the current modal or page to stabilize, then take one fresh snapshot.',
        },
      });
    }
    if (total > MAX_TEXT_EDITORS_PER_SNAPSHOT) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The snapshot scope contains too many visible text editors to bind safely.', {
        recoverable: true,
        details: {
          reason: 'text_editor_capability_observation_incomplete',
          observedCandidateCount: total,
          maximumCandidateCount: MAX_TEXT_EDITORS_PER_SNAPSHOT,
          suggestedAction: 'Narrow to the intended modal or frame before filling; Stage5 Browser will not expose an unbound editor ref.',
        },
      });
    }

    const editors = new Map<string, ObservedTextEditor>();
    try {
      for (let index = 0; index < total; index += 1) {
        const candidate = locator.nth(index);
        const handle = await boundedValue(
          candidate.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (handle === null) {
          throw new Stage5BrowserError('TARGET_NOT_FOUND', 'A visible text editor changed during snapshot capture.', {
            recoverable: true,
            details: {
              reason: 'text_editor_detached_during_snapshot',
              suggestedAction: 'Wait for the current modal or page to stabilize, then take one fresh snapshot.',
            },
          });
        }
        const eligible = await boundedValue(
          handle.evaluate((element) => {
            const input = element instanceof HTMLInputElement;
            const type = input ? element.type.toLocaleLowerCase() : '';
            return (input && ![
              'button', 'checkbox', 'file', 'hidden', 'image', 'password', 'radio', 'range', 'reset', 'submit',
            ].includes(type)) || element instanceof HTMLTextAreaElement || element.isContentEditable;
          }),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (eligible !== true) {
          await handle.dispose().catch(() => undefined);
          if (eligible === null) {
            throw new Stage5BrowserError('OPERATION_FAILED', 'A visible text editor could not be inspected during snapshot capture.', {
              recoverable: true,
              details: {
                reason: 'text_editor_capability_timeout',
                suggestedAction: 'Wait for the current modal or page to stabilize, then take one fresh snapshot.',
              },
            });
          }
          continue;
        }
        const candidateSnapshot = await boundedValue(
          candidate.ariaSnapshot({
            mode: 'ai',
            depth: 0,
            boxes: false,
            timeout: Math.max(1, remainingUntil(deadlineAt)),
          }),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (candidateSnapshot === null) {
          await handle.dispose().catch(() => undefined);
          throw new Stage5BrowserError('OPERATION_FAILED', 'A visible text editor could not be bound before the snapshot deadline.', {
            recoverable: true,
            details: {
              reason: 'text_editor_capability_timeout',
              suggestedAction: 'Wait for the current modal or page to stabilize, then take one fresh snapshot.',
            },
          });
        }
        const ref = candidateSnapshot.match(/\[ref=([^\]]+)\]/)?.[1];
        if (ref === undefined || !snapshotRefs.has(ref)) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        if (editors.has(ref)) {
          await handle.dispose().catch(() => undefined);
          throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'A text-editor reference did not bind to one exact element.', {
            recoverable: true,
            details: {
              reason: 'text_editor_capability_ambiguous',
              suggestedAction: 'Take one fresh snapshot after the current modal or page stabilizes.',
            },
          });
        }
        editors.set(ref, { handle });
      }
    } catch (error) {
      for (const { handle } of editors.values()) {
        await handle.dispose().catch(() => undefined);
      }
      throw error;
    }
    return { editors };
  },

  async observeFileInputs(
    root: Locator,
  ): Promise<{ inputs: Map<string, ObservedFileInput>; truncated: boolean }> {
    const locator = root.locator('input[type="file"]');
    const total = await locator.count();
    const inputs = new Map<string, ObservedFileInput>();
    try {
      for (let index = 0; index < Math.min(total, MAX_FILE_INPUTS_PER_SNAPSHOT); index += 1) {
        const handle = await locator.nth(index).elementHandle() as ElementHandle<HTMLInputElement> | null;
        if (handle === null) {
          continue;
        }
        const live = await this.inspectFileInput(handle);
        if (live === null) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        const ref = `file-${randomUUID()}`;
        inputs.set(ref, {
          handle,
          observation: { ref, ...live },
        });
      }
    } catch (error) {
      for (const { handle } of inputs.values()) {
        await handle.dispose().catch(() => undefined);
      }
      throw error;
    }
    return { inputs, truncated: total > MAX_FILE_INPUTS_PER_SNAPSHOT };
  },

  async inspectFileInput(
    handle: ElementHandle<HTMLInputElement>,
  ): Promise<Omit<FileInputObservation, 'ref'> | null> {
    try {
      return await handle.evaluate((element) => {
        if (!(element instanceof HTMLInputElement) || element.type.toLocaleLowerCase() !== 'file') {
          return null;
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
        const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        const associatedLabels = Array.from(element.labels ?? [])
          .map((label) => label.innerText || label.textContent || '')
          .join(' ');
        const rawLabel = [
          element.getAttribute('aria-label') ?? '',
          labelledBy,
          associatedLabels,
          element.getAttribute('title') ?? '',
        ].find((candidate) => candidate.trim().length > 0) ?? '';
        const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 200);
        const accept = element.accept.trim().slice(0, 500);
        return {
          accept: accept.length === 0 ? null : accept,
          multiple: element.multiple,
          disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
          visible,
          label: label.length === 0 ? null : label,
        };
      });
    } catch {
      return null;
    }
  },

  async selectedFileMetadata(
    handle: ElementHandle<HTMLInputElement>,
  ): Promise<Array<{ name: string; sizeBytes: number }>> {
    try {
      return await handle.evaluate((element) => Array.from(element.files ?? []).map((file) => ({
        name: file.name,
        sizeBytes: file.size,
      })));
    } catch {
      return [];
    }
  },

  async armFileInputEventObservation(
    handle: ElementHandle<HTMLInputElement>,
  ): Promise<string | null> {
    const key = `__stage5_file_input_${randomUUID().replaceAll('-', '')}`;
    try {
      await handle.evaluate((element, observationKey) => {
        const record: FileInputEventObservation = {
          inputEventObserved: false,
          changeEventObserved: false,
          files: [],
        };
        const listener = (event: Event): void => {
          if (event.target !== element) {
            return;
          }
          if (event.type === 'input') {
            record.inputEventObserved = true;
          }
          if (event.type === 'change') {
            record.changeEventObserved = true;
          }
          const observedFiles = Array.from(element.files ?? []).map((file) => ({
            name: file.name,
            sizeBytes: file.size,
          }));
          if (observedFiles.length > 0) {
            record.files = observedFiles;
          }
        };
        const eventTarget: EventTarget = element.ownerDocument.defaultView ?? element.ownerDocument;
        Object.defineProperty(element, observationKey, {
          configurable: true,
          enumerable: false,
          value: { eventTarget, record, listener },
        });
        eventTarget.addEventListener('input', listener, { capture: true });
        eventTarget.addEventListener('change', listener, { capture: true });
      }, key);
      return key;
    } catch {
      return null;
    }
  },

  async collectFileInputEventObservation(
    handle: ElementHandle<HTMLInputElement>,
    key: string,
  ): Promise<FileInputEventObservation | null> {
    try {
      return await handle.evaluate((element, observationKey) => {
        const observedElement = element as HTMLInputElement & Record<string, unknown>;
        const stored = observedElement[observationKey] as {
          eventTarget: EventTarget;
          record: FileInputEventObservation;
          listener: EventListener;
        } | undefined;
        if (stored === undefined) {
          return null;
        }
        stored.eventTarget.removeEventListener('input', stored.listener, true);
        stored.eventTarget.removeEventListener('change', stored.listener, true);
        delete observedElement[observationKey];
        return stored.record;
      }, key);
    } catch {
      return null;
    }
  },

  fileMetadataMatches(
    observed: Array<{ name: string; sizeBytes: number }>,
    expected: LocalFileSelection[],
  ): boolean {
    return observed.length === expected.length && observed.every((file, index) => {
      const expectedFile = expected[index];
      return expectedFile !== undefined
        && file.name === expectedFile.name
        && file.sizeBytes === expectedFile.sizeBytes;
    });
  },

  async preflightLocalFiles(paths: string[]): Promise<LocalFileSelection[]> {
    const files: LocalFileSelection[] = [];
    for (let index = 0; index < paths.length; index += 1) {
      const suppliedPath = paths[index];
      if (suppliedPath === undefined || !path.isAbsolute(suppliedPath)) {
        throw new Stage5BrowserError('INVALID_FILE', 'Every selected file must use an absolute local path.', {
          details: { reason: 'file_path_not_absolute', fileIndex: index },
        });
      }
      let metadata;
      try {
        metadata = await lstat(suppliedPath);
      } catch {
        throw new Stage5BrowserError('INVALID_FILE', 'A selected local file does not exist or cannot be inspected.', {
          details: { reason: 'file_not_accessible', fileIndex: index },
        });
      }
      if (metadata.isSymbolicLink()) {
        throw new Stage5BrowserError('INVALID_FILE', 'Symbolic links cannot be selected for upload.', {
          details: { reason: 'file_is_symbolic_link', fileIndex: index },
        });
      }
      if (!metadata.isFile()) {
        throw new Stage5BrowserError('INVALID_FILE', 'Only regular local files can be selected for upload.', {
          details: { reason: 'file_is_not_regular', fileIndex: index },
        });
      }
      try {
        await access(suppliedPath, fsConstants.R_OK);
      } catch {
        throw new Stage5BrowserError('INVALID_FILE', 'A selected local file is not readable.', {
          details: { reason: 'file_not_readable', fileIndex: index },
        });
      }
      const canonicalPath = await realpath(suppliedPath);
      files.push({
        canonicalPath,
        name: path.basename(canonicalPath),
        sizeBytes: metadata.size,
      });
    }
    return files;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationSnapshotInputsOperations = typeof observationSnapshotInputsOperations;
