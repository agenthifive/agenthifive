import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Pending vault step-up approvals.
 *
 * When the vault_execute agent tool gets a 202 (approval required), it adds
 * the pending approval to this store. We persist it to disk so gateway/plugin
 * restarts do not lose the approval before the next turn can replay it.
 *
 * The background approval watcher polls the AH5 API for status changes and
 * wakes the agent via enqueueSystemEvent when approvals resolve.
 *
 * The before_agent_start hook also checks for resolved approvals as a
 * belt-and-suspenders fallback.
 */

export type PendingApproval = {
  approvalRequestId: string;
  service?: string;
  connectionId?: string;
  method: string;
  url: string;
  /** Human-readable summary of what the request does */
  summary: string;
  createdAt: string;
  expiresAt?: string;
  /** Routing info for auto-triggering the agent when the approval resolves */
  sessionKey?: string;
  channel?: string;
  peerId?: string;
  peerKind?: string;
  threadId?: string;
};

// ---------------------------------------------------------------------------
// Logger interface (injected, not imported from OpenClaw)
// ---------------------------------------------------------------------------

export interface PluginLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

let _log: PluginLogger = console;
let _pending: PendingApproval[] = [];
let _storePath: string | null = null;

function readPersistedApprovals(storePath: string): PendingApproval[] {
  try {
    const raw = readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingApproval => {
      return !!item
        && typeof item === "object"
        && typeof (item as PendingApproval).approvalRequestId === "string"
        && typeof (item as PendingApproval).method === "string"
        && typeof (item as PendingApproval).url === "string"
        && typeof (item as PendingApproval).summary === "string"
        && typeof (item as PendingApproval).createdAt === "string";
    });
  } catch {
    return [];
  }
}

function persistApprovals(): void {
  if (!_storePath) return;
  try {
    mkdirSync(dirname(_storePath), { recursive: true });
    writeFileSync(_storePath, JSON.stringify(_pending, null, 2));
  } catch (err) {
    _log.warn?.(`failed to persist pending approvals: ${String(err)}`);
  }
}

/**
 * Initialize the pending approvals module with a logger.
 */
export function initPendingApprovals(stateDir: string, logger?: PluginLogger): void {
  if (logger) _log = logger;
  _storePath = join(stateDir, "ah5-pending-approvals.json");
  _pending = readPersistedApprovals(_storePath);
}

/**
 * Add a pending approval.
 * Called by the vault_execute tool when it receives a 202.
 */
export function addPendingApproval(approval: PendingApproval): void {
  if (_pending.some((a) => a.approvalRequestId === approval.approvalRequestId)) {
    return;
  }
  _pending.push(approval);
  persistApprovals();
  _log.info?.(`tracked pending approval ${approval.approvalRequestId} (${approval.summary})`);
}

export function loadPendingApprovals(): PendingApproval[] {
  return _pending;
}

export function savePendingApprovals(approvals: PendingApproval[]): void {
  _pending = approvals;
  persistApprovals();
}
