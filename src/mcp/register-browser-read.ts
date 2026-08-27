import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { SUPPORTED_BROWSER_PRODUCTS } from '../browser-provider.js';
import { BROWSER_COMMAND_CONTRACTS, type BrowserCommandName } from '../protocol.js';
import {
  errorResult,
  hostRuntimeInfo,
  safely as safelyOperation,
  safelyCurrent as safelyCurrentOperation,
  safelySupervised as safelySupervisedOperation,
  type McpHostContext,
} from './context.js';
import { MCP_TOOL_NAMES as TOOL } from './tool-names.js';

export function registerBrowserReadTools(server: McpServer, context: McpHostContext): void {
  const { config, runtimeMonitor, supervisor } = context;
  const { operationIdSchema, frameIdSchema, tabIdSchema, scrollWaitSchema, dialogResponseSchema } = context.schemas;
  const mcpRuntimeInfo = () => hostRuntimeInfo(context);
  const safely = <T>(operation: () => Promise<T>) => safelyOperation(operation);
  const safelyCurrent = <T>(operation: () => Promise<T>) => safelyCurrentOperation(context, operation);
  const safelySupervised = <T>(operation: () => Promise<T>) => safelySupervisedOperation(context, operation);
  server.registerTool(
    TOOL.browserOperationStatus,
    {
      title: 'Recover browser operation status',
      inputSchema: z.object({
        operationId: operationIdSchema,
        includeResult: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operationId, includeResult }) =>
      safely(async () => {
        const operation = await supervisor.operationStatus(operationId, includeResult);
        return { found: operation !== null, operation };
      }),
  );

  server.registerTool(
    TOOL.browserExecutionTraces,
    {
      title: 'Inspect privacy-safe browser execution traces',
      inputSchema: z.object({
        operationId: operationIdSchema.nullable().default(null),
        agentId: z.string().min(1).max(80).nullable().default(null),
        command: z.string().min(1).max(80).refine(
          (value) => value === 'recover' || value in BROWSER_COMMAND_CONTRACTS,
          { message: 'Unknown browser worker command.' },
        ).transform((value) => value as BrowserCommandName | 'recover').nullable().default(null),
        outcome: z.enum(['succeeded', 'failed', 'timed_out']).nullable().default(null),
        detail: z.enum(['summary', 'full']).default('summary'),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operationId, agentId, command, outcome, detail, limit }) => safely(() =>
      supervisor.executionTraces(operationId, limit, { agentId, command, outcome, detail })),
  );

  server.registerTool(
    TOOL.browserPageEvents,
    {
      title: 'Inspect durable page lifecycle events',
      inputSchema: z.object({
        afterSequence: z.number().int().min(0).nullable().default(null),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('pageEvents', input)),
  );

  server.registerTool(
    TOOL.browserStatus,
    {
      title: 'Browser status',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      safelySupervised(async () => {
        const mcp = mcpRuntimeInfo();
        if (mcp.restartRequired) {
          return {
            operationId: null,
            recovery: 'not_needed' as const,
            result: null,
            mcp,
            worker: supervisor.workerRuntimeInfo,
          };
        }
        const outcome = await supervisor.execute('status', {});
        return { ...outcome, mcp, worker: supervisor.workerRuntimeInfo };
      }),
  );

  server.registerTool(
    TOOL.browserAvailable,
    {
      title: 'Available browsers',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safelyCurrent(() => supervisor.execute('availableBrowsers', {})),
  );

  server.registerTool(
    TOOL.browserDiagnostics,
    {
      title: 'Browser diagnostics',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      safelySupervised(async () => {
        const mcp = mcpRuntimeInfo();
        if (mcp.restartRequired) {
          return {
            operationId: null,
            recovery: 'not_needed' as const,
            result: null,
            mcp,
            worker: supervisor.workerRuntimeInfo,
            diagnostic: {
              reason: 'mcp_restart_required',
              suggestedAction: mcp.suggestedAction,
            },
          };
        }
        const outcome = await supervisor.execute('diagnostics', {});
        return { ...outcome, mcp, worker: outcome.result.worker };
      }),
  );

  server.registerTool(
    TOOL.browserStart,
    {
      title: 'Start dedicated browser',
      inputSchema: z.object({
        browser: z.enum(SUPPORTED_BROWSER_PRODUCTS).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ browser }) => safelyCurrent(() => supervisor.execute('start', browser === undefined ? {} : { browser })),
  );

  server.registerTool(
    TOOL.browserSwitch,
    {
      title: 'Switch isolated browser',
      inputSchema: z.object({ browser: z.enum(SUPPORTED_BROWSER_PRODUCTS) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('switchBrowser', input)),
  );

  server.registerTool(
    TOOL.browserOpen,
    {
      title: 'Open URL',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        url: z.string().min(1),
        newTab: z.boolean().default(false),
        stabilizationMs: z.number().int().min(0).max(5_000).default(750),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.navigationTimeoutMs),
        dialogResponse: dialogResponseSchema.nullable().default(null),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(() => supervisor.execute('open', input, undefined, operationId)),
  );

  server.registerTool(
    TOOL.browserTabs,
    {
      title: 'List browser tabs',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safelyCurrent(() => supervisor.execute('tabs', {})),
  );

  server.registerTool(
    TOOL.browserDownloads,
    {
      title: 'List captured downloads',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(100),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('downloads', input)),
  );

  server.registerTool(
    TOOL.browserDialogStatus,
    {
      title: 'Inspect sanitized browser dialog history',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('dialogStatus', input)),
  );

  server.registerTool(
    TOOL.browserWaitForDownload,
    {
      title: 'Wait for a captured download',
      inputSchema: z.object({
        afterSequence: z.number().int().min(0),
        timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('waitForDownload', input)),
  );

  server.registerTool(
    TOOL.browserSelectTab,
    {
      title: 'Select browser tab',
      inputSchema: z.object({ tabId: tabIdSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('selectTab', input)),
  );

  server.registerTool(
    TOOL.browserActivateSelectedPage,
    {
      title: 'Activate and prove the selected page',
      inputSchema: z.object({
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('activateSelectedPage', input)),
  );

  server.registerTool(
    TOOL.browserInspectTab,
    {
      title: 'Inspect exact tab with bounded activation policy',
      inputSchema: z
        .object({
          tabId: tabIdSchema,
          depth: z.number().int().min(1).max(20).default(8),
          temporaryActivation: z.boolean().default(false),
          waitFor: scrollWaitSchema.nullable().default(null),
          timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
        })
        .refine((value) => value.waitFor === null || value.temporaryActivation, { message: 'A tab content wait requires temporaryActivation=true.' })
        .refine((value) => !value.temporaryActivation || value.timeoutMs >= 2_000, {
          message: 'Temporary tab activation requires at least a 2,000 ms overall timeout so restoration time remains reserved.',
        })
        .refine((value) => value.waitFor === null || value.waitFor.timeoutMs <= value.timeoutMs, {
          message: 'The tab content-wait timeout must not exceed the overall inspection timeout.',
        }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('inspectTab', input)),
  );

  server.registerTool(
    TOOL.browserFrames,
    {
      title: 'List page frames',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => safelyCurrent(() => supervisor.execute('frames', {})),
  );

  server.registerTool(
    TOOL.browserSnapshot,
    {
      title: 'Semantic page snapshot',
      inputSchema: z.object({
        view: z.enum(['task', 'full']).default('task'),
        depth: z.number().int().min(1).max(20).default(8),
        boxes: z.boolean().default(false),
        frameId: frameIdSchema,
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('snapshot', input)),
  );

  server.registerTool(
    TOOL.browserScreenshot,
    {
      title: 'Capture page screenshot',
      inputSchema: z.object({
        fullPage: z.boolean().default(false),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        runtimeMonitor.assertCurrent();
        const outcome = await supervisor.execute('screenshot', input);
        const { dataBase64, ...screenshot } = outcome.result;
        const structuredContent = {
          operationId: outcome.operationId,
          recovery: outcome.recovery,
          result: screenshot,
        };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(structuredContent, null, 2),
            },
            {
              type: 'image' as const,
              data: dataBase64,
              mimeType: outcome.result.mimeType,
            },
          ],
          structuredContent,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
