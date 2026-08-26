import { Buffer } from 'node:buffer';

export const MAX_MCP_RESULT_BYTES = 24 * 1_024;

interface CompactProfile {
  maxArrayItems: number;
  maxDepth: number;
  maxObjectProperties: number;
  maxStringCharacters: number;
}

interface CompactionState {
  arrayItemsOmitted: number;
  maximumDepthReached: boolean;
  objectPropertiesOmitted: number;
  stringCharactersOmitted: number;
}

export interface ShapedMcpResult {
  structuredContent: Record<string, unknown>;
  text: string;
}

const COMPACT_PROFILES: CompactProfile[] = [
  { maxStringCharacters: 12_000, maxArrayItems: 60, maxObjectProperties: 120, maxDepth: 16 },
  { maxStringCharacters: 6_000, maxArrayItems: 30, maxObjectProperties: 80, maxDepth: 12 },
  { maxStringCharacters: 3_000, maxArrayItems: 15, maxObjectProperties: 50, maxDepth: 10 },
  { maxStringCharacters: 1_200, maxArrayItems: 8, maxObjectProperties: 30, maxDepth: 8 },
  { maxStringCharacters: 600, maxArrayItems: 4, maxObjectProperties: 20, maxDepth: 6 },
];

const PRIORITY_KEYS = [
  'operationId',
  'delivery',
  'outcome',
  'recovery',
  'runtimeTransition',
  'result',
  'error',
  'code',
  'recoverable',
  'message',
  'details',
  'reason',
  'actionDispatched',
  'clickDispatched',
  'actionOutcome',
  'dispatch',
  'postcondition',
  'viewportPreparation',
  'evidence',
  'input',
  'checks',
  'passed',
  'suggestedAction',
  'inspection',
  'page',
  'frame',
  'snapshot',
] as const;

const PRIORITY_INDEX = new Map<string, number>(
  PRIORITY_KEYS.map((key, index) => [key, index]),
);

export function shapeMcpResult(value: unknown): ShapedMcpResult {
  const originalText = printableJson(value);
  const originalBytes = Buffer.byteLength(originalText, 'utf8');
  const ordered = cloneValue(value, null, 0, null, new WeakSet<object>());
  const orderedRecord = resultRecord(ordered);
  const orderedText = printableJson(orderedRecord);
  if (Buffer.byteLength(orderedText, 'utf8') <= MAX_MCP_RESULT_BYTES) {
    return { structuredContent: orderedRecord, text: orderedText };
  }

  for (const profile of COMPACT_PROFILES) {
    const state = emptyCompactionState();
    const compacted = cloneValue(value, profile, 0, state, new WeakSet<object>());
    const shaped = withDelivery(resultRecord(compacted), originalBytes, state);
    const text = printableJson(shaped);
    if (Buffer.byteLength(text, 'utf8') <= MAX_MCP_RESULT_BYTES) {
      return { structuredContent: shaped, text };
    }
  }

  const fallback = withDelivery({
    operationId: operationIdFrom(value),
    error: {
      code: 'OPERATION_FAILED',
      recoverable: true,
      message: 'The complete MCP result exceeded the bounded delivery envelope.',
      details: {
        reason: 'mcp_result_exceeded_delivery_budget',
        actionDispatched: actionConclusionFrom(value, 'actionDispatched'),
        clickDispatched: actionConclusionFrom(value, 'clickDispatched'),
        suggestedAction: 'Use the retained operationId with browser_operation_status when available. Do not replay an action whose dispatch state is true or unknown.',
      },
    },
  }, originalBytes, {
    arrayItemsOmitted: 0,
    maximumDepthReached: true,
    objectPropertiesOmitted: 0,
    stringCharactersOmitted: 0,
  });
  const text = printableJson(fallback);
  return { structuredContent: fallback, text };
}

