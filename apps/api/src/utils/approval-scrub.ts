/**
 * Periodic failsafe: scrub sensitive metadata from resolved approval requests.
 *
 * The primary scrub happens inline when an approval is approved/denied/expired/consumed.
 * This periodic job catches anything that slipped through — e.g., approvals that expired
 * while no one visited the dashboard, or edge cases where the inline scrub failed.
 *
 * Runs every 30 minutes. Any resolved approval whose requestDetails still has more than
 * method+url and was last updated > 1 hour ago gets scrubbed.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { approvalRequests } from "../db/schema/approval-requests";

const SCRUB_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

let scrubInterval: ReturnType<typeof setInterval> | null = null;

export function startApprovalScrub(logger?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }): void {
  if (scrubInterval) return;

  scrubInterval = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

      // Scrub requestDetails on resolved approvals that are older than the threshold
      // and still have extra keys beyond method+url (jsonb_object_keys count > 2).
      // Use raw column names in SET clause — Drizzle expands column refs as
      // "table"."column" which PostgreSQL rejects in SET (only "column" allowed).
      const result = await db.execute(
        sql`UPDATE ${approvalRequests}
            SET request_details = jsonb_build_object(
                  'method', request_details->'method',
                  'url', request_details->'url'
                ),
                updated_at = now()
            WHERE status IN ('approved', 'denied', 'expired', 'consumed')
              AND updated_at < ${cutoff}
              AND (SELECT count(*) FROM jsonb_object_keys(request_details)) > 2`,
      );

      const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
      if (rowCount > 0) {
        logger?.info({ scrubbed: rowCount }, "approval-scrub: cleaned stale requestDetails");
      }
    } catch (err) {
      logger?.error({ err }, "approval-scrub: periodic scrub failed");
    }
  }, SCRUB_INTERVAL_MS);

  scrubInterval.unref();
}

export function stopApprovalScrub(): void {
  if (scrubInterval) {
    clearInterval(scrubInterval);
    scrubInterval = null;
  }
}
