import * as z from 'zod/v4';

import type { Stage5BrowserConfig } from '../config.js';
import { BROWSER_ACTION_INTENTS, BROWSER_DIALOG_RESPONSES, BROWSER_DIALOG_TYPES, SUPPORTED_ARIA_ROLES, SUPPORTED_BROWSER_KEYS, URL_MATCH_MODES } from '../protocol.js';

export function createMcpSchemas(config: Stage5BrowserConfig) {
  const loungeIdPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;
  const loungeMessageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const operationIdSchema = z.uuid();
  const actionIntentSchema = z.enum(BROWSER_ACTION_INTENTS).default('unclassified');

  const frameIdSchema = z.string().min(1).max(100).nullable().default(null);
  const tabIdSchema = z.string().regex(/^tab-[A-Za-z0-9_-]+$/u).max(100);
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
  const dialogResponseSchema = z.object({
    type: z.enum(BROWSER_DIALOG_TYPES),
    response: z.enum(BROWSER_DIALOG_RESPONSES),
    promptText: z.string().max(1_000).optional(),
  }).refine(
    (value) => value.promptText === undefined || (value.type === 'prompt' && value.response === 'accept'),
    { message: 'promptText is valid only when accepting an expected prompt dialog.' },
  );
  const clickPostconditionSchema = z.object({
    expectedUrl: urlExpectationSchema.nullable().default(null),
    expectedNewPageUrl: urlExpectationSchema.nullable().default(null),
    expectedDownload: z.boolean().default(false),
    expectedSelected: z.boolean().nullable().default(null),
    expectedVisible: visibleElementExpectationSchema.nullable().default(null),
    expectedHidden: visibleElementExpectationSchema.nullable().default(null),
    satisfaction: z.enum(['all', 'any']).default('all'),
    timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  }).refine(
    (value) =>
      value.expectedUrl !== null ||
      value.expectedNewPageUrl !== null ||
      value.expectedDownload ||
      value.expectedSelected !== null ||
      value.expectedVisible !== null ||
      value.expectedHidden !== null,
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
    operationId: operationIdSchema.optional(),
    role: z.enum(SUPPORTED_ARIA_ROLES),
    name: z.string().min(1),
    exact: z.boolean().default(true),
    frameId: frameIdSchema,
    postcondition: clickPostconditionSchema.nullable().default(null),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    intent: actionIntentSchema,
    dialogResponse: dialogResponseSchema.nullable().default(null),
  }).refine(
    (value) => value.postcondition === null || value.postcondition.timeoutMs <= value.timeoutMs,
    { message: 'The postcondition timeout must not exceed the overall click timeout.' },
  );

  const clickRefInputSchema = z.object({
    operationId: operationIdSchema.optional(),
    snapshotId: z.string().min(1).max(100),
    ref: z.string().regex(/^[A-Za-z0-9_-]+$/).max(100),
    frameId: frameIdSchema,
    postcondition: clickPostconditionSchema.nullable().default(null),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    intent: actionIntentSchema,
    dialogResponse: dialogResponseSchema.nullable().default(null),
  }).refine(
    (value) => value.postcondition === null || value.postcondition.timeoutMs <= value.timeoutMs,
    { message: 'The postcondition timeout must not exceed the overall click timeout.' },
  );
  const setInputFilesInputSchema = z.object({
    operationId: operationIdSchema.optional(),
    snapshotId: z.string().min(1).max(100),
    ref: z.string().regex(/^[A-Za-z0-9_-]+$/).max(100),
    paths: z.array(z.string().min(1).max(4_096)).min(1).max(10),
    frameId: frameIdSchema,
    completion: fileProcessingExpectationSchema.nullable().default(null),
    observationMs: z.number().int().min(0).max(5_000).default(1_000),
    previewDepth: z.number().int().min(1).max(20).default(8),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    dialogResponse: dialogResponseSchema.nullable().default(null),
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
  const controlTargetSchema = z.object({
    role: z.enum(SUPPORTED_ARIA_ROLES),
    name: z.string().min(1).max(500),
    exact: z.boolean().default(true),
  });
  const controlOptionTargetSchema = z.object({
    name: z.string().min(1).max(500),
    exact: z.boolean().default(true),
  });
  const inspectControlInputSchema = z.object({
    operationId: operationIdSchema.optional(),
    control: controlTargetSchema,
    popupAssociation: z.discriminatedUnion('owner', [
      z.object({
        owner: z.literal('requested_control'),
        basis: z.literal('agent_semantic_judgment'),
      }),
      z.object({
        owner: z.literal('observed_candidate'),
        ownerCandidateId: z.string()
          .regex(/^popup-owner-candidate-[0-9a-f-]{36}$/u)
          .max(100),
        basis: z.literal('agent_semantic_judgment'),
      }),
    ]).nullable().default(null),
    frameId: frameIdSchema,
    revealOptions: z.boolean().default(true),
    maxOptions: z.number().int().min(1).max(200).default(100),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    dialogResponse: dialogResponseSchema.nullable().default(null),
  });
  const selectOptionInputSchema = z.object({
    operationId: operationIdSchema.optional(),
    inspectionId: z.string().regex(/^control-[0-9a-f-]{36}$/u).nullable().default(null),
    optionId: z.string().regex(/^option-[0-9a-f-]{36}$/u).nullable().default(null),
    control: controlTargetSchema.nullable().default(null),
    option: controlOptionTargetSchema.nullable().default(null),
    selected: z.boolean().default(true),
    frameId: frameIdSchema,
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    intent: actionIntentSchema,
    dialogResponse: dialogResponseSchema.nullable().default(null),
  }).refine(
    (value) => (value.inspectionId !== null && value.optionId !== null && value.control === null && value.option === null) ||
      (value.inspectionId === null && value.optionId === null && value.control !== null && value.option !== null),
    { message: 'Supply either inspectionId plus optionId, or one exact control plus option target.' },
  );
  const selectOptionsInputSchema = z.object({
    operationId: operationIdSchema.optional(),
    inspectionId: z.string().regex(/^control-[0-9a-f-]{36}$/u).nullable().default(null),
    optionIds: z.array(z.string().regex(/^option-[0-9a-f-]{36}$/u)).min(1).max(20).nullable().default(null),
    control: controlTargetSchema.nullable().default(null),
    options: z.array(controlOptionTargetSchema).min(1).max(20).nullable().default(null),
    frameId: frameIdSchema,
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    intent: actionIntentSchema,
    dialogResponse: dialogResponseSchema.nullable().default(null),
  }).refine(
    (value) => (value.inspectionId !== null && value.optionIds !== null && value.control === null && value.options === null) ||
      (value.inspectionId === null && value.optionIds === null && value.control !== null && value.options !== null),
    { message: 'Supply either inspectionId plus optionIds, or one exact control plus option targets.' },
  );
  const motionTargetSchema = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('role'),
      role: z.enum(SUPPORTED_ARIA_ROLES),
      name: z.string().min(1).max(500),
      exact: z.boolean().default(true),
    }),
    z.object({
      kind: z.literal('ref'),
      snapshotId: z.string().min(1).max(100),
      ref: z.string().regex(/^[A-Za-z0-9_-]+$/u).max(100),
    }),
  ]);
  const browserMotionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('hover'), target: motionTargetSchema }),
    z.object({ kind: z.literal('focus'), target: motionTargetSchema }),
    z.object({ kind: z.literal('double_click'), target: motionTargetSchema }),
    z.object({ kind: z.literal('context_click'), target: motionTargetSchema }),
    z.object({ kind: z.literal('press'), target: motionTargetSchema, key: z.enum(SUPPORTED_BROWSER_KEYS) }),
    z.object({ kind: z.literal('drag'), source: motionTargetSchema, destination: motionTargetSchema }),
  ]);
  const motionInputSchema = z.object({
    operationId: operationIdSchema.optional(),
    motion: browserMotionSchema,
    frameId: frameIdSchema,
    postcondition: clickPostconditionSchema.nullable().default(null),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    intent: actionIntentSchema,
    dialogResponse: dialogResponseSchema.nullable().default(null),
  }).refine(
    (value) => value.postcondition === null || value.postcondition.timeoutMs <= value.timeoutMs,
    { message: 'The postcondition timeout must not exceed the overall motion timeout.' },
  );
  const formFieldIdSchema = z.string().regex(/^field-[0-9a-f-]{36}$/u);
  const formIdSchema = z.string().regex(/^form-[0-9a-f-]{36}$/u);
  const formPlanStepSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fill'), fieldId: formFieldIdSchema, value: z.string() }),
    z.object({ kind: z.literal('select'), fieldId: formFieldIdSchema, option: controlOptionTargetSchema }),
    z.object({ kind: z.literal('set_checked'), fieldId: formFieldIdSchema, checked: z.boolean() }),
  ]);
  const applyFormPlanInputSchema = z.object({
    operationId: operationIdSchema.optional(),
    formId: formIdSchema,
    frameId: frameIdSchema,
    steps: z.array(formPlanStepSchema).min(1).max(20),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    intent: actionIntentSchema,
    dialogResponse: dialogResponseSchema.nullable().default(null),
  });
  const setCheckedInputSchema = z.object({
    operationId: operationIdSchema.optional(),
    formId: formIdSchema.nullable().default(null),
    fieldId: formFieldIdSchema.nullable().default(null),
    control: controlTargetSchema.nullable().default(null),
    checked: z.boolean(),
    frameId: frameIdSchema,
    timeoutMs: z.number().int().min(1_000).max(60_000).default(config.operationTimeoutMs),
    intent: actionIntentSchema,
    dialogResponse: dialogResponseSchema.nullable().default(null),
  }).refine(
    (value) => (value.formId !== null && value.fieldId !== null && value.control === null) ||
      (value.formId === null && value.fieldId === null && value.control !== null),
    { message: 'Supply either formId plus fieldId, or one exact semantic control.' },
  );
  const privateFieldTargetSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('form_field'), formId: formIdSchema, fieldId: formFieldIdSchema }),
    z.object({ kind: z.literal('control'), control: controlTargetSchema }),
  ]);

  return {
    loungeIdPattern,
    loungeMessageIdPattern,
    operationIdSchema,
    actionIntentSchema,
    frameIdSchema,
    tabIdSchema,
    urlExpectationSchema,
    visibleElementExpectationSchema,
    dialogResponseSchema,
    clickPostconditionSchema,
    fileProcessingExpectationSchema,
    clickByRoleInputSchema,
    clickRefInputSchema,
    setInputFilesInputSchema,
    scrollWaitSchema,
    scrollTargetSchema,
    controlTargetSchema,
    controlOptionTargetSchema,
    inspectControlInputSchema,
    selectOptionInputSchema,
    selectOptionsInputSchema,
    motionTargetSchema,
    browserMotionSchema,
    motionInputSchema,
    formFieldIdSchema,
    formIdSchema,
    formPlanStepSchema,
    applyFormPlanInputSchema,
    setCheckedInputSchema,
    privateFieldTargetSchema,
  };
}

export type McpSchemas = ReturnType<typeof createMcpSchemas>;
