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
const fileProcessingExpectationSchema = z.object({
  expectedComplete: visibleElementExpectationSchema.nullable().default(null),
  expectedError: visibleElementExpectationSchema.nullable().default(null),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
}).refine(
  (value) => value.expectedComplete !== null || value.expectedError !== null,
  { message: 'At least one file-processing completion or error expectation must be supplied.' },
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
const setInputFilesInputSchema = z.object({
  snapshotId: z.string().min(1).max(100),
  ref: z.string().regex(/^[A-Za-z0-9_-]+$/).max(100),
  paths: z.array(z.string().min(1).max(4_096)).min(1).max(10),
  frameId: frameIdSchema,
  completion: fileProcessingExpectationSchema.nullable().default(null),
  observationMs: z.number().int().min(0).max(5_000).default(1_000),
  previewDepth: z.number().int().min(1).max(20).default(8),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
}).refine(
  (value) => value.completion === null || value.completion.timeoutMs <= value.timeoutMs,
  { message: 'The processing expectation timeout must not exceed the overall file-selection timeout.' },
);
const scrollWaitSchema = z.object({
  condition: z.enum(['article_count_growth', 'loading_indicators_disappear', 'either']),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
});
const scrollTargetSchema = z.object({
  snapshotId: z.string().min(1).max(100),
  ref: z.string().regex(/^scroll-[A-Za-z0-9_-]+$/).max(100),
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
        'Both role and snapshot-ref clicks use one exact-target engine and one absolute deadline across target preparation, page activation, normal dispatch, guarded fallback, postcondition, and final evidence capture. Use the returned dispatchEvidence: clicked is confirmed only by a trusted target click; false means no target input was dispatched; unknown means ambiguous and must never be retried automatically. One guarded forced exact-handle attempt is allowed only after the normal attempt emitted zero trusted events and the same node remains fully actionable; if both handle paths emit zero events, one guarded page-level mouse dispatch may target the fresh exact main-frame hit point. Never repeat partial, misdirected, detached, inactive-page, cross-frame, or ambiguous dispatch. ' +
        'Use this local browser only when an API or CLI cannot complete the task. Begin with browser_status and browser_available. browser_available distinguishes installed runtimes from profiles that are startable, already owned, safely recoverable, busy in another Stage5 session, or externally owned; do not trial backends one by one. Every Stage5 launch has a private durable ownership lease with an exact worker/browser start identity and heartbeat. Never delete locks or terminate an owner unless Stage5 reports conclusively proven orphan recovery. Compatible runtime fixes load automatically; stop browser work only if browser_status reports restartRequired, which means the MCP tool or worker protocol contract changed. Use browser_diagnostics after any launch or interaction failure and follow its sanitized evidence rather than blind retrying. Use browser_start for a safely startable or recoverable profile and browser_switch only when replacing a running profile. Each browser has its own isolated persistent profile: browser storage survives agent restarts but never comes from the user\'s everyday browser or another backend. Use browser_auth_status and the request/resume handoff for any private user interaction—not only sign-in—including passwords, passkeys, OTPs, EINs, identity documents, selfies, and KYC. Drive all non-private steps first, surface only the exact private screen, and never ask the user to send private values or documents to the agent. The request handoff releases Playwright and launches a private native browser without automation flags, returning the real application name, exact profile binding, and a label matching its Stage5 marker tab. While state is releasing_control, call browser_request_login_handoff again to resume the retained close → process-exit → profile-unlock phase; never relaunch or switch backends. While state is awaiting_user, do not call browser-control, recovery, or stop tools. Follow the returned backend-specific instruction exactly: Chromium-family browsers stay open so Stage5 can attach to that same process; Firefox must exit normally before restart-based resume. Never force-close the private browser, delete profile locks, or rewrite shutdown preferences. On resume, reject a bare-origin URL expectation, inspect the actual runtime profile and privacy-safe storage continuity when relevant, then inspect the bounded verification preview and verify the resulting site state with a fresh full snapshot. Storage continuity and automation correlation are evidence, not proof of authentication or causality. A unique visible modal is automatically used as the snapshot root so portal controls are not lost to document depth. Call browser_frames before targeting embedded applications and pass only an observed frameId. Inspect with semantic snapshots before acting. A snapshot may expose hidden fileInputs and nested scrollContainers with opaque refs. browser_set_input_files accepts only the latest snapshot capability, transfers explicitly authorized local files without opening a native picker, consumes the ref once, and never claims processing completion without explicit evidence. Its observationMs quick-sampling window is 0–5,000 ms; use a semantic completion timeout of up to 60,000 ms for longer bounded processing checks. browser_scroll may target one latest scrollContainers ref and can wait for article growth, loading-indicator disappearance, or either; loader evidence is limited to the visible selected surface and a stalled or geometric boundary is never proof that an infinite feed ended. Scroll becomes browser_diagnostics.lastAction so bounded network activity can be correlated. Use browser_click_ref only with the latest snapshotId and a ref from that exact snapshot; offscreen refs receive bounded incremental scrolling, retain their exact DOM node, and may rebind after virtualization only to one uniquely proven same-article semantic replacement before actionability revalidation and dispatch. Use click postconditions for requested state changes, browser_wait_for_url for deferred redirects, and structured navigation warnings instead of blind retries. Never guess between ambiguous targets. Consequential actions are not retried automatically after a timeout.',
    },
  );

  server.registerTool(
    'browser_status',
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
      description: 'List all live tabs and identify the controller-selected tab. Auxiliary pages do not replace a valid selected tab; when that tab disappears and exactly one live page remains, the sole page becomes active. Unavailable while the private human authentication browser owns the profile.',
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
    'browser_screenshot',
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

  server.registerTool(
    'browser_click_by_role',
    {
      title: 'Click unique semantic target',
      description:
        'Click exactly one element matched by ARIA role and accessible name through the same guarded exact-target engine used by browser_click_ref. One absolute deadline covers resolution, preparation, activation, dispatch, fallback, postcondition, and evidence finalization. A zero match receives a bounded transition wait, then reports explicit false dispatch evidence; the tool never attributes earlier or autonomous UI changes to that miss. It fails instead of choosing an ambiguous match. Optional postconditions distinguish a confirmed target click from a successful state change.',
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
        'Click one reference from the latest semantic snapshot of the same document and frame through the shared role/ref exact-target engine. One absolute deadline covers viewport preparation, activation, normal dispatch, guarded fallback, postcondition, and evidence finalization. A fresh offscreen ref receives bounded incremental nested/document scrolling while retaining the exact DOM node. If feed virtualization detaches it, only one uniquely proven same-article semantic replacement may be rebound before actionability revalidation. Exact-target dispatch records sanitized page-activation and trusted-event evidence. One guarded forced attempt is allowed only after a normal attempt with zero input events and unchanged full actionability; if both handle paths emit zero events, one guarded page-level mouse dispatch may use the fresh exact main-frame hit point without exposing coordinates. Stale, reused, changed, partial, inactive-page, cross-frame, uncertain, or ambiguous references fail closed.',
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
    'browser_set_input_files',
    {
      title: 'Set observed file input',
      description:
        'Transfer one or more explicitly authorized regular local files into a file input observed in the latest semantic snapshot. Uses a document-bound one-use file-input ref, rejects relative paths, symlinks, directories, stale refs, disabled controls, and unsupported multiple selection, and never opens a native picker. Confirms privacy-minimized file metadata either during the capture-phase input event or from the retained FileList, so sites may safely consume and clear the input. Returns a fresh attachment preview, semantic progress evidence, temporally bounded network error counts, and an explicit unverified state when processing completion cannot be proven. observationMs is a 0–5,000 ms quick-sampling window; use completion.timeoutMs (up to 60,000 ms and no greater than timeoutMs) for a longer semantic completion/error wait. This may immediately start an external upload; never replay it after an ambiguous failure.',
      inputSchema: setInputFilesInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => safelyCurrent(() => supervisor.execute('setInputFiles', input)),
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
      title: 'Scroll observed surface',
      description:
        'Perform bounded viewport or document scrolling on the frame document or on one nested scroll container observed by the latest semantic snapshot. Container refs are exact, document-bound, and consumed once; selectors are never guessed. An optional semantic wait observes article-count growth, loading-indicator disappearance, or either condition. Reports sub-pixel-tolerant target geometry separately from a confirmed semantic end, exposes nested-container candidates, and correlates bounded network activity through browser_diagnostics.',
      inputSchema: z.object({
        direction: z.enum(['up', 'down']).default('down'),
        amount: z.enum(['half_viewport', 'viewport', 'document_start', 'document_end']).default('viewport'),
        count: z.number().int().min(1).max(20).default(1),
        settleMs: z.number().int().min(0).max(5_000).default(750),
        frameId: frameIdSchema,
        endMarker: visibleElementExpectationSchema.nullable().default(null),
        target: scrollTargetSchema.nullable().default(null),
        waitFor: scrollWaitSchema.nullable().default(null),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
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
      title: 'Private handoff status',
      description:
        'Report the dedicated persistent profile, actual runtime profile when observable, exact executable/profile binding, retained release phase, native application and handoff label, control mode, private native-process state, unambiguous clean-shutdown evidence, privacy-safe storage continuity, and verification lifecycle. Authentication remains unknown until an agent verifies site-specific signed-in state.',
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
      title: 'Request private user handoff',
      description:
        'Optionally navigate the isolated profile to the exact screen requiring private user input, then release controlled ownership and launch the same executable/profile binding as a native browser without Playwright automation flags. This supports passwords, passkeys, OTPs, EINs, identity documents, selfies, and KYC—not only login. A static Stage5 marker plus the returned application name and label identify the correct window. A slow Firefox shutdown is retained as close_requested → process_exited → profile_unlocked; call this tool again to resume that same phase rather than relaunching. Follow the returned backend-specific instruction: leave Chromium-family browsers open for same-process attachment; quit Firefox normally for restart-based resume. Private values and documents stay out of agent messages and logs.',
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
      title: 'Resume after private interaction',
      description:
        'Resume the backend-specific private handoff after the user completes the exact private step. Chromium-family browsers must still be running: Stage5 attaches to that exact process over its private loopback channel. Firefox observes process exit and actual profile unlock with the remaining operation budget, retains the phase across timeouts, then restarts the same profile. Resume verifies executable/profile identity, compares privacy-safe target-origin storage continuity when relevant, removes the Stage5 marker, and returns a bounded semantic preview. Cookie values, private fields, documents, and exact human interactions are never inspected. Visible site state still requires a fresh full semantic snapshot.',
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
