/**
 * Periodic cleanup of expired agent access tokens and consumed/expired bootstrap secrets.
 * Runs every hour. Uses .unref() to not prevent process exit.
 */

import { lt, and, isNotNull, or } from "drizzle-orm";
import { db } from "../db/client";
import { agentAccessTokens } from "../db/schema/agent-access-tokens";
import { agentBootstrapSecrets } from "../db/schema/agent-bootstrap-secrets";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenCleanup(logger?: { error: (obj: unknown, msg?: string) => void }): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(async () => {
    const now = new Date();
    try {
      // Delete expired access tokens
      await db
        .delete(agentAccessTokens)
        .where(lt(agentAccessTokens.expiresAt, now));

      // Delete consumed or expired bootstrap secrets
      await db
        .delete(agentBootstrapSecrets)
        .where(
          or(
            isNotNull(agentBootstrapSecrets.consumedAt),
            lt(agentBootstrapSecrets.expiresAt, now),
          ),
        );
    } catch (err) {
      logger?.error({ err }, "Token cleanup failed");
    }
  }, CLEANUP_INTERVAL_MS);

  cleanupInterval.unref();
}

export function stopTokenCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
