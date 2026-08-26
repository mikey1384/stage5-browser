import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { SUPPORTED_BROWSER_PRODUCTS } from '../browser-provider.js';
import { errorResult, hostRuntimeInfo, safely as safelyOperation, safelyCurrent as safelyCurrentOperation, safelySupervised as safelySupervisedOperation, type McpHostContext } from './context.js';
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
      description:
        'Read the in-flight or terminal state of a previously reserved operationId without dispatching or replaying browser input. Full terminal results are retained only briefly in this MCP host and returned only when includeResult=true; durable history contains sanitized metadata only. Caller delivery cannot be observed, so responseCreatedAt is the final host-side boundary.',
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
    async ({ operationId, includeResult }) => safely(async () => {
      const operation = await supervisor.operationStatus(operationId, includeResult);
      return { found: operation !== null, operation };
    }),
  );

  server.registerTool(
    TOOL.browserPageEvents,
    {
      title: 'Inspect durable page lifecycle events',
      description: 'Return a bounded privacy-sanitized durable stream of observed pages, actual new-document replacements, and closes. A document replacement or close carries all_unsaved_form_state_may_be_lost; same-document history/hash changes are excluded by document time-origin continuity. Events contain no title, content, form value, query, fragment, or raw document identity and survive compatible worker replacement.',
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
      description: 'Report MCP/build freshness, worker build, dedicated browser context, tabs, actual runtime profile when observable, controller state, profile-lock ownership state, and current recovery state. A stopped controller may still report a profile owned externally or awaiting release. A stale build reports restartRequired without starting a worker.',
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
      description:
        'Preflight every supported backend without launching one. Separately reports runtime installation and whether each isolated profile is startable, already owned, safely recoverable, busy in another live Stage5 session, or externally owned, with an exact safe next action.',
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
    TOOL.browserSwitch,
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
    TOOL.browserOpen,
    {
      title: 'Open URL',
      description:
        'Navigate using commit-first semantics, then run bounded DOM-readiness and client-redirect stabilization phases. Reports the final URL, observed URLs, server redirect chain, and structured non-2xx warnings. Only HTTP(S) and about:blank are accepted.',
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
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('open', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserTabs,
    {
      title: 'List browser tabs',
      description: 'List all live tabs, assign each a session-scoped opaque tabId, and identify the controller-selected tab. Prefer tabId over the positional index whenever duplicate URL/title tabs or page churn exist. Auxiliary pages do not replace a valid selected tab; when that tab disappears and exactly one live page remains, the sole page becomes active. Unavailable while the private human authentication browser owns the profile.',
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
      description:
        'Return privacy-minimized records for downloads captured by the dedicated browser. Records use opaque IDs, sequence cursors, generic state, byte size, extension, and a randomized private artifact path; source filenames and failure text are never exposed. The sanitized manifest survives compatible worker replacement. This only observes downloads—it never clicks or retries a trigger.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
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
      description:
        'Return bounded durable evidence for JavaScript alert, confirm, prompt, and beforeunload dialogs without exposing their messages or prompt values. Unexpected dialogs are dismissed fail-closed so they cannot deadlock the serialized browser hand. To answer an intended dialog, supply one exact action-scoped dialogResponse on the triggering click, motion, open, or history-navigation operation; private prompt values require field/private handoff instead.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
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
      description:
        'Wait read-only for any dedicated-browser download with a sequence greater than a cursor returned by browser_downloads. It never dispatches or replays the action that may trigger a download. A timeout returns observed=false and the current sanitized records rather than claiming the trigger failed.',
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
      description: 'Make one existing controlled tab active through the fresh session-scoped opaque tabId returned by browser_tabs so duplicate URL/title pages and index drift cannot redirect selection. Stage5 Browser never falls back to URL, title, or positional index. Unavailable while the private human authentication browser owns the profile.',
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
      description: 'Run one bounded exact-page activation reconciliation for the controller-selected tab. It requires the intended renderer to be visible and focused; when native Chromium recovery was necessary, it also requires the verified Stage5-owned application to be frontmost. It never selects by URL, title, index, application name, or unverified process and dispatches no element input.',
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
      description: 'Capture one ref-free semantic document view from the exact session-scoped opaque tabId returned by browser_tabs without exposing element/frame action capabilities. The default is strictly passive and never selects or activates the tab. When no modal is visible, Stage5 may append at most three novel visible outermost article/standalone-quotation details at depth 20 and 30,000 total characters; every ref is stripped and no handle or action capability is retained. For a hidden renderer whose dynamic content cannot advance, temporaryActivation=true may bring only that exact tab forward inside the already controlled browser and optionally wait for bounded generic content-growth/loading-disappearance evidence. The legacy article-growth count includes outermost standalone quotations, while exact generic loading-text leaves require a complete bounded scan. If that exact renderer becomes hidden during the wait, Stage5 may bring it forward once more; a second loss, failed recovery, or hidden semantic-capture boundary fails with zero element input. It then restores and proves the prior exact controller-selected tab before returning. It does not call Stage5\'s native application-activation path or change the controller selection, and it never falls back to URL, title, or index. A stale identity or unproven restoration fails closed. A visible modal may suppress underlying application content and is reported explicitly—never close or dismiss preserved state merely to expose it.',
      inputSchema: z.object({
        tabId: tabIdSchema,
        depth: z.number().int().min(1).max(20).default(8),
        temporaryActivation: z.boolean().default(false),
        waitFor: scrollWaitSchema.nullable().default(null),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
      }).refine(
        (value) => value.waitFor === null || value.temporaryActivation,
        { message: 'A tab content wait requires temporaryActivation=true.' },
      ).refine(
        (value) => !value.temporaryActivation || value.timeoutMs >= 2_000,
        { message: 'Temporary tab activation requires at least a 2,000 ms overall timeout so restoration time remains reserved.' },
      ).refine(
        (value) => value.waitFor === null || value.waitFor.timeoutMs <= value.timeoutMs,
        { message: 'The tab content-wait timeout must not exceed the overall inspection timeout.' },
      ),
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
    TOOL.browserSnapshot,
    {
      title: 'Semantic page snapshot',
      description:
        'Return a bounded AI-oriented ARIA snapshot plus a snapshotId, observed references, hidden file inputs, and nested vertical scroll-container candidates. A unique visible dialog/modal becomes the snapshot root so portal controls are not omitted by surrounding document depth; ambiguous modals fail back to the document with a warning. Click, file-input, and scroll-container references are exact document-bound capabilities for their corresponding tools.',
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
    TOOL.browserScreenshot,
    {
      title: 'Capture page screenshot',
      description: 'Activate and explicitly capture the selected page to the private artifacts directory, then return the PNG plus privacy-safe artifact evidence. A suspiciously uniform artifact with semantic page content receives one bounded recapture; inspect the returned source path before treating a managed image-rendering failure as a black page.',
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
}
