import { ShimonError } from "./errors.ts";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function asJsonValue(value: unknown, path = "evidence"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((child, index) => asJsonValue(child, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ShimonError("evidence_invalid", `${path} must be a plain JSON object.`);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, asJsonValue(child, `${path}.${key}`)]),
    );
  }
  throw new ShimonError(
    "evidence_invalid",
    `${path} is not JSON-serializable.`,
    "Return only objects, arrays, strings, finite numbers, booleans, or null from check evidence.",
  );
}
