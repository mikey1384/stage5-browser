#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { SUPPORTED_BROWSER_PRODUCTS } from './browser-provider.js';
import { loadConfig } from './config.js';
import { serializeUnknownError } from './errors.js';
import { SUPPORTED_ARIA_ROLES } from './protocol.js';
import { BrowserSupervisor, SupervisedOperationError } from './supervisor.js';
import {
  buildStampUrlFor,
  MCP_TOOL_COUNT,
  RuntimeArtifactMonitor,
  STAGE5_BROWSER_VERSION,
  TOOL_CATALOG_VERSION,
} from './runtime-info.js';

const config = loadConfig();
const runtimeMonitor = new RuntimeArtifactMonitor('mcp', buildStampUrlFor(import.meta.url));
const supervisor = new BrowserSupervisor(config, {
  expectedBuildFingerprint: runtimeMonitor.inspect().artifactFingerprint,
});

function mcpRuntimeInfo(): ReturnType<RuntimeArtifactMonitor['inspect']> & {
  toolCatalogVersion: number;
  toolCount: number;
} {
  return {
    ...runtimeMonitor.inspect(),
    toolCatalogVersion: TOOL_CATALOG_VERSION,
    toolCount: MCP_TOOL_COUNT,
  };
}

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

async function safelyCurrent<T>(
  operation: () => Promise<T>,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  return safely(async () => {
    runtimeMonitor.assertCurrent();
    return operation();
  });
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'stage5-browser', version: STAGE5_BROWSER_VERSION },
    {
      instructions:
        'Use this local browser only when an API or CLI cannot complete the task. Begin with browser_status and browser_available. If browser_status reports restartRequired, stop browser work and restart the MCP host; browser_recover cannot refresh an MCP tool catalog. Use browser_diagnostics after any launch failure and follow its safe suggested action rather than blind retrying. Use browser_start for a stopped profile or browser_switch only when replacing a running profile. Each browser has its own isolated persistent profile: authentication survives agent restarts but never comes from the user\'s everyday browser or another backend. Inspect the current page instead of assuming login state; ask the user only for password, passkey, CAPTCHA, or OTP steps that require them, then snapshot again. Call browser_frames before targeting embedded applications and pass only an observed frameId. Inspect with semantic snapshots before acting. Never guess between ambiguous targets. Consequential actions are not retried automatically after a timeout.',
    },
  );

  server.registerTool(
    'browser_status',
    {
      title: 'Browser status',
      description: 'Report MCP/build freshness, worker build, dedicated browser context, tabs, and current recovery state. A stale build reports restartRequired without starting a worker.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      safely(async () => {
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
    'browser_available',
    {
      title: 'Available browsers',
      description:
        'Preflight every supported browser backend without launching one. Reports the current/default browser and whether each isolated profile can be started.',
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
    'browser_diagnostics',
    {
      title: 'Browser diagnostics',
      description:
        'Report MCP/worker build freshness, selected executable preflight, isolated-profile writability and lock state, browser state, and the last sanitized launch-failure category with a suggested action.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      safely(async () => {
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
    'browser_start',
    {
      title: 'Start dedicated browser',
      description:
        'Start the requested isolated persistent browser profile, or the configured default when omitted. Its login state survives agent restarts but is not imported from the user\'s everyday browser. Does not close a different profile that is already running. On failure, use browser_diagnostics instead of retrying blindly.',
      inputSchema: z.object({ browser: z.enum(SUPPORTED_BROWSER_PRODUCTS).optional() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ browser }) =>
      safelyCurrent(() => supervisor.execute('start', browser === undefined ? {} : { browser })),
  );

  server.registerTool(
    'browser_switch',
    {
      title: 'Switch isolated browser',
      description:
        'Preflight and launch the requested browser profile. If another browser is running, close its tabs only after the target is confirmed available.',
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
    async (input) => safelyCurrent(() => supervisor.execute('open', input)),
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
    async () => safelyCurrent(() => supervisor.execute('tabs', {})),
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
    async (input) => safelyCurrent(() => supervisor.execute('selectTab', input)),
  );

  server.registerTool(
    'browser_frames',
    {
      title: 'List page frames',
      description:
        'List stable opaque IDs for the active tab\'s main document and attached frames, including cross-origin frames. Use an observed ID for frame-targeted actions.',
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
    'browser_snapshot',
    {
      title: 'Semantic page snapshot',
      description:
        'Return a bounded AI-oriented ARIA snapshot of the main document or an exact frame ID observed from browser_frames.',
      inputSchema: z.object({
        depth: z.number().int().min(1).max(20).default(8),
        boxes: z.boolean().default(false),
        frameId: z.string().min(1).max(100).nullable().default(null),
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
        frameId: z.string().min(1).max(100).nullable().default(null),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('clickByRole', input)),
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
        frameId: z.string().min(1).max(100).nullable().default(null),
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
    async (input) => safelyCurrent(() => supervisor.execute('fillByRole', input)),
  );

  server.registerTool(
    'browser_recover',
    {
      title: 'Recover browser worker',
      description:
        'Recover only the owned worker process group, then optionally reopen the last sanitized browser URL. The result distinguishes worker recovery from browser recovery; a stopped browser is reported as worker_recovered_browser_stopped. This cannot refresh a stale MCP build or tool catalog.',
      inputSchema: z.object({ reopenLastUrl: z.boolean().default(true) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reopenLastUrl }) => safelyCurrent(() => supervisor.forceRecover(reopenLastUrl)),
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
