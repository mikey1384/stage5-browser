import { Stage5BrowserError, type BrowserActionPolicyMode, type BrowserCommandName, type BrowserProduct } from './dependencies.js';
import type { BrowserSupervisorContext } from './runtime.js';

export interface BrowserAgentContextBinding {
  scope: 'durable_agent';
  state: 'bound' | 'pending_reconcile' | 'restored';
  browser: string;
  browserSource: 'current_live_context' | 'configured_default' | 'durable_agent_context';
  actionPolicyMode: BrowserActionPolicyMode;
  policySource: 'current_live_context' | 'configured_default' | 'durable_agent_context';
  privacy: 'browser_and_policy_only';
}

interface PendingAgentContext {
  browser: BrowserProduct | null;
  actionPolicyMode: BrowserActionPolicyMode | null;
}

export const agentContextOperations = {
  async bindAgentContext(agentId: string): Promise<BrowserAgentContextBinding> {
    return this.agentContextQueue.run(async () => {
      if (this.agentContextId !== null && this.agentContextId !== agentId) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'This MCP host is already bound to a different durable agent context.',
          {
            details: {
              reason: 'agent_context_already_bound',
              suggestedAction: 'Keep one stable Lounge identity per MCP host connection.',
            },
          },
        );
      }
      if (this.agentContextId === agentId) return this.agentContextBinding();

      const stored = await this.agentContextStore.read(agentId);
      this.agentContextId = agentId;
      const liveBrowserContext = this.browserWasConnected || this.humanAuthenticationInProgress;
      let browserSource: BrowserAgentContextBinding['browserSource'] = 'configured_default';
      let policySource: BrowserAgentContextBinding['policySource'] = 'configured_default';

      if (liveBrowserContext) {
        this.agentContextBrowserKnown = true;
        browserSource = 'current_live_context';
      } else if (stored?.browser !== null && stored?.browser !== undefined) {
        this.agentContextBrowserKnown = true;
        browserSource = 'durable_agent_context';
        if (this.child === undefined) this.selectedBrowser = stored.browser;
        else this.pendingAgentBrowser = stored.browser;
      }

      if (this.agentContextPolicyKnown) {
        policySource = 'current_live_context';
      } else if (stored?.actionPolicyMode !== null && stored?.actionPolicyMode !== undefined) {
        this.agentContextPolicyKnown = true;
        policySource = 'durable_agent_context';
        if (this.child === undefined) this.actionPolicyMode = stored.actionPolicyMode;
        else this.pendingAgentPolicyMode = stored.actionPolicyMode;
      }

      if (liveBrowserContext) {
        await this.agentContextStore.write(agentId, {
          browser: this.selectedBrowser,
          actionPolicyMode: this.pendingAgentPolicyMode
            ?? (this.agentContextPolicyKnown ? this.actionPolicyMode : null),
        });
      }
      return {
        ...this.agentContextBinding(),
        state: this.pendingAgentBrowser !== null || this.pendingAgentPolicyMode !== null
          ? 'pending_reconcile'
          : stored === null ? 'bound' : 'restored',
        browser: this.pendingAgentBrowser ?? this.selectedBrowser,
        browserSource,
        actionPolicyMode: this.pendingAgentPolicyMode ?? this.actionPolicyMode,
        policySource,
      };
    });
  },

  agentContextBinding(): BrowserAgentContextBinding {
    const pending = this.pendingAgentBrowser !== null || this.pendingAgentPolicyMode !== null;
    return {
      scope: 'durable_agent',
      state: pending
        ? 'pending_reconcile'
        : this.agentContextBrowserKnown || this.agentContextPolicyKnown ? 'restored' : 'bound',
      browser: this.pendingAgentBrowser ?? this.selectedBrowser,
      browserSource: this.agentContextBrowserKnown ? 'durable_agent_context' : 'configured_default',
      actionPolicyMode: this.pendingAgentPolicyMode ?? this.actionPolicyMode,
      policySource: this.agentContextPolicyKnown ? 'durable_agent_context' : 'configured_default',
      privacy: 'browser_and_policy_only',
    };
  },

  async applyPendingAgentContext(): Promise<void> {
    const pending = await this.agentContextQueue.run<PendingAgentContext>(() => {
      const value = {
        browser: this.pendingAgentBrowser,
        actionPolicyMode: this.pendingAgentPolicyMode,
      };
      this.pendingAgentBrowser = null;
      this.pendingAgentPolicyMode = null;
      return Promise.resolve(value);
    });
    if (pending.browser === null && pending.actionPolicyMode === null) return;

    const liveBrowserContext = this.browserWasConnected || this.humanAuthenticationInProgress;
    const browserChanged = pending.browser !== null && pending.browser !== this.selectedBrowser;
    const policyChanged = pending.actionPolicyMode !== null
      && pending.actionPolicyMode !== this.actionPolicyMode;
    if (!liveBrowserContext && pending.browser !== null) this.selectedBrowser = pending.browser;
    if (pending.actionPolicyMode !== null) this.actionPolicyMode = pending.actionPolicyMode;

    if (!liveBrowserContext && browserChanged && this.child !== undefined) {
      await this.terminateWorker(undefined, 'graceful');
    } else if (policyChanged && this.child !== undefined) {
      await this.request('setPolicy', { mode: this.actionPolicyMode }, this.config.operationTimeoutMs);
    }
    if (liveBrowserContext && pending.browser !== null) this.agentContextBrowserKnown = true;
    await this.persistAgentContext();
  },

  async noteAgentContextResult(
    command: BrowserCommandName | 'recover',
    browserWasConnectedBefore: boolean,
    result: unknown,
  ): Promise<void> {
    if (this.agentContextId === null) return;
    const connected = typeof result === 'object'
      && result !== null
      && (result as { browserConnected?: unknown }).browserConnected === true;
    if (
      browserWasConnectedBefore
      || connected
      || command === 'start'
      || command === 'switchBrowser'
      || command === 'stop'
      || command === 'requestLoginHandoff'
      || command === 'resumeAfterLogin'
    ) this.agentContextBrowserKnown = true;
    if (command === 'setPolicy') this.agentContextPolicyKnown = true;
    await this.persistAgentContext().catch(() => undefined);
  },

  async persistAgentContext(): Promise<void> {
    if (
      this.agentContextId === null
      || (!this.agentContextBrowserKnown && !this.agentContextPolicyKnown)
    ) return;
    await this.agentContextQueue.run(() => this.writeAgentContext());
  },

  async writeAgentContext(): Promise<void> {
    if (this.agentContextId === null) return;
    await this.agentContextStore.write(this.agentContextId, {
      browser: this.agentContextBrowserKnown ? this.selectedBrowser : null,
      actionPolicyMode: this.agentContextPolicyKnown ? this.actionPolicyMode : null,
    });
  },
} satisfies Record<string, unknown> & ThisType<BrowserSupervisorContext>;

export type AgentContextOperations = typeof agentContextOperations;
