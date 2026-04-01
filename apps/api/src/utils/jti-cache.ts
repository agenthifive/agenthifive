/**
 * PostgreSQL-backed JTI replay cache for client assertion JWT replay protection.
 * Works across all Fastify replicas — no sticky sessions required.
 *
 * Uses primary key constraint on `jti` for atomic check-and-store.
 * Cleanup runs every 5 minutes to remove expired entries.
 */

import { db } from "../db/client";
import { jtiReplayCache } from "../db/schema/jti-replay-cache";
import { lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
type Logger = FastifyBaseLogger;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Check if a jti has been seen before. If not, store it.
 * @returns true if the jti is new (allowed), false if it's a replay (rejected).
 */
export async function checkAndStoreJti(
  jti: string,
  expiryEpochMs: number,
): Promise<boolean> {
  const expiresAt = new Date(expiryEpochMs);

  // If the jti exists but is expired, clean it up first so the INSERT succeeds.
  // This handles the "reuse after expiry" case without waiting for periodic cleanup.
  try {
    const result = await db
      .insert(jtiReplayCache)
      .values({ jti, expiresAt })
      .onConflictDoNothing({ target: jtiReplayCache.jti })
      .returning({ jti: jtiReplayCache.jti });

    if (result.length > 0) {
      return true; // First use — inserted successfully
    }

    // Row exists — check if it's expired
    // If expired, delete it and re-insert
    const deleted = await db
      .delete(jtiReplayCache)
      .where(lt(jtiReplayCache.expiresAt, new Date()))
      .returning({ jti: jtiReplayCache.jti });

    if (deleted.some((d) => d.jti === jti)) {
      // The expired row was cleaned up — try inserting again
      const retry = await db
        .insert(jtiReplayCache)
        .values({ jti, expiresAt })
        .onConflictDoNothing({ target: jtiReplayCache.jti })
        .returning({ jti: jtiReplayCache.jti });
      return retry.length > 0;
    }

    return false; // Replay detected — existing row is still valid
  } catch {
    // DB errors → fail closed (reject the request)
    return false;
  }
}

export function startJtiCleanup(logger?: Logger): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    db.delete(jtiReplayCache)
      .where(lt(jtiReplayCache.expiresAt, new Date()))
      .then(() => {
        logger?.debug("JTI replay cache cleanup completed");
      })
      .catch((err) => {
        logger?.error({ err }, "JTI replay cache cleanup failed");
      });
  }, 300_000); // 5 minutes
  // Don't prevent process exit
  cleanupInterval.unref();
}

export function stopJtiCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/** For testing only — clears the entire table */
export async function clearJtiCache(): Promise<void> {
  await db.delete(jtiReplayCache);
}
