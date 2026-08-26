import { type BrowserCommandInput, type BrowserCommandName, type BrowserCommandOutput, type OperationOutcome, type OperationStatusResult, Stage5BrowserError, serializeUnknownError } from './dependencies.js';
import { type RecoveryOutcome, type RecoveryResult, type RuntimeTransition, SupervisedOperationError, type SupervisedResult } from './model.js';
import type { BrowserSupervisorContext } from './runtime.js';

export const executeOperations = {
  async execute<Name extends BrowserCommandName>(
    command: Name,
    payload: BrowserCommandInput<Name>,
    hardTimeoutMs?: number,
    requestedOperationId?: string,
  ): Promise<SupervisedResult<BrowserCommandOutput<Name>>> {
    if (command === 'initialize') {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Worker initialization is supervisor-owned.');
    }

    const operation = this.operations.begin(command, requestedOperationId);
    return this.queue.run(async () => {
      const { operationId, startedAt } = operation;
      const startedAtMs = Date.parse(startedAt);
      let runtimeTransition: RuntimeTransition | null = null;
      const browserWasConnectedBefore = this.browserWasConnected;

      try {
        await this.applyPendingAgentContext();
        this.operations.transition(operationId, 'worker_preflight');
        runtimeTransition = await this.reloadCompatibleRuntimeIfNeeded();
        await this.ensureWorker();
        this.operations.transition(operationId, 'worker_request_sent');
        const result = await this.request(
          command,
          payload,
          hardTimeoutMs ?? this.deadlineFor(command, payload),
        );
        this.operations.transition(operationId, 'worker_result_received');
        this.captureSelectedBrowser(result);
        this.captureLastKnownUrl(result);
        this.captureBrowserConnection(result);
        this.captureAuthenticationState(result);
        this.captureActionPolicyState(result);
        await this.noteAgentContextResult(command, browserWasConnectedBefore, result);
        this.operations.succeed(operationId, result, 'not_needed');
        const timing = this.operations.timing(operationId);
        await this.appendJournal({
          operationId,
          command,
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'succeeded',
          recovery: 'not_needed',
          completedAt: new Date(timing.terminalAtMs ?? Date.now()).toISOString(),
          timing: { ...timing, terminalAtMs: timing.terminalAtMs ?? Date.now() },
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        return { operationId, result, recovery: 'not_needed', runtimeTransition };
      } catch (error) {
        if (this.operations.phase(operationId) === 'worker_request_sent') {
          this.operations.transition(operationId, 'worker_result_received');
        }
        const serialized = serializeUnknownError(error);
        let recovery: RecoveryOutcome = 'not_needed';

        if (this.requiresHardRecovery(serialized.code)) {
          try {
            await this.replaceWorker();
            recovery = 'succeeded';
          } catch {
            recovery = 'failed';
          }
        }

        const outcome: OperationOutcome = serialized.code === 'OPERATION_TIMEOUT' ? 'timed_out' : 'failed';
        this.operations.fail(operationId, serialized, recovery);
        const timing = this.operations.timing(operationId);
        await this.appendJournal({
          operationId,
          command,
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome,
          recovery,
          errorCode: serialized.code,
          completedAt: new Date(timing.terminalAtMs ?? Date.now()).toISOString(),
          timing: { ...timing, terminalAtMs: timing.terminalAtMs ?? Date.now() },
          ...this.safeJournalDiagnostic(serialized),
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        throw new SupervisedOperationError(serialized, operationId, recovery, runtimeTransition);
      }
    });
  },

  async forceRecover(reopenLastUrl: boolean, requestedOperationId?: string): Promise<RecoveryResult> {
    const operation = this.operations.begin('recover', requestedOperationId);
    return this.queue.run(async () => {
      const { operationId, startedAt } = operation;
      const startedAtMs = Date.parse(startedAt);
      const candidateUrl = reopenLastUrl ? this.lastKnownUrl : null;
      this.operations.transition(operationId, 'worker_preflight');

      if (this.humanAuthenticationInProgress) {
        const serialized = new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          'Worker recovery is disabled while the private human authentication browser owns the profile.',
          {
            recoverable: true,
            details: {
              reason: 'human_authentication_in_progress',
              suggestedAction: 'Finish authentication and follow the exact backend-specific instruction returned by browser_request_login_handoff, then call browser_resume_after_login. Chromium-family browsers stay open for same-process attachment; Firefox exits normally. Do not recover or force-close the browser.',
            },
          },
        ).serialize();
        this.operations.fail(operationId, serialized, 'not_needed');
        const timing = this.operations.timing(operationId);
        await this.appendJournal({
          operationId,
          command: 'recover',
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'failed',
          recovery: 'not_needed',
          errorCode: serialized.code,
          completedAt: new Date(timing.terminalAtMs ?? Date.now()).toISOString(),
          timing: { ...timing, terminalAtMs: timing.terminalAtMs ?? Date.now() },
          browser: this.selectedBrowser,
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        throw new SupervisedOperationError(serialized, operationId, 'not_needed');
      }

      try {
        await this.applyPendingAgentContext();
        this.operations.transition(operationId, 'worker_request_sent');
        await this.replaceWorker();
        let reopenedUrl: string | null = null;
        if (candidateUrl !== null && candidateUrl !== 'about:blank') {
          const opened = await this.request(
            'open',
            { url: candidateUrl, newTab: false, timeoutMs: this.config.navigationTimeoutMs },
            this.config.navigationTimeoutMs + 2_000,
          );
          reopenedUrl = opened.page.url;
          this.lastKnownUrl = reopenedUrl;
        }
        const status = await this.request('status', {}, this.config.operationTimeoutMs);
        this.operations.transition(operationId, 'worker_result_received');
        this.captureSelectedBrowser(status);
        this.captureBrowserConnection(status);
        await this.noteAgentContextResult('recover', false, status);
        const browserRecovered = status.browserConnected;
        const outcome = browserRecovered
          ? 'worker_recovered_browser_running'
          : 'worker_recovered_browser_stopped';
        const result: RecoveryResult = {
          operationId,
          recovery: 'succeeded',
          outcome,
          workerRecovered: true,
          browserRecovered,
          reopenedUrl,
          status,
        };
        this.operations.succeed(operationId, result, 'succeeded');
        const timing = this.operations.timing(operationId);
        await this.appendJournal({
          operationId,
          command: 'recover',
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'succeeded',
          recovery: 'succeeded',
          browser: status.browser,
          browserState: status.state,
          completedAt: new Date(timing.terminalAtMs ?? Date.now()).toISOString(),
          timing: { ...timing, terminalAtMs: timing.terminalAtMs ?? Date.now() },
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        return result;
      } catch (error) {
        if (this.operations.phase(operationId) === 'worker_request_sent') {
          this.operations.transition(operationId, 'worker_result_received');
        }
        const serialized = serializeUnknownError(error);
        await this.terminateWorker();
        this.operations.fail(operationId, serialized, 'failed');
        const timing = this.operations.timing(operationId);
        await this.appendJournal({
          operationId,
          command: 'recover',
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'failed',
          recovery: 'failed',
          errorCode: serialized.code,
          completedAt: new Date(timing.terminalAtMs ?? Date.now()).toISOString(),
          timing: { ...timing, terminalAtMs: timing.terminalAtMs ?? Date.now() },
          ...this.safeJournalDiagnostic(serialized),
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        throw new SupervisedOperationError(serialized, operationId, 'failed');
      }
    });
  },

  reserveOperation(command: BrowserCommandName | 'recover'): OperationStatusResult {
    if (command === 'initialize') {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Worker initialization is supervisor-owned.');
    }
    return this.operations.reserve(command);
  },

  async operationStatus(
    operationId: string,
    includeResult: boolean,
  ): Promise<OperationStatusResult | null> {
    return this.operations.status(operationId, includeResult);
  },

  async markOperationResponseCreated(operationId: string): Promise<void> {
    try {
      await this.operations.markResponseCreated(operationId);
    } catch {
      // Timing diagnostics must never replace the already-created terminal response.
    }
  },

  async close(): Promise<void> {
    this.closing = true;
    await this.queue.run(async () => this.terminateWorker(undefined, 'graceful'));
  },
} satisfies Record<string, unknown> & ThisType<BrowserSupervisorContext>;

export type ExecuteOperations = typeof executeOperations;
