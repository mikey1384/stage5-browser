#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { SUPPORTED_BROWSER_PRODUCTS } from './browser-provider.js';
import { loadConfig } from './config.js';
import { serializeUnknownError } from './errors.js';
import { SUPPORTED_ARIA_ROLES, URL_MATCH_MODES } from './protocol.js';
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
  runtimeInfoProvider: () => runtimeMonitor.inspect(),
});

const frameIdSchema = z.string().min(1).max(100).nullable().default(null);
const urlExpectationSchema = z.object({
  url: z.string().min(1),
  match: z.enum(URL_MATCH_MODES).default('exact'),
});
const visibleElementExpectationSchema = z.object({
  role: z.enum(SUPPORTED_ARIA_ROLES),
  name: z.string().min(1),
  exact: z.boolean().default(true),
  frameId: frameIdSchema,
});
const clickPostconditionSchema = z.object({
  expectedUrl: urlExpectationSchema.nullable().default(null),
  expectedSelected: z.boolean().nullable().default(null),
  expectedVisible: visibleElementExpectationSchema.nullable().default(null),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
}).refine(
  (value) =>
    value.expectedUrl !== null ||
    value.expectedSelected !== null ||
    value.expectedVisible !== null,
  { message: 'At least one click postcondition must be supplied.' },
);

const clickByRoleInputSchema = z.object({
  role: z.enum(SUPPORTED_ARIA_ROLES),
  name: z.string().min(1),
  exact: z.boolean().default(true),
  frameId: frameIdSchema,
  postcondition: clickPostconditionSchema.nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
}).refine(
  (value) => value.postcondition === null || value.postcondition.timeoutMs <= value.timeoutMs,
  { message: 'The postcondition timeout must not exceed the overall click timeout.' },
);

