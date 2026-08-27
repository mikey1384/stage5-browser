import { type ElementHandle, type FillRefEvidence, type Locator, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type FillTargetDescriptor, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

const DATE_VALUE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;

function validIsoDate(value: string): boolean {
  if (!DATE_VALUE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day;
}

export const inputFillEvidenceOperations = {
  async resolveUniqueFillTarget(
    locator: Locator,
    role: string,
    name: string,
    timeoutMs: number,
  ): Promise<ElementHandle<HTMLElement>> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + Math.min(1_000, Math.max(1, timeoutMs));
    const countWithinDeadline = (): Promise<number> => boundedValue(
      locator.count(),
      Math.max(1, deadlineAt - Date.now()),
      -1,
    );
    let count = await countWithinDeadline();
    while (count === 0 && Date.now() < deadlineAt) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadlineAt - Date.now())));
      count = await countWithinDeadline();
    }
    if (count === -1) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Role resolution exceeded the bounded fill preflight.', {
        recoverable: true,
        details: {
          reason: 'role_resolution_deadline_expired',
          role,
          name,
          actionDispatched: false,
          suggestedAction: 'Take one fresh semantic snapshot; Stage5 Browser confirmed that no text was entered.',
        },
      });
    }
    if (count === 0) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'No element matched the requested role and accessible name.', {
        recoverable: true,
        details: {
          reason: 'target_not_found_after_bounded_observation',
          role,
          name,
          actionDispatched: false,
          resolutionWaitMs: Date.now() - startedAt,
          suggestedAction: 'Take one fresh semantic snapshot; Stage5 Browser confirmed that no text was entered.',
        },
      });
    }
    if (count > 1) {
      throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Multiple elements matched; Stage5 Browser will not choose one arbitrarily.', {
        details: { reason: 'ambiguous_target', role, name, matchCount: count, actionDispatched: false },
      });
    }
    const handle = await boundedValue(
      locator.elementHandle(),
      Math.max(1, deadlineAt - Date.now()),
      null,
    );
    if (handle === null) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The unique fill target detached during read-only resolution.', {
        recoverable: true,
        details: {
          reason: 'target_detached_before_input',
          actionDispatched: false,
          suggestedAction: 'Take one fresh semantic snapshot; Stage5 Browser confirmed that no text was entered.',
        },
      });
    }
    return handle as ElementHandle<HTMLElement>;
  },

  async inspectFillTarget(
    handle: ElementHandle<HTMLElement>,
    timeoutMs: number,
  ): Promise<FillTargetDescriptor | null> {
    return boundedValue(handle.evaluate((element) => {
      const input = element instanceof HTMLInputElement;
      const inputType = input ? element.type.toLocaleLowerCase() : null;
      const supportedInput = input && ![
        'button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
      ].includes(inputType ?? '');
      const targetKind = supportedInput
        ? 'input'
        : element instanceof HTMLTextAreaElement
          ? 'textarea'
          : element instanceof HTMLElement && element.isContentEditable
            ? 'contenteditable'
            : null;
      if (targetKind === null) return null;
      return {
        targetKind,
        inputType,
        enabled: !('disabled' in element && Boolean((element as HTMLInputElement).disabled))
          && element.getAttribute('aria-disabled') !== 'true',
      };
    }), Math.max(1, timeoutMs), null);
  },

  validateFillValue(target: FillTargetDescriptor, value: string): void {
    if (target.inputType !== 'date' || validIsoDate(value)) return;
    throw new Stage5BrowserError(
      'OPERATION_FAILED',
      'The date field requires the HTML date format YYYY-MM-DD.',
      {
        recoverable: true,
        details: {
          reason: 'invalid_date_format',
          expectedFormat: 'YYYY-MM-DD',
          actionDispatched: false,
          suggestedAction: 'Convert the already authorized date to YYYY-MM-DD, then issue one fresh fill. Stage5 Browser did not enter any text.',
        },
      },
    );
  },

  async dispatchPreparedFill(
    handle: ElementHandle<HTMLElement>,
    target: FillTargetDescriptor,
    value: string,
    actionDeadlineAt: number,
    finalizationDeadlineAt: number,
  ): Promise<FillRefEvidence> {
    const observer = await boundedValue(handle.evaluateHandle((element) => {
      const contenteditableValue = (): string => {
        if ((element.textContent ?? '').trim().length === 0) return '';
        const blockTags = new Set([
          'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'FOOTER', 'HEADER',
          'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION',
        ]);
        const rendered = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
          if (!(node instanceof Element)) return '';
          if (node.tagName === 'BR') return '\n';
          let renderedValue = '';
          for (const child of node.childNodes) renderedValue += rendered(child);
          if (blockTags.has(node.tagName) && !renderedValue.endsWith('\n')) renderedValue += '\n';
          return renderedValue;
        };
        return rendered(element).replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
      };
      const currentValue = (): string => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : contenteditableValue();
      const initialValue = currentValue();
      let inputEventObserved = false;
      let changeEventObserved = false;
      const onInput = (event: Event): void => {
        if (event.composedPath().includes(element)) inputEventObserved = true;
      };
      const onChange = (event: Event): void => {
        if (event.composedPath().includes(element)) changeEventObserved = true;
      };
      document.addEventListener('input', onInput, true);
      document.addEventListener('change', onChange, true);
      return {
        finish: (expected: string) => {
          document.removeEventListener('input', onInput, true);
          document.removeEventListener('change', onChange, true);
          return {
            inputEventObserved,
            changeEventObserved,
            valueMatchedBefore: initialValue === expected,
            valueMatches: currentValue() === expected,
            targetConnectedAfter: element.isConnected,
          };
        },
        cancel: () => {
          document.removeEventListener('input', onInput, true);
          document.removeEventListener('change', onChange, true);
        },
      };
    }), Math.max(1, remainingUntil(actionDeadlineAt)), null);
    if (observer === null) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Text input evidence could not be installed before dispatch.', {
        recoverable: true,
        details: {
          reason: 'input_observer_install_failed',
          actionDispatched: false,
          suggestedAction: 'Take one fresh snapshot; Stage5 Browser confirmed that no text was entered.',
        },
      });
    }

    let fillError: unknown = null;
    try {
      const dispatchTimeoutMs = remainingUntil(actionDeadlineAt);
      if (dispatchTimeoutMs <= 0) {
        throw new Error('The bounded fill-dispatch phase expired before input.');
      }
      await this.dispatchExactHandleFill(handle, value, dispatchTimeoutMs);
    } catch (error) {
      fillError = error;
    }
    const observedInput = await boundedValue(
      observer.evaluate((controller, expected) => controller.finish(expected), value),
      Math.max(1, remainingUntil(finalizationDeadlineAt)),
      null,
    );
    if (observedInput === null) {
      await boundedValue(
        observer.evaluate((controller) => controller.cancel()).then(() => true),
        Math.max(1, remainingUntil(finalizationDeadlineAt)),
        false,
      );
    }
    await observer.dispose().catch(() => undefined);
    if (observedInput === null) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Text input evidence could not be retained.', {
        recoverable: true,
        details: {
          reason: 'input_evidence_unavailable',
          actionDispatched: 'unknown',
          suggestedAction: 'Inspect the editor with a fresh snapshot. Do not repeat the fill unless its current state proves that retrying is safe.',
        },
        cause: fillError,
      });
    }

    const actionDispatched: FillRefEvidence['actionDispatched'] =
      observedInput.inputEventObserved || observedInput.changeEventObserved
        ? true
        : observedInput.valueMatchedBefore
          ? false
          : observedInput.valueMatches
            ? true
            : fillError === null
              ? 'unknown'
              : false;
    const evidence: FillRefEvidence = {
      actionDispatched,
      inputEventObserved: observedInput.inputEventObserved,
      changeEventObserved: observedInput.changeEventObserved,
      valueMatchedBefore: observedInput.valueMatchedBefore,
      valueMatches: observedInput.valueMatches,
      targetConnectedAfter: observedInput.targetConnectedAfter,
      targetKind: target.targetKind,
      inputSurface: target.inputType === 'password'
        ? 'password'
        : target.targetKind,
    };
    if (evidence.valueMatches) return evidence;

    throw new Stage5BrowserError('OPERATION_FAILED', 'The observed editor did not retain the requested value.', {
      recoverable: true,
      details: {
        reason: fillError === null ? 'input_value_not_confirmed' : 'fill_dispatch_failed',
        actionDispatched: evidence.actionDispatched,
        inputEvidence: evidence,
        suggestedAction: evidence.actionDispatched === false
          ? 'Take one fresh snapshot before another attempt; Stage5 Browser confirmed that no input event occurred.'
          : 'Inspect the editor with a fresh snapshot. Do not replay because partial text input may already be present.',
      },
      cause: fillError,
    });
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputFillEvidenceOperations = typeof inputFillEvidenceOperations;