function cloneValue(
  value: unknown,
  profile: CompactProfile | null,
  depth: number,
  state: CompactionState | null,
  ancestors: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return profile === null ? value : compactString(value, profile.maxStringCharacters, state!);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return null;
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) return '[cyclic reference omitted]';
  if (profile !== null && depth >= profile.maxDepth) {
    state!.maximumDepthReached = true;
    return '[nested result omitted at bounded depth]';
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const indexes = retainedArrayIndexes(value.length, profile?.maxArrayItems ?? value.length);
      if (state !== null) state.arrayItemsOmitted += value.length - indexes.length;
      return indexes.map((index) => cloneValue(value[index], profile, depth + 1, state, ancestors));
    }
    const record = value as Record<string, unknown>;
    const keys = orderedKeys(record);
    const retainedKeys = profile === null ? keys : keys.slice(0, profile.maxObjectProperties);
    if (state !== null) state.objectPropertiesOmitted += keys.length - retainedKeys.length;
    const result: Record<string, unknown> = {};
    for (const key of retainedKeys) {
      if (record[key] === undefined) continue;
      result[key] = cloneValue(record[key], profile, depth + 1, state, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function compactString(value: string, maximum: number, state: CompactionState): string {
  if (value.length <= maximum) return value;
  const marker = `\n…[Stage5 Browser omitted ${value.length - maximum} middle characters; absence cannot be inferred from this bounded result]…\n`;
  const retained = Math.max(0, maximum - marker.length);
  const head = Math.ceil(retained / 2);
  const tail = Math.floor(retained / 2);
  state.stringCharactersOmitted += value.length - retained;
  return `${value.slice(0, head)}${marker}${tail === 0 ? '' : value.slice(-tail)}`;
}

function retainedArrayIndexes(length: number, maximum: number): number[] {
  if (length <= maximum) return Array.from({ length }, (_, index) => index);
  const head = Math.ceil(maximum * 0.75);
  const tail = maximum - head;
  return [
    ...Array.from({ length: head }, (_, index) => index),
    ...Array.from({ length: tail }, (_, index) => length - tail + index),
  ];
}

function orderedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort((left, right) => {
    const leftPriority = PRIORITY_INDEX.get(left) ?? PRIORITY_KEYS.length;
    const rightPriority = PRIORITY_INDEX.get(right) ?? PRIORITY_KEYS.length;
    return leftPriority - rightPriority;
  });
}

function withDelivery(
  record: Record<string, unknown>,
  originalBytes: number,
  state: CompactionState,
): Record<string, unknown> {
  return resultRecord(cloneValue({
    ...record,
    delivery: {
      bounded: true,
      truncated: true,
      maximumBytes: MAX_MCP_RESULT_BYTES,
      originalBytes,
      stringCharactersOmitted: state.stringCharactersOmitted,
      arrayItemsOmitted: state.arrayItemsOmitted,
      objectPropertiesOmitted: state.objectPropertiesOmitted,
      maximumDepthReached: state.maximumDepthReached,
      absenceInferenceAllowed: false,
      suggestedAction: 'Use the priority-first dispatch and postcondition evidence. Treat omitted observation content as unknown, never absent, and do not replay an action with possible dispatch.',
    },
  }, null, 0, null, new WeakSet<object>()));
}

function resultRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { result: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return JSON.stringify({
      error: {
        code: 'OPERATION_FAILED',
        recoverable: false,
        message: 'The MCP result was not JSON serializable.',
      },
    }, null, 2);
  }
}

function emptyCompactionState(): CompactionState {
  return {
    arrayItemsOmitted: 0,
    maximumDepthReached: false,
    objectPropertiesOmitted: 0,
    stringCharactersOmitted: 0,
  };
}

function operationIdFrom(value: unknown): string | null {
  return isRecord(value) && typeof value.operationId === 'string' ? value.operationId : null;
}

function actionConclusionFrom(
  value: unknown,
  key: 'actionDispatched' | 'clickDispatched',
): boolean | 'unknown' {
  const candidates = nestedValues(value, key);
  if (candidates.includes(true)) return true;
  if (candidates.includes('unknown')) return 'unknown';
  return candidates.includes(false) ? false : 'unknown';
}

function nestedValues(value: unknown, key: string, depth = 0): unknown[] {
  if (depth > 6 || !isRecord(value)) return [];
  const direct = value[key];
  return [
    ...(direct === undefined ? [] : [direct]),
    ...['result', 'error', 'details', 'dispatch', 'evidence']
      .flatMap((child) => nestedValues(value[child], key, depth + 1)),
  ];
}
