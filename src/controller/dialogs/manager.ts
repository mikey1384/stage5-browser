import {
  BROWSER_DIALOG_TYPES,
  type BrowserCommandName,
  type BrowserDialogActionResult,
  type BrowserDialogExpectation,
  type BrowserDialogObservation,
  type BrowserDialogStatus,
  type BrowserDialogType,
  type Dialog,
  path,
  randomUUID,
  Stage5BrowserError,
} from '../dependencies.js';
import { DurableJsonFile } from '../persistence/durable-json.js';

const MANIFEST_VERSION = 1;
const MAX_RETAINED_DIALOGS = 200;

interface DialogManifest {
  version: typeof MANIFEST_VERSION;
  sequence: number;
  dialogs: BrowserDialogObservation[];
}

interface DialogScope {
  id: string;
  command: BrowserCommandName;
  expectation: BrowserDialogExpectation | null;
  observations: BrowserDialogObservation[];
  matched: boolean;
}

function isObservation(value: unknown): value is BrowserDialogObservation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BrowserDialogObservation>;
  return typeof candidate.dialogId === 'string'
    && Number.isSafeInteger(candidate.sequence)
    && BROWSER_DIALOG_TYPES.includes(candidate.type as BrowserDialogType)
    && typeof candidate.expected === 'boolean'
    && typeof candidate.occurredAt === 'string';
}

function isManifest(value: unknown): value is DialogManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DialogManifest>;
  return candidate.version === MANIFEST_VERSION
    && Number.isSafeInteger(candidate.sequence)
    && Array.isArray(candidate.dialogs)
    && candidate.dialogs.every(isObservation);
}

function copyObservation(observation: BrowserDialogObservation): BrowserDialogObservation {
  return { ...observation };
}

export class BrowserDialogManager {
  private sequence = 0;
  private readonly observations: BrowserDialogObservation[] = [];
  private readonly manifest: DurableJsonFile<DialogManifest>;
  private readonly ready: Promise<void>;
  private persistTail: Promise<void> = Promise.resolve();
  private activeScope: DialogScope | null = null;
  private readonly pending = new Set<Promise<void>>();

  constructor(artifactsDir: string) {
    this.manifest = new DurableJsonFile(path.join(artifactsDir, 'dialogs', 'manifest.json'), isManifest);
    this.ready = this.restore();
  }

  handle(dialog: Dialog): void {
    const pending = this.respond(dialog).catch(() => undefined);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
  }

  async run<Result>(
    command: BrowserCommandName,
    expectation: BrowserDialogExpectation | null,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    await this.ready;
    if (this.activeScope !== null) throw new Error('A dialog scope is already active.');
    const scope: DialogScope = {
      id: randomUUID(),
      command,
      expectation,
      observations: [],
      matched: false,
    };
    this.activeScope = scope;
    let result: Result | undefined;
    let operationError: unknown = null;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
    await this.settlePending();
    if (this.activeScope?.id === scope.id) this.activeScope = null;
    const dialog = this.actionResult(scope);

    if (operationError !== null) {
      throw this.withDialogEvidence(operationError, dialog);
    }
    this.assertSatisfied(scope, dialog);
    if (typeof result === 'object' && result !== null && (expectation !== null || dialog.observed)) {
      return { ...result, dialog };
    }
    return result as Result;
  }

  async status(limit: number): Promise<BrowserDialogStatus> {
    await this.ready;
    return {
      cursor: this.sequence,
      dialogs: this.observations.slice(-Math.max(1, Math.min(MAX_RETAINED_DIALOGS, limit))).map(copyObservation),
      defaultUnexpectedResponse: 'dismiss',
      privacy: 'message_and_prompt_text_never_retained',
      persistence: 'durable_sanitized_manifest',
    };
  }

  private async respond(dialog: Dialog): Promise<void> {
    await this.ready;
    const scope = this.activeScope;
    const type = dialog.type() as BrowserDialogType;
    const expected = scope?.expectation !== null
      && scope?.expectation !== undefined
      && !scope.matched
      && scope.expectation.type === type;
    const response = expected ? scope.expectation?.response ?? 'dismiss' : 'dismiss';
    if (expected && scope !== null) scope.matched = true;
    const observation: BrowserDialogObservation = {
      dialogId: `dialog-${randomUUID()}`,
      sequence: ++this.sequence,
      type,
      response,
      expected,
      command: scope?.command ?? null,
      occurredAt: new Date().toISOString(),
    };
    this.observations.push(observation);
    scope?.observations.push(observation);
    this.trim();
    try {
      if (response === 'accept') {
        await dialog.accept(type === 'prompt' ? scope?.expectation?.promptText : undefined);
      } else {
        await dialog.dismiss();
      }
    } catch {
      observation.response = 'response_failed';
    }
    await this.persist();
  }

  private actionResult(scope: DialogScope): BrowserDialogActionResult {
    const expected = scope.expectation !== null;
    const unexpected = scope.observations.some((observation) => !observation.expected);
    const responseFailed = scope.observations.some((observation) => observation.response === 'response_failed');
    return {
      expected,
      observed: scope.observations.length > 0,
      satisfied: expected ? scope.matched && !unexpected && !responseFailed : !unexpected && !responseFailed,
      dialogs: scope.observations.map(copyObservation),
    };
  }

  private assertSatisfied(scope: DialogScope, result: BrowserDialogActionResult): void {
    if (result.satisfied) return;
    const mismatch = scope.expectation !== null
      && result.observed
      && !scope.observations.some((observation) => observation.expected);
    const reason = mismatch
      ? 'dialog_expectation_mismatch'
      : scope.expectation !== null && !result.observed
        ? 'expected_dialog_not_observed'
        : 'unexpected_dialog_dismissed';
    throw new Stage5BrowserError('POSTCONDITION_FAILED', 'The browser dialog outcome did not match the action-scoped expectation.', {
      recoverable: true,
      details: {
        reason,
        actionDispatched: 'unknown',
        dialog: result,
        suggestedAction: 'Inspect authoritative page state. A dialog may have followed possible input; do not replay the triggering action automatically.',
      },
    });
  }

  private withDialogEvidence(error: unknown, dialog: BrowserDialogActionResult): unknown {
    if (!dialog.observed && !dialog.expected) return error;
    if (error instanceof Stage5BrowserError) {
      return new Stage5BrowserError(error.code, error.message, {
        recoverable: error.recoverable,
        details: { ...error.details, dialog },
        cause: error,
      });
    }
    return new Stage5BrowserError('OPERATION_FAILED', 'The browser action failed while handling a dialog.', {
      recoverable: true,
      details: {
        reason: 'action_failed_with_dialog',
        actionDispatched: 'unknown',
        dialog,
        suggestedAction: 'Inspect authoritative page state and do not replay the triggering action automatically.',
      },
      cause: error,
    });
  }

  private async settlePending(): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  private async restore(): Promise<void> {
    const manifest = await this.manifest.read();
    if (manifest === null) return;
    this.sequence = manifest.sequence;
    this.observations.push(...manifest.dialogs.map(copyObservation));
    this.trim();
  }

  private trim(): void {
    if (this.observations.length > MAX_RETAINED_DIALOGS) {
      this.observations.splice(0, this.observations.length - MAX_RETAINED_DIALOGS);
    }
  }

  private persist(): Promise<void> {
    this.persistTail = this.persistTail.then(() => this.manifest.write({
      version: MANIFEST_VERSION,
      sequence: this.sequence,
      dialogs: this.observations,
    }));
    return this.persistTail;
  }
}
