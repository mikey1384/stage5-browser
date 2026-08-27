import type { ClickPostcondition, Frame, Locator, Page, PostconditionResult, SanitizedActionDiagnostic, SanitizedNativeWindowActivationEvidence } from '../dependencies.js';
import type { PreparedObservedClickTarget } from '../model.js';
import type { NoDispatchRecoveryReason } from './types.js';

export type ClickActivationPolicy =
  | 'pointer_only'
  | 'postconditioned_native_keyboard'
  | 'postconditioned_native_keyboard_fallback';

export interface ClickActionPlan {
  action: Extract<SanitizedActionDiagnostic['action'], 'click_by_ref' | 'click_by_role' | 'select_option' | 'set_checked'>;
  activationPolicy: ClickActivationPolicy;
  page: Page;
  frame: Frame;
  postcondition: ClickPostcondition | null;
  prepare(
    priorNativeActivation: SanitizedNativeWindowActivationEvidence | null,
    activationAttemptCount: number,
    actionStartedAt: string,
    actionDeadlineAt: number,
    activationPolicy: ClickActivationPolicy,
  ): Promise<PreparedObservedClickTarget>;
  reconciliationLocator(prepared: PreparedObservedClickTarget): Locator;
  reconcile?(prepared: PreparedObservedClickTarget, remainingTimeoutMs: number): Promise<PostconditionResult | null>;
  preDispatchRecoveryReason?: NoDispatchRecoveryReason;
  satisfiedWithoutDispatch?: { postcondition: PostconditionResult | null };
  discardCapabilities(): void;
}

export interface ClickActionDefinition<Observation> {
  action: ClickActionPlan['action'];
  timeoutMs: number;
  observe(): Promise<Observation>;
  plan(observation: Observation): ClickActionPlan | Promise<ClickActionPlan>;
  preflight(plan: ClickActionPlan): void | Promise<void>;
}
