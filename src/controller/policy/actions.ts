import { type BrowserActionPolicyMode, type BrowserCommandName, type BrowserCommandOutput } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const actionPolicyOperations = {
  policyStatus(): BrowserCommandOutput<'policyStatus'> {
    return this.actionPolicy.status();
  },

  setPolicy(input: { mode: BrowserActionPolicyMode }): BrowserCommandOutput<'setPolicy'> {
    return this.actionPolicy.setMode(input.mode);
  },

  restoreActionPolicy(mode: BrowserActionPolicyMode): void {
    this.actionPolicy.restore(mode);
  },

  authorizeBrowserCommand(command: BrowserCommandName, payload: unknown): void {
    if (this.privateFieldHandoff !== null && ![
      'availableMoves',
      'policyStatus',
      'privateFieldStatus',
      'resumePrivateFieldHandoff',
    ].includes(command)) {
      throw this.privateFieldInProgressError();
    }
    if (this.pendingHandoffRelease !== null && ![
      'availableMoves',
      'authStatus',
      'policyStatus',
      'requestLoginHandoff',
    ].includes(command)) {
      throw this.humanBootstrapInProgressError();
    }
    if (this.authenticationHandoff?.state === 'awaiting_user' && ![
      'availableMoves',
      'authStatus',
      'policyStatus',
      'resumeAfterLogin',
    ].includes(command)) {
      throw this.humanBootstrapInProgressError();
    }
    this.actionPolicy.authorize(command, payload);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ActionPolicyOperations = typeof actionPolicyOperations;
