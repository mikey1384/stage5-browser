import { type BrowserActionPolicyMode, type BrowserProduct, type ChildProcess, OperationRegistry, type RuntimeProcessInfo, SerialQueue, type Stage5BrowserConfig } from './dependencies.js';
import { type BrowserSupervisorOptions, type PendingRequest } from './model.js';
import { executeOperations, type ExecuteOperations } from './execute.js';
import { workerLifecycleOperations, type WorkerLifecycleOperations } from './worker-lifecycle.js';
import { transportOperations, type TransportOperations } from './transport.js';
import { policyOperations, type PolicyOperations } from './policy.js';
import { agentContextOperations, type AgentContextOperations } from './agent-context.js';
import { BrowserAgentContextStore } from './agent-context-store.js';
export interface BrowserSupervisorContext extends
  ExecuteOperations,
  WorkerLifecycleOperations,
  TransportOperations,
  PolicyOperations,
  AgentContextOperations {
  config: Stage5BrowserConfig;
  queue: SerialQueue;
  operations: OperationRegistry;
  workerUrl: URL;
  environment: NodeJS.ProcessEnv;
  expectedBuildFingerprint: string | null;
  runtimeInfoProvider: (() => RuntimeProcessInfo) | undefined;
  pending: Map<string, PendingRequest>;
  child: ChildProcess | undefined;
  workerRuntime: RuntimeProcessInfo | null;
  selectedBrowser: BrowserProduct;
  lastKnownUrl: string | null;
  browserWasConnected: boolean;
  humanAuthenticationInProgress: boolean;
  actionPolicyMode: BrowserActionPolicyMode;
  agentContextStore: BrowserAgentContextStore;
  agentContextQueue: SerialQueue;
  agentContextId: string | null;
  agentContextBrowserKnown: boolean;
  agentContextPolicyKnown: boolean;
  pendingAgentBrowser: BrowserProduct | null;
  pendingAgentPolicyMode: BrowserActionPolicyMode | null;
  closing: boolean;
}

export interface BrowserSupervisor extends
  ExecuteOperations,
  WorkerLifecycleOperations,
  TransportOperations,
  PolicyOperations,
  AgentContextOperations {}

export class BrowserSupervisor {
  private readonly queue = new SerialQueue();
  private readonly operations: OperationRegistry;
  private readonly workerUrl: URL;
  private readonly environment: NodeJS.ProcessEnv;
  private expectedBuildFingerprint: string | null;
  private readonly runtimeInfoProvider: (() => RuntimeProcessInfo) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private child: ChildProcess | undefined;
  private workerRuntime: RuntimeProcessInfo | null = null;
  private selectedBrowser: BrowserProduct;
  private lastKnownUrl: string | null = null;
  private browserWasConnected = false;
  private humanAuthenticationInProgress = false;
  private actionPolicyMode: BrowserActionPolicyMode = 'normal';
  private readonly agentContextStore: BrowserAgentContextStore;
  private readonly agentContextQueue = new SerialQueue();
  private agentContextId: string | null = null;
  private agentContextBrowserKnown = false;
  private agentContextPolicyKnown = false;
  private pendingAgentBrowser: BrowserProduct | null = null;
  private pendingAgentPolicyMode: BrowserActionPolicyMode | null = null;
  private closing = false;

  constructor(
    private readonly config: Stage5BrowserConfig,
    options: BrowserSupervisorOptions = {},
  ) {
    this.workerUrl = options.workerUrl ?? new URL('../browser-worker.js', import.meta.url);
    this.environment = options.environment ?? process.env;
    this.expectedBuildFingerprint = options.expectedBuildFingerprint ?? null;
    this.runtimeInfoProvider = options.runtimeInfoProvider;
    this.operations = new OperationRegistry(config.artifactsDir);
    this.selectedBrowser = config.browser;
    this.agentContextStore = new BrowserAgentContextStore(config.profilesDir);
  }

  get pendingOperationCount(): number {
    return this.queue.pendingCount;
  }

  get workerRuntimeInfo(): RuntimeProcessInfo | null {
    return this.workerRuntime;
  }
}

function installOperations(prototype: object, operations: Readonly<Record<string, unknown>>): void {
  for (const [name, implementation] of Object.entries(operations)) {
    Object.defineProperty(prototype, name, { configurable: true, enumerable: false, value: implementation, writable: true });
  }
}

for (const operations of [
  executeOperations,
  workerLifecycleOperations,
  transportOperations,
  policyOperations,
  agentContextOperations,
]) installOperations(BrowserSupervisor.prototype, operations);
