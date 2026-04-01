/**
 * Anomaly detection for vault requests.
 *
 * Runs lightweight checks after each vault request (fire-and-forget).
 * Creates dashboard notifications + external alerts (Telegram/Slack)
 * when anomalous patterns are detected.
 *
 * Rules:
 *  1. Burst detection — too many requests in a short window
 *  2. High denial rate — many denied requests (attacker probing)
 *  3. Unusual hours — activity in hours the agent rarely uses (auto-learned)
 *  4. Unusual data volume — large cumulative response size (exfiltration)
 */

import { db } from "../db/client";
import { auditEvents } from "../db/schema/audit-events";
import { agents } from "../db/schema/agents";
import { eq, and, gte, count, sql } from "drizzle-orm";
import { createNotification } from "./notifications";
import { sendSecurityAlertNotifications } from "./external-notifications";

// ── Types ────────────────────────────────────────────────────────

export interface AnomalyContext {
  agentId: string;
  connectionId: string;
  workspaceId: string;
  /** Audit decision for the current request */
  decision: "allowed" | "denied" | "error";
  /** Response data size in bytes (if available) */
  dataSize?: number;
}

interface AnomalyRule {
  id: string;
  label: string;
  cooldownMs: number;
  check: (ctx: AnomalyContext) => Promise<boolean>;
}

// ── Thresholds ───────────────────────────────────────────────────

const BURST_THRESHOLD = 300;
const BURST_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const DENIAL_THRESHOLD = 10;
const DENIAL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const DATA_VOLUME_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB
const DATA_VOLUME_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const UNUSUAL_HOURS_MIN_REQUESTS = 50; // skip rule for new agents
const UNUSUAL_HOURS_PERCENT_THRESHOLD = 5; // <5% of traffic = unusual
const UNUSUAL_HOURS_LOOKBACK_DAYS = 7;

// ── Cooldown map (in-memory, resets on restart) ──────────────────

const alertCooldowns = new Map<string, number>();

function isCoolingDown(key: string, cooldownMs: number): boolean {
  const last = alertCooldowns.get(key);
  if (last && Date.now() - last < cooldownMs) return true;
  alertCooldowns.set(key, Date.now());
  return false;
}

// ── Unusual hours helper ─────────────────────────────────────────

/**
 * Check if the current hour-of-day (UTC) is unusual for this agent.
 * Returns a multiplier: 1.0 for normal hours, 0.5 for unusual hours.
 * Returns 1.0 (normal) if the agent has too few requests for a baseline.
 */
async function getHourMultiplier(agentId: string): Promise<number> {
  const lookback = new Date(Date.now() - UNUSUAL_HOURS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      hour: sql<number>`extract(hour from ${auditEvents.timestamp})::int`,
      cnt: count(),
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.agentId, agentId),
        gte(auditEvents.timestamp, lookback),
      ),
    )
    .groupBy(sql`extract(hour from ${auditEvents.timestamp})`);

  const totalRequests = rows.reduce((sum, r) => sum + Number(r.cnt), 0);
  if (totalRequests < UNUSUAL_HOURS_MIN_REQUESTS) return 1.0; // not enough data

  const currentHour = new Date().getUTCHours();
  const currentHourCount = rows.find((r) => r.hour === currentHour)?.cnt ?? 0;
  const percent = (Number(currentHourCount) / totalRequests) * 100;

  return percent < UNUSUAL_HOURS_PERCENT_THRESHOLD ? 0.5 : 1.0;
}

// ── Rules ────────────────────────────────────────────────────────

const RULES: AnomalyRule[] = [
  {
    id: "burst",
    label: "Unusual request burst detected",
    cooldownMs: 15 * 60 * 1000, // 15 minutes
    async check(ctx) {
      const multiplier = await getHourMultiplier(ctx.agentId);
      const threshold = Math.floor(BURST_THRESHOLD * multiplier);
      const windowStart = new Date(Date.now() - BURST_WINDOW_MS);

      const [result] = await db
        .select({ total: count() })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.agentId, ctx.agentId),
            eq(auditEvents.action, "execution_completed"),
            gte(auditEvents.timestamp, windowStart),
          ),
        );

      return (result?.total ?? 0) > threshold;
    },
  },

  {
    id: "denial_rate",
    label: "High denial rate detected",
    cooldownMs: 15 * 60 * 1000,
    async check(ctx) {
      // Only check after a denial
      if (ctx.decision !== "denied") return false;

      const multiplier = await getHourMultiplier(ctx.agentId);
      const threshold = Math.floor(DENIAL_THRESHOLD * multiplier);
      const windowStart = new Date(Date.now() - DENIAL_WINDOW_MS);

      const [result] = await db
        .select({ total: count() })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.agentId, ctx.agentId),
            eq(auditEvents.decision, "denied"),
            gte(auditEvents.timestamp, windowStart),
          ),
        );

      return (result?.total ?? 0) > threshold;
    },
  },

  {
    id: "data_volume",
    label: "Unusual data volume detected",
    cooldownMs: 30 * 60 * 1000,
    async check(ctx) {
      // Only check after a successful response with data
      if (ctx.decision !== "allowed") return false;

      const windowStart = new Date(Date.now() - DATA_VOLUME_WINDOW_MS);

      const [result] = await db
        .select({
          totalBytes: sql<number>`coalesce(sum((${auditEvents.metadata}->>'dataSize')::bigint), 0)`,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.agentId, ctx.agentId),
            eq(auditEvents.action, "execution_completed"),
            gte(auditEvents.timestamp, windowStart),
          ),
        );

      return (Number(result?.totalBytes) ?? 0) > DATA_VOLUME_THRESHOLD_BYTES;
    },
  },
];

// ── Main entry point ─────────────────────────────────────────────

/**
 * Check all anomaly rules for a vault request.
 * Fire-and-forget — call without awaiting.
 */
export async function checkAnomalies(ctx: AnomalyContext): Promise<void> {
  for (const rule of RULES) {
    const cooldownKey = `${rule.id}:${ctx.agentId}`;
    if (isCoolingDown(cooldownKey, rule.cooldownMs)) continue;

    let triggered: boolean;
    try {
      triggered = await rule.check(ctx);
    } catch {
      continue; // never crash on anomaly check failure
    }

    if (!triggered) {
      // Undo the cooldown set — only keep it if we actually alerted
      alertCooldowns.delete(cooldownKey);
      continue;
    }

    // Resolve agent name for the notification
    let agentName = "An agent";
    try {
      const [agent] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, ctx.agentId))
        .limit(1);
      if (agent?.name) agentName = agent.name;
    } catch {
      // use default
    }

    const title = `⚠️ ${rule.label}`;
    const body = `${agentName} triggered a security alert: ${rule.label.toLowerCase()}. Review the activity log and consider revoking access if this is unexpected.`;

    // Dashboard notification (SSE push)
    createNotification({
      workspaceId: ctx.workspaceId,
      type: "security_alert",
      title,
      body,
      linkUrl: "/dashboard/activity",
      metadata: {
        agentId: ctx.agentId,
        connectionId: ctx.connectionId,
        ruleId: rule.id,
      },
    });

    // External channels (Telegram, Slack, mobile push)
    sendSecurityAlertNotifications({
      workspaceId: ctx.workspaceId,
      agentName,
      alertTitle: rule.label,
      alertBody: body,
    });
  }
}
