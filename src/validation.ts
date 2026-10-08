import type { JsonObject, JsonValue } from "./types.js";

export function object(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${context}: expected object`);
  return value as Record<string, unknown>;
}
export function string(value: unknown, context: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Invalid ${context}: expected nonempty string`);
  return value;
}
export function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`Invalid ${context}: expected array`);
  return value;
}
export function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  const record = object(value, "JSON");
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(record))
    Object.defineProperty(result, key, {
      value: json(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result;
}
export function jsonObject(value: unknown): JsonObject {
  object(value, "JSON object");
  return json(value) as JsonObject;
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
