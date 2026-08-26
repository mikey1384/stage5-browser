import type { ClickPostcondition, Frame, Locator, Page, SanitizedActionDiagnostic, SanitizedNativeWindowActivationEvidence } from '../dependencies.js';
import type { PreparedObservedClickTarget } from '../model.js';

export interface ClickActionPlan {
  action: Extract<SanitizedActionDiagnostic['action'], 'click_by_ref' | 'click_by_role' | 'select_option' | 'set_checked'>;
  page: Page;
  frame: Frame;
  postcondition: ClickPostcondition | null;
  prepare(
    priorNativeActivation: SanitizedNativeWindowActivationEvidence | null,
    activationAttemptCount: number,
    actionStartedAt: string,
    actionDeadlineAt: number,
  ): Promise<PreparedObservedClickTarget>;
  reconciliationLocator(prepared: PreparedObservedClickTarget): Locator;
  discardCapabilities(): void;
}

export interface ClickActionDefinition<Observation> {
  action: ClickActionPlan['action'];
  timeoutMs: number;
  observe(): Promise<Observation>;
  plan(observation: Observation): ClickActionPlan | Promise<ClickActionPlan>;
  preflight(plan: ClickActionPlan): void | Promise<void>;
}
