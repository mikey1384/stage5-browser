import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { BROWSER_ACTION_POLICY_MODES, PRIVATE_FIELD_VALUE_TYPES } from '../protocol.js';
import { safelyCurrent as safelyCurrentOperation, safelySupervised as safelySupervisedOperation, type McpHostContext } from './context.js';
import { MCP_TOOL_NAMES as TOOL } from './tool-names.js';

export function registerBrowserLifecycleTools(server: McpServer, context: McpHostContext): void {
  const { config, supervisor } = context;
  const { operationIdSchema, frameIdSchema, urlExpectationSchema, privateFieldTargetSchema } = context.schemas;
  const safelyCurrent = <T>(operation: () => Promise<T>) => safelyCurrentOperation(context, operation);
  const safelySupervised = <T>(operation: () => Promise<T>) => safelySupervisedOperation(context, operation);
  server.registerTool(
    TOOL.browserPolicyStatus,
    {
      title: 'Browser action policy status',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safelyCurrent(() => supervisor.execute('policyStatus', {})),
  );

  server.registerTool(
    TOOL.browserSetPolicy,
    {
      title: 'Set optional application review policy',
      inputSchema: z.object({ mode: z.enum(BROWSER_ACTION_POLICY_MODES) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('setPolicy', input)),
  );

  server.registerTool(
    TOOL.browserAuthStatus,
    {
      title: 'Private handoff status',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safelyCurrent(() => supervisor.execute('authStatus', {})),
  );

  server.registerTool(
    TOOL.browserPrivateFieldStatus,
    {
      title: 'Field-scoped private handoff status',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safelyCurrent(() => supervisor.execute('privateFieldStatus', {})),
  );

  server.registerTool(
    TOOL.browserRequestPrivateFieldHandoff,
    {
      title: 'Hand one exact private field to the user',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        target: privateFieldTargetSchema,
        valueType: z.enum(PRIVATE_FIELD_VALUE_TYPES),
        frameId: frameIdSchema,
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('requestPrivateFieldHandoff', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserResumePrivateFieldHandoff,
    {
      title: 'Resume after exact private field input',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        handoffId: z.string().regex(/^private-field-[0-9a-f-]{36}$/u),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('resumePrivateFieldHandoff', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserRequestLoginHandoff,
    {
      title: 'Request private user handoff',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        url: z.string().min(1).nullable().default(null),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.navigationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('requestLoginHandoff', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserResumeAfterLogin,
    {
      title: 'Resume after private interaction',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        expected: urlExpectationSchema.nullable().default(null),
        timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('resumeAfterLogin', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserRecover,
    {
      title: 'Recover browser worker',
      inputSchema: z.object({
        operationId: operationIdSchema.optional(),
        reopenLastUrl: z.boolean().default(true),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operationId, reopenLastUrl }) => safelyCurrent(
      () => supervisor.forceRecover(reopenLastUrl, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserStop,
    {
      title: 'Stop dedicated browser',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safelySupervised(() => supervisor.execute('stop', {})),
  );
}
