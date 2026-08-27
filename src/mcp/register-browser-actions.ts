import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { RESERVABLE_OPERATION_COMMANDS } from '../operations/types.js';
import { BROWSER_HISTORY_ACTIONS, SCROLL_DIRECTIONS, SUPPORTED_ARIA_ROLES } from '../protocol.js';
import { safely as safelyOperation, safelyCurrent as safelyCurrentOperation, type McpHostContext } from './context.js';
import { MCP_TOOL_NAMES as TOOL } from './tool-names.js';

export function registerBrowserActionTools(server: McpServer, context: McpHostContext): void {
  const { config, supervisor } = context;
  const { operationIdSchema, frameIdSchema, tabIdSchema, urlExpectationSchema, visibleElementExpectationSchema, clickByRoleInputSchema, clickRefInputSchema, setInputFilesInputSchema, scrollWaitSchema, scrollTargetSchema, inspectControlInputSchema, selectOptionInputSchema, selectOptionsInputSchema, motionInputSchema, applyFormPlanInputSchema, setCheckedInputSchema, dialogResponseSchema } = context.schemas;
  const safely = <T>(operation: () => Promise<T>) => safelyOperation(operation);
  const safelyCurrent = <T>(operation: () => Promise<T>) => safelyCurrentOperation(context, operation);
  server.registerTool(
    TOOL.browserReserveOperation,
    {
      title: 'Reserve recoverable browser operation',
      description:
        'Reserve a short-lived operationId for one exact consequential browser command before dispatch. Pass that ID to the matching command so browser_operation_status can recover its in-flight or terminal state without replay. A reservation carries no browser authority and cannot be reused or changed to another command.',
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
      description:
        'Click exactly one element matched by ARIA role and accessible name through the same guarded exact-target engine used by browser_click_ref. One absolute deadline covers resolution, preparation, activation, dispatch, fallback, postcondition, and evidence finalization. A zero match receives a bounded transition wait, then reports explicit false dispatch evidence; the tool never attributes earlier or autonomous UI changes to that miss. It fails instead of choosing an ambiguous match. If the selected renderer becomes hidden after target preparation and the guard proves zero input, Stage5 may discard that handle, activate and settle once, and resolve the unique role target again before the only dispatch; another activation loss or any ambiguity fails closed. Pointer interception remains blocking for pointer transports and null-postcondition actions; only a native HTML button with a supplied bounded postcondition may proceed through its guarded keyboard transport while covered, with exact trusted-event and effect reconciliation still required. Supply a bounded postcondition for every state-changing control, including popup/select/menu openers: expectedSelected also covers accessible expanded state, while expectedHidden proves one exact semantic element became absent or uniquely hidden without returning its name. A null postcondition cannot reconcile partial keyboard input. If partial exact-target input produces the requested postcondition, Stage5 returns that terminal success with truthful partial dispatch evidence and never replays.',
      inputSchema: clickByRoleInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('clickByRole', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserClickRef,
    {
      title: 'Click observed snapshot reference',
      description:
        'Click one reference from the latest semantic snapshot of the same document and frame through the shared role/ref exact-target engine. One absolute deadline covers viewport preparation, activation, normal dispatch, guarded fallback, postcondition, and evidence finalization. A fresh offscreen ref receives bounded incremental nested/document scrolling while retaining the exact DOM node. If feed virtualization detaches it, only one uniquely proven same-article semantic replacement may be rebound before actionability revalidation. If the selected renderer becomes hidden after target preparation and the guard proves zero input, Stage5 may discard that handle, activate and settle once, and resolve only the same unique snapshot semantic inside the retained scope before the only dispatch; another activation loss, scope change, or ambiguity fails closed. Exact-target dispatch records sanitized page-activation and trusted-event evidence. Pointer hit testing prefers the clipped visible center and otherwise one bounded alternate point that still hits only the exact target or its proven light/shadow/slotted composed-tree descendant; the position is freshly revalidated for handle input and never exposed. Pointer interception remains blocking for pointer transports and null-postcondition actions; only a native HTML button with a supplied bounded postcondition may proceed through its guarded keyboard transport while covered, with exact trusted-event and effect reconciliation still required. One guarded forced attempt is allowed only after a normal attempt with zero input events and unchanged full actionability; if both handle paths emit zero events, one guarded page-level mouse dispatch may use the freshly revalidated exact main-frame point. Supply a bounded postcondition for every state-changing control, including popup/select/menu openers; a null postcondition cannot reconcile partial keyboard input. Partial input is never replayed; when its requested postcondition is already observed, that effect becomes the terminal success while click evidence remains truthful. expectedHidden proves one exact semantic element became absent or uniquely hidden without returning its name. Stale, reused, changed, inactive-page, cross-frame, uncertain, or ambiguous references otherwise fail closed.',
      inputSchema: clickRefInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('clickRef', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserSetInputFiles,
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
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('setInputFiles', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserFillByRole,
    {
      title: 'Fill unique semantic field',
      description:
        'Fill exactly one field matched by ARIA role and accessible name through the shared phased fill engine. Declare the semantic intent so optional review mode can rely on agent judgment without inspecting the label. A bounded read-only transition wait and one post-activation re-resolution are allowed only before input. Standard HTML date fields reject non-ISO input with expected YYYY-MM-DD before dispatch. The supplied value is never written to the operation journal.',
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
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('fillByRole', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserFillRef,
    {
      title: 'Fill observed textbox reference',
      description:
        'Fill one textbox, textarea, or contenteditable through a ref from the latest semantic snapshot of the same document, frame, and modal scope. Declare the semantic intent so optional review mode can rely on agent judgment without inspecting page text. This supports active unnamed editors without inventing an accessible name. The one-use capability is consumed on every attempted fill. Stage5 revalidates and pins the exact target through one bounded preparation/activation/dispatch/evidence deadline, keeps the value out of journals and evidence, and returns only definite input/change and exact logical value-match booleans. Failures report the sanitized fill phase and target/input evidence before the supervisor deadline. A matching value is the privacy-safe postcondition; partial input is never replayed.',
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
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('fillRef', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserFormSummary,
    {
      title: 'Inspect redacted form state',
      description:
        'Return one bounded whole-form inventory from the active document or unique modal: exact opaque field capabilities, structural field kinds, labels, required/disabled/read-only/valid facts, selected state, redacted empty/present state, native option labels, and visible actions. Field values are never returned; password values are not inspected even for presence. Use the result to plan only the genuinely missing or ambiguous work instead of repeatedly scanning the full page.',
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
      description:
        'Consume one fresh form summary and apply up to 20 exact text/date, native-select, and checked-state steps under the form workflow manager. Declare the most consequential semantic intent of the complete plan so optional review mode can use agent judgment without label or URL inference. Every field motion has its own observe/preflight/prepare/dispatch/reconcile phases; completed steps are never replayed, failures identify the exact stopped step and prior privacy-safe results, and a changed document stops the workflow. Private/password fields are hard-blocked for field-scoped handoff, while custom popup controls remain under browser_select_option.',
      inputSchema: applyFormPlanInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('applyFormPlan', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserSetChecked,
    {
      title: 'Set exact checkbox, radio, or switch state',
      description:
        'Idempotently set one exact checkbox, radio, or switch from a fresh form capability or exact semantic control. Declare its semantic intent so optional review mode can distinguish ordinary form editing from terms acceptance, account changes, or other consequential meaning without inspecting labels. It observes current checked state first, dispatches nothing when already satisfied, otherwise performs one exact click with a checked-state postcondition, and never toggles again after possible input. Clearing a radio fails for agent choice of the intended alternative.',
      inputSchema: setCheckedInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('setChecked', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserInspectControl,
    {
      title: 'Inspect one form control and its options',
      description:
        'Inspect one exact native or ARIA popup control and return bounded privacy-safe option semantics plus one-use opaque capabilities. By default Stage5 autonomously reveals a closed custom popup once with a structural expanded/popup postcondition, then scrolls only its exact popup surface to discover rendered or virtualized choices. An opener that may have received input is never replayed. When one already-open popup has several structurally tied current owner candidates, Stage5 returns their role/name evidence with zero input; if the requested control is in that exact bounded set, the agent may make one explicit popupAssociation semantic judgment in a fresh passive inspection. That judgment cannot override a stale document, missing target, competing resolved owner, multiple popup surfaces, authority boundary, or possible-input no-replay state. The returned choice boundary belongs to the agent: use judgment within existing user authority and involve the user only when the meanings materially change the requested outcome.',
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
      description:
        'Set one exact option selected or unselected in a native select or associated custom popup; selected defaults to true for compatibility. Declare its semantic intent so optional review mode can distinguish ordinary form editing from an account or financial change without interpreting labels. Use inspectionId plus optionId after browser_inspect_control, or pass an exact semantic control and option directly when the intended label is already known. Deselect requires authoritative selected=true evidence and independently toggleable multi-select semantics. Stage5 handles popup reveal, bounded option-surface scrolling, exact binding, one dispatch gate, and authoritative desired-state reconciliation. It never guesses among duplicate meanings, toggles unknown state, or replays possible input.',
      inputSchema: selectOptionInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('selectOption', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserSelectOptions,
    {
      title: 'Select exact options in one multi-select control',
      description:
        'Ensure one or more exact options are selected in a native or ARIA multi-select control. Declare the most consequential semantic intent of the selection set so optional review mode can use agent judgment without interpreting labels. Use one inspectionId plus optionIds, or an exact control plus option targets. Stage5 verifies multi-select semantics before option input, treats already-selected choices as satisfied without toggling them, refreshes structural capabilities between custom-control movements, and stops at the first unconfirmed outcome without replaying possible input.',
      inputSchema: selectOptionsInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('selectOptions', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserNavigateHistory,
    {
      title: 'Navigate browser history or reload',
      description:
        'Perform one bounded back, forward, or reload transition on the exact controller-selected tab. The navigation manager invalidates ephemeral refs before dispatch, records whether the main frame actually navigated, reconciles DOM readiness and an optional URL postcondition, and never replays an ambiguous transition. Use browser_open for an explicit URL or new tab.',
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
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('navigateHistory', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserCloseTab,
    {
      title: 'Close one exact observed tab',
      description:
        'Close exactly one live tab through its fresh session-scoped opaque tabId. This never falls back to title, URL, index, or another page, does not run beforeunload handlers, and reports the remaining exact tabs plus the reconciled controller selection. Closing may discard unsaved page state; use it only for the intended agent-owned tab.',
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
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('closeTab', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserMotion,
    {
      title: 'Perform one exact composable browser motion',
      description:
        'Perform one exact hover, focus, bounded non-text key press, or source-to-destination drag against a unique semantic target or a ref from the latest snapshot. This is the generic movement vocabulary for unfamiliar widgets: bind exact targets, run one dispatch gate, capture trusted focus/hover/key/pointer/drag/drop evidence, reconcile an optional semantic or URL postcondition, and never replay possible input. Drag endpoints must belong to the same frame; coordinates remain internal. Use fill tools for text and click/select tools when their stronger specialized evidence applies.',
      inputSchema: motionInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, ...input }) => safelyCurrent(
      () => supervisor.execute('motion', input, undefined, operationId),
    ),
  );

  server.registerTool(
    TOOL.browserScroll,
    {
      title: 'Scroll observed surface',
      description:
        'Perform bounded vertical or horizontal viewport/document scrolling on the frame document or one nested scroll container observed by the latest semantic snapshot. Container refs are exact, document-bound, and consumed once; selectors are never guessed. The selected renderer must be visible before every step, and one observation root stays pinned throughout an optional article-shaped semantic-content/loading-indicator wait. The legacy article-growth count includes outermost standalone quotations without double-counting nested quotations. Exact generic loading-text leaves count only through a bounded scan, and their disappearance is authoritative only while that scan remains complete. Reports sub-pixel-tolerant target geometry separately from a confirmed semantic end, exposes nested-container candidates, and correlates bounded network activity through browser_diagnostics.',
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
    TOOL.browserWaitForUrl,
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
}
