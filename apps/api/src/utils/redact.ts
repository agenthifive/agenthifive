/**
 * Manual redaction helpers for ad-hoc objects not covered by
 * Pino's automatic path-based redaction (configured in server.ts).
 */

const SENSITIVE_KEYS = new Set([
  "accessToken", "refreshToken", "botToken", "apiKey", "appKey",
  "client_secret", "password", "encryptedTokens", "bootstrapSecret",
  "client_assertion", "tokenHash", "secretHash", "jiraBasicAuth",
]);

/** Shallow-copy an object and replace known sensitive fields with [REDACTED]. */
export function redactSensitiveFields<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_KEYS.has(key)) {
      (result as Record<string, unknown>)[key] = "[REDACTED]";
    }
  }
  return result;
}

/** Truncate a string for safe logging (e.g., response bodies, long URLs). */
export function truncate(str: string, maxLen = 200): string {
  return str.length > maxLen ? str.slice(0, maxLen) + `... (${str.length} chars)` : str;
}
