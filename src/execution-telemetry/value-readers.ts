export function boundedNullableInteger(
  value: unknown,
  maximum: number,
): number | null | undefined {
  if (value === null) return null;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : undefined;
}

export function nullableBoolean(value: unknown): boolean | null | undefined {
  return value === null || typeof value === 'boolean' ? value : undefined;
}

export function valuesForKey(
  value: unknown,
  key: string,
  depth = 0,
  ancestors = new WeakSet<object>(),
): unknown[] {
  if (depth > 8 || value === null || typeof value !== 'object' || ancestors.has(value)) return [];
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.flatMap((candidate) => valuesForKey(candidate, key, depth + 1, ancestors));
    }
    const record = value as Record<string, unknown>;
    return [
      ...(record[key] === undefined ? [] : [record[key]]),
      ...Object.values(record).flatMap((candidate) => valuesForKey(candidate, key, depth + 1, ancestors)),
    ];
  } finally {
    ancestors.delete(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
