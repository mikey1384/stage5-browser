import { loadConfig, type Stage5BrowserConfig } from '../config.js';
import { serializeUnknownError } from '../errors.js';
import { LoungeService } from '../lounge-service.js';
import { BrowserSupervisor, SupervisedOperationError } from '../supervisor.js';
import { buildStampUrlFor, MCP_TOOL_COUNT, RuntimeArtifactMonitor, TOOL_CATALOG_VERSION } from '../runtime-info.js';
import { createMcpSchemas, type McpSchemas } from './schemas.js';
import { shapeMcpResult } from './result-shaping.js';

export interface McpHostContext {
  config: Stage5BrowserConfig;
  runtimeMonitor: RuntimeArtifactMonitor;
  supervisor: BrowserSupervisor;
  lounge: LoungeService;
  schemas: McpSchemas;
}

export function createMcpHostContext(moduleUrl: string): McpHostContext {
  const config = loadConfig();
  const runtimeMonitor = new RuntimeArtifactMonitor('mcp', buildStampUrlFor(moduleUrl));
  return {
    config,
    runtimeMonitor,
    supervisor: new BrowserSupervisor(config, {
      expectedBuildFingerprint: runtimeMonitor.inspect().artifactFingerprint,
      runtimeInfoProvider: () => runtimeMonitor.inspect(),
    }),
    lounge: new LoungeService(),
    schemas: createMcpSchemas(config),
  };
}

export function hostRuntimeInfo(context: McpHostContext) {
  return {
    ...context.runtimeMonitor.inspect(),
    toolCatalogVersion: TOOL_CATALOG_VERSION,
    toolCount: MCP_TOOL_COUNT,
  };
}

export function textResult(value: unknown) {
  const { structuredContent, text } = shapeMcpResult(value);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent,
  };
}

export function errorResult(error: unknown) {
  const serialized = serializeUnknownError(error);
  const structuredContent = {
    error: serialized,
    ...(error instanceof SupervisedOperationError
      ? { operationId: error.operationId, recovery: error.recovery }
      : {}),
  };
  const shaped = shapeMcpResult(structuredContent);
  return {
    content: [{ type: 'text' as const, text: shaped.text }],
    structuredContent: shaped.structuredContent,
    isError: true as const,
  };
}

export async function safely<T>(operation: () => Promise<T>) {
  try {
    return textResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

export async function safelySupervised<T>(
  context: McpHostContext,
  operation: () => Promise<T>,
  requireCurrentContract = false,
) {
  try {
    if (requireCurrentContract) context.runtimeMonitor.assertCurrent();
    const value = await operation();
    const operationId = typeof value === 'object' && value !== null
      ? (value as { operationId?: unknown }).operationId
      : null;
    if (typeof operationId === 'string') {
      await context.supervisor.markOperationResponseCreated(operationId);
    }
    return textResult(value);
  } catch (error) {
    if (error instanceof SupervisedOperationError) {
      await context.supervisor.markOperationResponseCreated(error.operationId);
    }
    return errorResult(error);
  }
}

export async function safelyCurrent<T>(context: McpHostContext, operation: () => Promise<T>) {
  return safelySupervised(context, operation, true);
}
