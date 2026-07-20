import { publicTargetUrl } from "./url.ts";

const MAX_DIAGNOSTIC_LENGTH = 500;
const HTTP_URL = /\bhttps?:\/\/[^\s<>"']+/giu;
const SECRET_FIELD =
  /\b(authorization|password|passwd|secret|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|cookie|set-cookie)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu;

function redactUrl(match: string): string {
  const trailing = match.match(/[),.;!?]+$/u)?.[0] ?? "";
  const candidate = trailing ? match.slice(0, -trailing.length) : match;
  try {
    return `${publicTargetUrl(candidate)}${trailing}`;
  } catch {
    return `[redacted-url]${trailing}`;
  }
}

export function sanitizeDiagnosticText(value: string): string {
  const sanitized = value
    .replace(HTTP_URL, redactUrl)
    .replace(SECRET_FIELD, (_match, field: string) => `${field}=[redacted]`);
  if (sanitized.length <= MAX_DIAGNOSTIC_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}