const clickRefInputSchema = z.object({
  snapshotId: z.string().min(1).max(100),
  ref: z.string().regex(/^[A-Za-z0-9_-]+$/).max(100),
  frameId: frameIdSchema,
  postcondition: clickPostconditionSchema.nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
}).refine(
  (value) => value.postcondition === null || value.postcondition.timeoutMs <= value.timeoutMs,
  { message: 'The postcondition timeout must not exceed the overall click timeout.' },
);

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
        'Use this local browser only when an API or CLI cannot complete the task. Begin with browser_status and browser_available. Compatible runtime fixes load automatically; stop browser work only if browser_status reports restartRequired, which means the MCP tool or worker protocol contract changed. Use browser_diagnostics after any launch or interaction failure and follow its sanitized evidence rather than blind retrying. Use browser_start for a stopped profile or browser_switch only when replacing a running profile. Each browser has its own isolated persistent profile: browser storage survives agent restarts but never comes from the user\'s everyday browser or another backend. Use browser_auth_status and the request/resume login handoff for sign-in; explicitly select the intended backend and never ask the user to send credentials or OTPs to the agent. The request handoff releases Playwright and launches a private native browser without automation flags, returning the real application name, exact profile binding, and a label matching its Stage5 marker tab. While state is awaiting_user, do not call browser-control, recovery, or stop tools. The user must quit that exact browser application normally so its process exits before resume; on macOS, use Cmd-Q in the named application because closing only a tab or window may leave it running. Never force-close it, delete profile locks, or rewrite shutdown preferences. On resume, reject a bare-origin URL expectation, inspect the actual runtime profile plus the after-human, after-controlled-start, and after-target-load storage checkpoints, then inspect the bounded verification preview and verify signed-in state with a fresh full snapshot. Storage continuity and automation correlation are evidence, not proof of authentication or causality. A unique visible modal is automatically used as the snapshot root so portal controls are not lost to document depth. Call browser_frames before targeting embedded applications and pass only an observed frameId. Inspect with semantic snapshots before acting. Use browser_click_ref only with the latest snapshotId and a ref from that exact snapshot. Use click postconditions for requested state changes, browser_wait_for_url for deferred redirects, and structured navigation warnings instead of blind retries. Never guess between ambiguous targets. Consequential actions are not retried automatically after a timeout.',
    },
  );

  server.registerTool(
    'browser_status',
    {
      title: 'Browser status',
      description: 'Report MCP/build freshness, worker build, dedicated browser context, tabs, actual runtime profile when observable, and current recovery state. A stale build reports restartRequired without starting a worker.',
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
        'Report MCP/worker build freshness, selected executable preflight, isolated-profile writability and lock state, launch sandbox policy, automation exposure, and sanitized page console/network/action diagnostics including successful requests around the last click. Raw messages, exception text, URL queries/fragments, headers, bodies, and full launch arguments are excluded.',
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
        'Navigate using commit-first semantics, then run bounded DOM-readiness and client-redirect stabilization phases. Reports the final URL, observed URLs, server redirect chain, and structured non-2xx warnings. Only HTTP(S) and about:blank are accepted.',
      inputSchema: z.object({
        url: z.string().min(1),
        newTab: z.boolean().default(false),
        stabilizationMs: z.number().int().min(0).max(5_000).default(750),
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
      description: 'List all live tabs and identify the actually visible one when uniquely observable. Unavailable while the private human authentication browser owns the profile.',
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
      description: 'Make an existing controlled tab active by the exact index returned by browser_tabs. Unavailable while the private human authentication browser owns the profile.',
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
        'Return a bounded AI-oriented ARIA snapshot plus a snapshotId and observed references. A unique visible dialog/modal becomes the snapshot root so portal controls are not omitted by surrounding document depth; ambiguous modals fail back to the document with a warning. References are document-bound and may be used once with browser_click_ref.',
      inputSchema: z.object({
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
        'Click exactly one element matched by ARIA role and accessible name. Fails instead of choosing an ambiguous match. Optional postconditions distinguish a dispatched click from a successful state change; failures record sanitized visibility, enabled-state, viewport, and pointer-interception evidence.',
      inputSchema: clickByRoleInputSchema,
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
    'browser_click_ref',
    {
      title: 'Click observed snapshot reference',
      description:
        'Click one Playwright reference from the latest semantic snapshot of the same document and frame. Stale, unknown, reused, or no-longer-unique references fail closed. Optional postconditions verify the requested state change; failures record sanitized actionability evidence.',
      inputSchema: clickRefInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('clickRef', input)),
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
        frameId: frameIdSchema,
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
    'browser_scroll',
    {
      title: 'Scroll active document',
      description:
        'Perform bounded viewport or document scrolling in the main document or an observed frame. Reports before/after position, content growth, end detection, and unchanged-position guidance for nested scroll containers.',
      inputSchema: z.object({
        direction: z.enum(['up', 'down']).default('down'),
        amount: z.enum(['half_viewport', 'viewport', 'document_start', 'document_end']).default('viewport'),
        count: z.number().int().min(1).max(20).default(1),
        settleMs: z.number().int().min(0).max(5_000).default(750),
        frameId: frameIdSchema,
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('scroll', input)),
  );

  server.registerTool(
    'browser_find_text',
    {
      title: 'Find rendered page text',
      description:
        'Search bounded rendered body text in the main document or an observed frame. Returns line-numbered snippets and truncation metadata without exposing arbitrary script evaluation.',
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
    'browser_wait_for_url',
    {
      title: 'Wait for expected URL',
      description:
        'Wait for the active page URL to exactly match, start with, or contain a bounded expected string. On timeout, reports a sanitized current URL and does not retry the preceding action.',
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

  server.registerTool(
    'browser_auth_status',
    {
      title: 'Authentication handoff status',
      description:
        'Report the dedicated persistent profile, actual runtime profile when observable, exact executable/profile binding, native application and handoff label, control mode, private native-process state, unambiguous clean-shutdown evidence, three-phase privacy-safe storage continuity, and verification lifecycle. Authentication remains unknown until an agent verifies site-specific signed-in state.',
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
    'browser_request_login_handoff',
    {
      title: 'Request user login handoff',
      description:
        'Optionally navigate the controlled isolated profile to a login URL, close Playwright cleanly, and launch the same exact executable/profile binding as a native browser without Playwright, remote debugging, or automation flags. A static Stage5 marker tab plus the returned real application name and short label identify the correct window. The user authenticates privately and quits that exact browser application normally so its process exits. Browser tools remain unavailable during this handoff; credentials, passkeys, CAPTCHAs, and OTPs stay out of agent messages and logs.',
      inputSchema: z.object({
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
    async (input) => safelyCurrent(() => supervisor.execute('requestLoginHandoff', input)),
  );

  server.registerTool(
    'browser_resume_after_login',
    {
      title: 'Resume after user login',
      description:
        'After the private native browser exits, require zero profile locks and the exact executable/profile identity. A zero process exit with no signal permits reattachment even if Chromium retains a stale crashed marker; marker value and modification time are compared with the pre-handoff snapshot. An abnormal or unavailable exit offers one explicit second-call override only while the process is gone and locks are clear. Resume rejects origin-only auth URL expectations, reports the actual Chromium runtime profile, and compares privacy-safe target-origin cookie-key presence after human exit, after controlled start, and after target load. It classifies the observed loss boundary and automation correlation without claiming causality, removes the Stage5 marker, and returns a bounded semantic preview. Returns AUTH_NOT_PERSISTED on verified loss or when human-added metadata cannot reach a supplied non-root post-login route. Cookie values are never inspected. Visible site state still requires a fresh full semantic snapshot.',
      inputSchema: z.object({
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
    async (input) => safelyCurrent(() => supervisor.execute('resumeAfterLogin', input)),
  );

  server.registerTool(
    'browser_recover',
    {
      title: 'Recover browser worker',
      description:
        'Recover only the owned worker process group, then optionally reopen the last sanitized browser URL. Refuses recovery while the private human authentication browser owns the profile. The result distinguishes worker recovery from browser recovery; a stopped browser is reported as worker_recovered_browser_stopped. This cannot refresh a stale MCP build or tool catalog.',
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
      description: 'Close the controlled dedicated browser context while leaving the lightweight MCP worker available. Refuses to force-close a running private human authentication browser.',
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
