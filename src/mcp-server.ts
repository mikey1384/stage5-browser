#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { loadConfig } from './config.js';
import { serializeUnknownError } from './errors.js';
import { SUPPORTED_ARIA_ROLES } from './protocol.js';
import { BrowserSupervisor, SupervisedOperationError } from './supervisor.js';

const config = loadConfig();
const supervisor = new BrowserSupervisor(config);

function textResult(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function errorResult(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const serialized = serializeUnknownError(error);
  const structuredContent = {
    error: serialized,
    ...(error instanceof SupervisedOperationError
      ? { operationId: error.operationId, recovery: error.recovery }
      : {}),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true,
  };
}

async function safely<T>(operation: () => Promise<T>): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  try {
    return textResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'stage5-browser', version: '0.1.0' },
    {
      instructions:
        'Use this local browser only when an API or CLI cannot complete the task. Inspect with semantic snapshots before acting. Never guess between ambiguous targets. Consequential actions are not retried automatically after a timeout.',
    },
  );

  server.registerTool(
    'browser_status',
    {
      title: 'Browser status',
      description: 'Report the owned worker, dedicated browser context, tabs, and current recovery state.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safely(() => supervisor.execute('status', {})),
  );

  server.registerTool(
    'browser_start',
    {
      title: 'Start dedicated browser',
      description: 'Start the isolated Stage5 Browser profile and return its initial tab state.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safely(() => supervisor.execute('start', {})),
  );

  server.registerTool(
    'browser_open',
    {
      title: 'Open URL',
      description:
        'Navigate using commit-first semantics, then run a separately bounded DOM-readiness probe. Only HTTP(S) and about:blank are accepted.',
      inputSchema: z.object({
        url: z.string().min(1),
        newTab: z.boolean().default(false),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.navigationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safely(() => supervisor.execute('open', input)),
  );

  server.registerTool(
    'browser_tabs',
    {
      title: 'List browser tabs',
      description: 'List all live tabs and identify the active one.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safely(() => supervisor.execute('tabs', {})),
  );

  server.registerTool(
    'browser_select_tab',
    {
      title: 'Select browser tab',
      description: 'Make an existing tab active by the exact index returned by browser_tabs.',
      inputSchema: z.object({ index: z.number().int().min(0) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safely(() => supervisor.execute('selectTab', input)),
  );

  server.registerTool(
    'browser_snapshot',
    {
      title: 'Semantic page snapshot',
      description: 'Return a bounded AI-oriented ARIA snapshot of the active page for reliable targeting.',
      inputSchema: z.object({
        depth: z.number().int().min(1).max(20).default(8),
        boxes: z.boolean().default(false),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => safely(() => supervisor.execute('snapshot', input)),
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Capture page screenshot',
      description: 'Explicitly capture the active page to the private artifacts directory and return the PNG.',
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
        const outcome = await supervisor.execute('screenshot', input);
        const { dataBase64, ...screenshot } = outcome.result;
        const structuredContent = {
          operationId: outcome.operationId,
          recovery: outcome.recovery,
          result: screenshot,
        };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) },
            { type: 'image' as const, data: dataBase64, mimeType: outcome.result.mimeType },
          ],
          structuredContent,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'browser_click_by_role',
    {
      title: 'Click unique semantic target',
      description:
        'Click exactly one element matched by ARIA role and accessible name. Fails instead of choosing an ambiguous match.',
      inputSchema: z.object({
        role: z.enum(SUPPORTED_ARIA_ROLES),
        name: z.string().min(1),
        exact: z.boolean().default(true),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safely(() => supervisor.execute('clickByRole', input)),
  );

  server.registerTool(
    'browser_fill_by_role',
    {
      title: 'Fill unique semantic field',
      description:
        'Fill exactly one field matched by ARIA role and accessible name. The supplied value is never written to the operation journal.',
      inputSchema: z.object({
        role: z.enum(SUPPORTED_ARIA_ROLES),
        name: z.string().min(1),
        exact: z.boolean().default(true),
        value: z.string(),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safely(() => supervisor.execute('fillByRole', input)),
  );

  server.registerTool(
    'browser_recover',
    {
      title: 'Recover browser worker',
      description:
        'Kill the owned worker process group, start a clean worker, and optionally reopen the last sanitized browser URL.',
      inputSchema: z.object({ reopenLastUrl: z.boolean().default(true) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reopenLastUrl }) => safely(() => supervisor.forceRecover(reopenLastUrl)),
  );

  server.registerTool(
    'browser_stop',
    {
      title: 'Stop dedicated browser',
      description: 'Close the dedicated browser context while leaving the lightweight MCP worker available.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safely(() => supervisor.execute('stop', {})),
  );

  return server;
}

const handle = serveStdio(createServer, {
  onerror: (error) => {
    process.stderr.write(`Stage5 Browser MCP transport error: ${error.name}\n`);
  },
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await supervisor.close();
  await handle.close();
}

process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
process.once('beforeExit', () => {
  void supervisor.close();
});
process.stdin.once('end', () => {
  void shutdown();
});
process.stdin.once('close', () => {
  void shutdown();
});
