import type { JsonValue } from "./canonicalize.ts";

export interface JsonChange {
  path: string;
  before: JsonValue | undefined;
  after: JsonValue | undefined;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(parent: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return parent ? `${parent}.${key}` : key;
  }

  return `${parent}[${JSON.stringify(key)}]`;
}

function visit(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  changes: JsonChange[],
): void {
  if (Object.is(before, after)) return;

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      visit(before[index], after[index], `${path}[${index}]`, changes);
    }
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      visit(before[key], after[key], childPath(path, key), changes);
    }
    return;
  }

  changes.push({ path: path || "$", before, after });
}

export function diffJson(before: JsonValue, after: JsonValue): JsonChange[] {
  const changes: JsonChange[] = [];
  visit(before, after, "", changes);
  return changes;
}
