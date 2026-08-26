import { type BrowserExecutionTrace, type BuildExecutionTraceInput, buildExecutionTrace, type ExecutionTraceList, type WorkerCommandTelemetry } from './dependencies.js';
import type { BrowserSupervisorContext } from './runtime.js';

export const supervisorTelemetryOperations = {
  captureWorkerTelemetry(operationId: string, telemetry: WorkerCommandTelemetry): void {
    this.workerTelemetryByOperation.set(operationId, telemetry);
    while (this.workerTelemetryByOperation.size > 200) {
      const oldest = this.workerTelemetryByOperation.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.workerTelemetryByOperation.delete(oldest);
    }
  },

  takeWorkerTelemetry(operationId: string): WorkerCommandTelemetry | null {
    const telemetry = this.workerTelemetryByOperation.get(operationId) ?? null;
    this.workerTelemetryByOperation.delete(operationId);
    return telemetry;
  },

  async recordExecutionTrace(input: BuildExecutionTraceInput): Promise<BrowserExecutionTrace> {
    const trace = buildExecutionTrace(input);
    try {
      await this.telemetryJournal.append(trace);
    } catch {
      // Telemetry must never replace or delay the browser command's canonical outcome.
    }
    return trace;
  },

  async executionTraces(operationId: string | null, limit: number): Promise<ExecutionTraceList> {
    return this.telemetryJournal.list(operationId, limit);
  },
} satisfies Record<string, unknown> & ThisType<BrowserSupervisorContext>;

export type SupervisorTelemetryOperations = typeof supervisorTelemetryOperations;
