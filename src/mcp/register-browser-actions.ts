import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { RESERVABLE_OPERATION_COMMANDS } from '../operations/types.js';
import { BROWSER_HISTORY_ACTIONS, SCROLL_DIRECTIONS, SUPPORTED_ARIA_ROLES } from '../protocol.js';
import { safely as safelyOperation, safelyCurrent as safelyCurrentOperation, safelyCurrentAction as safelyCurrentActionOperation, type McpHostContext } from './context.js';
import type { CompactActionCommand } from './action-result.js';
import { MCP_TOOL_NAMES as TOOL } from './tool-names.js';

export function registerBrowserActionTools(server: McpServer, context: McpHostContext): void {
  const { config, supervisor } = context;
  const { operationIdSchema, frameIdSchema, tabIdSchema, urlExpectationSchema, visibleElementExpectationSchema, clickByRoleInputSchema, clickRefInputSchema, setInputFilesInputSchema, scrollWaitSchema, scrollTargetSchema, inspectControlInputSchema, selectOptionInputSchema, selectOptionsInputSchema, motionInputSchema, applyFormPlanInputSchema, setCheckedInputSchema, dialogResponseSchema } = context.schemas;
  const safely = <T>(operation: () => Promise<T>) => safelyOperation(operation);
  const safelyCurrent = <T>(operation: () => Promise<T>) => safelyCurrentOperation(context, operation);
  const safelyCurrentAction = <T>(command: CompactActionCommand, operation: () => Promise<T>) =>
    safelyCurrentActionOperation(context, command, operation);
  server.registerTool(
    TOOL.browserReserveOperation,
    {
      title: 'Reserve recoverable browser operation',
      inputSchema: z.object({ command: z.enum(RESERVABLE_OPERATION_COMMANDS) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ command }) => safely(async () => supervisor.reserveOperation(command)),
  );

  server.registerTool(
    TOOL.browserClickByRole,
    {
      title: 'Click unique semantic target',
      inputSchema: clickByRoleInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('clickByRole',
      () => supervisor.execute('clickByRole', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserClickRef,
    {
      title: 'Click observed snapshot reference',
      inputSchema: clickRefInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('clickRef',
      () => supervisor.execute('clickRef', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserSetInputFiles,
    {
      title: 'Set observed file input',
      inputSchema: setInputFilesInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('setInputFiles', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserFillByRole,
    {
      title: 'Fill unique semantic field',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        role: z.enum(SUPPORTED_ARIA_ROLES),
        name: z.string().min(1),
        exact: z.boolean().default(true),
        frameId: frameIdSchema,
        value: z.string(),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
        intent: context.schemas.actionIntentSchema,
        dialogResponse: dialogResponseSchema.nullable().default(null),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('fillByRole',
      () => supervisor.execute('fillByRole', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserFillRef,
    {
      title: 'Fill observed textbox reference',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        snapshotId: z.string().min(1).max(100),
        ref: z.string().regex(/^[A-Za-z0-9_-]+$/).max(100),
        frameId: frameIdSchema,
        value: z.string(),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
        intent: context.schemas.actionIntentSchema,
        dialogResponse: dialogResponseSchema.nullable().default(null),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('fillRef',
      () => supervisor.execute('fillRef', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserFormSummary,
    {
      title: 'Inspect redacted form state',
      inputSchema: z.object({
        frameId: frameIdSchema,
        maxFields: z.number().int().min(1).max(200).default(100),
        maxActions: z.number().int().min(1).max(100).default(50),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
        dialogResponse: dialogResponseSchema.nullable().default(null),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('formSummary', input)),
  );

  server.registerTool(
    TOOL.browserApplyFormPlan,
    {
      title: 'Apply a staged exact form plan',
      inputSchema: applyFormPlanInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('applyFormPlan',
      () => supervisor.execute('applyFormPlan', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserSetChecked,
    {
      title: 'Set exact checkbox, radio, or switch state',
      inputSchema: setCheckedInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('setChecked',
      () => supervisor.execute('setChecked', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserInspectControl,
    {
      title: 'Inspect one form control and its options',
      inputSchema: inspectControlInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('inspectControl', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserSelectOption,
    {
      title: 'Set one exact form option state',
      inputSchema: selectOptionInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('selectOption',
      () => supervisor.execute('selectOption', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserSelectOptions,
    {
      title: 'Select exact options in one multi-select control',
      inputSchema: selectOptionsInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('selectOptions',
      () => supervisor.execute('selectOptions', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserNavigateHistory,
    {
      title: 'Navigate browser history or reload',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        action: z.enum(BROWSER_HISTORY_ACTIONS),
        expectedUrl: urlExpectationSchema.nullable().default(null),
        dialogResponse: dialogResponseSchema.nullable().default(null),
        stabilizationMs: z.number().int().min(0).max(5_000).default(500),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.navigationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('navigateHistory',
      () => supervisor.execute('navigateHistory', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserCloseTab,
    {
      title: 'Close one exact observed tab',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        tabId: tabIdSchema,
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('closeTab',
      () => supervisor.execute('closeTab', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserMotion,
    {
      title: 'Perform one exact composable browser motion',
      inputSchema: motionInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrentAction('motion',
      () => supervisor.execute('motion', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserScroll,
    {
      title: 'Scroll observed surface',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        direction: z.enum(SCROLL_DIRECTIONS).default('down'),
        amount: z.enum(['half_viewport', 'viewport', 'document_start', 'document_end']).default('viewport'),
        count: z.number().int().min(1).max(20).default(1),
        settleMs: z.number().int().min(0).max(5_000).default(750),
        frameId: frameIdSchema,
        endMarker: visibleElementExpectationSchema.nullable().default(null),
        target: scrollTargetSchema.nullable().default(null),
        waitFor: scrollWaitSchema.nullable().default(null),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
        dialogResponse: dialogResponseSchema.nullable().default(null),
      }).refine(
        (value) => value.waitFor === null || value.waitFor.timeoutMs <= value.timeoutMs,
        { message: 'The content-wait timeout must not exceed the overall scroll timeout.' },
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('scroll', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserFindText,
    {
      title: 'Find rendered page text',
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        mode: z.enum(['contains', 'exact_line']).default('contains'),
        caseSensitive: z.boolean().default(false),
        maxResults: z.number().int().min(1).max(100).default(20),
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
    async (input) => safelyCurrent(() => supervisor.execute('findText', input)),
  );

  server.registerTool(
    TOOL.browserWaitForUrl,
    {
      title: 'Wait for expected URL',
      inputSchema: z.object({
        expected: urlExpectationSchema,
        timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('waitForUrl', input)),
  );
}
