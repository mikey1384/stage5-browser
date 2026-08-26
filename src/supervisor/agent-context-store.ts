import { createHash } from 'node:crypto';
import path from 'node:path';

import { SUPPORTED_BROWSER_PRODUCTS, type BrowserProduct } from '../browser-provider.js';
import { DurableJsonFile } from '../persistence/durable-json.js';
import type { BrowserActionPolicyMode } from '../protocol.js';

const CONTEXT_VERSION = 1;

export interface DurableBrowserAgentContext {
  version: typeof CONTEXT_VERSION;
  browser: BrowserProduct | null;
  actionPolicyMode: BrowserActionPolicyMode | null;
  updatedAt: string;
}

function isAgentContext(value: unknown): value is DurableBrowserAgentContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DurableBrowserAgentContext>;
  return candidate.version === CONTEXT_VERSION
    && (candidate.browser === null
      || (typeof candidate.browser === 'string'
        && (SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(candidate.browser)))
    && (candidate.actionPolicyMode === null
      || candidate.actionPolicyMode === 'normal'
      || candidate.actionPolicyMode === 'review_only')
    && typeof candidate.updatedAt === 'string';
}

function contextKey(agentId: string): string {
  return createHash('sha256').update(agentId).digest('hex').slice(0, 32);
}

export class BrowserAgentContextStore {
  constructor(private readonly profilesDir: string) {}

  private file(agentId: string): DurableJsonFile<DurableBrowserAgentContext> {
    return new DurableJsonFile(
      path.join(this.profilesDir, '.stage5-agent-contexts', `${contextKey(agentId)}.json`),
      isAgentContext,
    );
  }

  read(agentId: string): Promise<DurableBrowserAgentContext | null> {
    return this.file(agentId).read();
  }

  write(
    agentId: string,
    context: Pick<DurableBrowserAgentContext, 'actionPolicyMode' | 'browser'>,
  ): Promise<void> {
    return this.file(agentId).write({
      version: CONTEXT_VERSION,
      ...context,
      updatedAt: new Date().toISOString(),
    });
  }
}
