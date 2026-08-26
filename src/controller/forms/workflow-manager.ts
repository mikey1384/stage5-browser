import { randomUUID } from 'node:crypto';

export interface FormWorkflowSnapshot {
  workflowId: string;
  formId: string;
  stepCount: number;
  nextStep: number;
  activeStep: number | null;
  terminal: 'failed' | 'succeeded' | null;
  deadlineAtMs: number;
}

export class FormWorkflowSession {
  readonly workflowId = randomUUID();
  readonly deadlineAtMs: number;
  private nextStep = 0;
  private activeStep: number | null = null;
  private terminal: FormWorkflowSnapshot['terminal'] = null;

  constructor(
    readonly formId: string,
    readonly stepCount: number,
    timeoutMs: number,
  ) {
    if (stepCount < 1 || timeoutMs < 1) throw new Error('A form workflow requires bounded non-empty work.');
    this.deadlineAtMs = Date.now() + timeoutMs;
  }

  beginStep(index: number): void {
    if (this.terminal !== null || this.activeStep !== null || index !== this.nextStep) {
      throw new Error('The form workflow step order is invalid.');
    }
    this.activeStep = index;
  }

  completeStep(index: number): void {
    if (this.activeStep !== index) throw new Error('The active form workflow step does not match.');
    this.activeStep = null;
    this.nextStep = index + 1;
  }

  finish(outcome: 'failed' | 'succeeded'): void {
    if (this.terminal !== null) return;
    if (outcome === 'succeeded' && (this.activeStep !== null || this.nextStep !== this.stepCount)) {
      throw new Error('A form workflow cannot succeed before every exact step completes.');
    }
    this.terminal = outcome;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAtMs - Date.now());
  }

  snapshot(): FormWorkflowSnapshot {
    return {
      workflowId: this.workflowId,
      formId: this.formId,
      stepCount: this.stepCount,
      nextStep: this.nextStep,
      activeStep: this.activeStep,
      terminal: this.terminal,
      deadlineAtMs: this.deadlineAtMs,
    };
  }
}

export class FormWorkflowManager {
  private readonly active = new Map<string, FormWorkflowSession>();

  begin(formId: string, stepCount: number, timeoutMs: number): FormWorkflowSession {
    const session = new FormWorkflowSession(formId, stepCount, timeoutMs);
    this.active.set(session.workflowId, session);
    return session;
  }

  finish(session: FormWorkflowSession): void {
    if (!this.active.delete(session.workflowId)) throw new Error('The form workflow is not owned by this manager.');
  }
}
