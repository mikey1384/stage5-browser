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
      description:
        'Report the session-scoped application action policy, including the agent-declared intent classes permitted and blocked in optional review-only mode. Deterministic code never infers business meaning from labels or regexes.',
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
      description:
        'Set normal or review-only action policy for the controlled browser session. Review-only permits observation, navigation, exact private handoff, reversible hover/focus, and mutations whose agent-declared intent is form editing or local validation. Fills, option/check changes, staged plans, clicks, key presses, and pointer motions all require that explicit semantic declaration; Stage5 never infers it from labels, URLs, selectors, or regexes. Uploads, tab close, runtime switches, and consequential intents such as persistence, terms, submission, external communication, account change, and financial transactions fail before dispatch. The mode survives compatible worker replacement.',
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
    TOOL.browserPrivateFieldStatus,
    {
      title: 'Field-scoped private handoff status',
      description:
        'Report whether one exact highlighted private field is currently under user control. This returns only the field label, private value type, opaque handoff identity, and lifecycle state—never the value.',
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
      description:
        'Pause agent browser control while preserving the current unsaved document, highlight and focus one exact visible field, and let the user enter a private value directly. Before calling, obtain action-time user confirmation that names the value type, destination site, and purpose without echoing the value. The user must not save, continue, submit, upload, accept terms, or operate another control. The agent and result never receive the value; all other browser commands, recovery, stop, and navigation remain blocked until exact resume.',
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
      description:
        'Return control after the user completes or leaves unchanged the exact highlighted field. Stage5 removes the highlight and observes only redacted empty/present, selected, validity, and validation-message-presence facts. It never reads or returns the private value, and reports target changes or an already-present replacement as unverifiable rather than inventing completion.',
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
      description:
        'Optionally navigate the isolated profile to the exact screen requiring private user input, then release controlled ownership and launch the same executable/profile binding as a native browser without Playwright automation flags. This supports passwords, passkeys, OTPs, EINs, identity documents, selfies, and KYC—not only login. A static Stage5 marker plus the returned application name and label identify the correct window. A slow Firefox shutdown is retained as close_requested → process_exited → profile_unlocked; call this tool again to resume that same phase rather than relaunching. Follow the returned backend-specific instruction: leave Chromium-family browsers open for same-process attachment; quit Firefox normally for restart-based resume. Private values and documents stay out of agent messages and logs.',
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
      description:
        'Resume the backend-specific private handoff after the user completes the exact private step. Chromium-family browsers must still be running: Stage5 attaches to that exact process over its private loopback channel. Firefox observes process exit and actual profile unlock with the remaining operation budget, retains the phase across timeouts, then restarts the same profile. Resume verifies executable/profile identity, compares privacy-safe target-origin storage continuity when relevant, removes the Stage5 marker, and returns a bounded semantic preview. For an exact non-root authentication URL with no expected query, site-added query metadata is tolerated only when origin, pathname, and fragment still match; an explicitly expected query remains strict. Cookie values, private fields, documents, and exact human interactions are never inspected. Visible site state still requires a fresh full semantic snapshot.',
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
      description:
        'Recover only the owned worker process group, then optionally reopen the last sanitized browser URL. Refuses recovery while the private human authentication browser owns the profile. The result distinguishes worker recovery from browser recovery; a stopped browser is reported as worker_recovered_browser_stopped. This cannot refresh a stale MCP build or tool catalog.',
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
      description: 'Close the controlled dedicated browser context while leaving the lightweight MCP worker available. Refuses to force-close a running private human authentication browser.',
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
