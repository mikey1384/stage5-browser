import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { LOUNGE_MESSAGE_KINDS, LOUNGE_WORK_NOTE_LIMITS } from '../lounge-types.js';
import { safely as safelyOperation, type McpHostContext } from './context.js';
import { MCP_TOOL_NAMES as TOOL } from './tool-names.js';

export function registerLoungeTools(server: McpServer, context: McpHostContext): void {
  const { lounge } = context;
  const { loungeIdPattern, loungeMessageIdPattern } = context.schemas;
  const safely = <T>(operation: () => Promise<T>) => safelyOperation(operation);
  server.registerTool(
    TOOL.loungeJoin,
    {
      title: 'Join Agent Lounge',
      inputSchema: z.object({
        agentId: z.string().regex(loungeIdPattern),
        displayName: z.string().min(1).max(80).optional(),
        provider: z.string().min(1).max(40).optional(),
        room: z.string().regex(loungeIdPattern).default('stage5-lounge'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safely(async () => {
      const joined = await lounge.join({
        agentId: input.agentId,
        room: input.room,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
      });
      const browserContext = await context.supervisor.bindAgentContext(input.agentId);
      return { ...joined, browserContext };
    }),
  );

  server.registerTool(
    TOOL.loungeSend,
    {
      title: 'Send Lounge message',
      inputSchema: z.object({
        to: z.array(z.string().regex(loungeIdPattern)).min(1).max(20).optional(),
        kind: z.enum(LOUNGE_MESSAGE_KINDS).default('message'),
        body: z.string().min(1).max(12_000),
        replyTo: z.string().regex(loungeMessageIdPattern).nullable().default(null),
        taskKey: z.string().min(1).max(120).nullable().default(null),
        idempotencyKey: z.string().min(1).max(120),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safely(() => lounge.send({
      kind: input.kind,
      body: input.body,
      replyTo: input.replyTo,
      taskKey: input.taskKey,
      idempotencyKey: input.idempotencyKey,
      ...(input.to === undefined ? {} : { to: input.to }),
    })),
  );

  server.registerTool(
    TOOL.loungeWait,
    {
      title: 'Wait online in Agent Lounge',
      inputSchema: z.object({
        timeoutMs: z.number().int().min(100).max(55_000).default(50_000),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) => safely(() => lounge.wait(input, context.mcpReq.signal)),
  );

  server.registerTool(
    TOOL.loungeAck,
    {
      title: 'Acknowledge Lounge messages',
      inputSchema: z.object({
        messageIds: z.array(z.string().regex(loungeMessageIdPattern)).min(1).max(50),
        state: z.enum(['seen', 'acted']),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safely(() => lounge.ack(input)),
  );

  server.registerTool(
    TOOL.loungeStatus,
    {
      title: 'Agent Lounge status',
      inputSchema: z.object({
        detail: z.enum(['compact', 'full']).default('compact'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ detail }) => safely(() => lounge.status(detail)),
  );

  server.registerTool(
    TOOL.loungeSetWorkNote,
    {
      title: 'Set durable Agent Lounge work note',
      inputSchema: z.object({
        note: z.object({
          role: z.string().min(1).max(LOUNGE_WORK_NOTE_LIMITS.role),
          currentState: z.string().min(1).max(LOUNGE_WORK_NOTE_LIMITS.currentState),
          lastCompleted: z.string().min(1).max(LOUNGE_WORK_NOTE_LIMITS.lastCompleted).nullable().default(null),
          blocker: z.string().min(1).max(LOUNGE_WORK_NOTE_LIMITS.blocker).nullable().default(null),
          nextSafeAction: z.string().min(1).max(LOUNGE_WORK_NOTE_LIMITS.nextSafeAction),
        }),
        expectedRevision: z.number().int().min(0),
        idempotencyKey: z.string().min(1).max(120),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safely(() => lounge.setWorkNote(input)),
  );

  server.registerTool(
    TOOL.loungePin,
    {
      title: 'Set Agent Lounge pinned notice',
      inputSchema: z.object({
        body: z.string().min(1).max(4_000).nullable(),
        expectedRevision: z.number().int().min(0),
        idempotencyKey: z.string().min(1).max(120),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safely(() => lounge.pin(input)),
  );

  server.registerTool(
    TOOL.loungeHistory,
    {
      title: 'Read audited Agent Lounge history',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(50),
        beforeSequence: z.number().int().min(1).nullable().default(null),
        afterSequence: z.number().int().min(1).nullable().default(null),
      }).refine(
        (input) => input.beforeSequence === null || input.afterSequence === null,
        { message: 'beforeSequence and afterSequence are mutually exclusive.' },
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => safely(() => lounge.history(input)),
  );
}
