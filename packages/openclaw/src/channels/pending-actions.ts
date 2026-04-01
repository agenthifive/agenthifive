import { join } from "node:path";
import { pathExists, readText, writeText } from "../env-paths.js";
import type { PluginLogger } from "../pending-approvals.js";
import type { PendingChannelAction, PendingChannelActionStatus } from "./types.js";

const PENDING_CHANNEL_ACTIONS_FILE = "vault-pending-channel-actions.json";

let _stateDir = "";
let _log: PluginLogger = console;

function ensureInitialized(): void {
  if (!_stateDir) {
    throw new Error("pending channel actions not initialized");
  }
}

function actionsPath(): string {
  ensureInitialized();
  return join(_stateDir, PENDING_CHANNEL_ACTIONS_FILE);
}

function sortActions(actions: PendingChannelAction[]): PendingChannelAction[] {
  return [...actions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function initPendingChannelActions(stateDir: string, logger?: PluginLogger): void {
  _stateDir = stateDir;
  if (logger) _log = logger;
}

export function loadPendingChannelActions(): PendingChannelAction[] {
  const filePath = actionsPath();
  if (!pathExists(filePath)) return [];

  try {
    const parsed = JSON.parse(readText(filePath)) as PendingChannelAction[];
    return Array.isArray(parsed) ? sortActions(parsed) : [];
  } catch (err) {
    _log.warn?.(`[pending-channel-actions] failed to parse store, returning empty: ${String(err)}`);
    return [];
  }
}

export function savePendingChannelActions(actions: PendingChannelAction[]): void {
  writeText(actionsPath(), JSON.stringify(sortActions(actions), null, 2));
}

export function addPendingChannelAction(action: PendingChannelAction): void {
  const actions = loadPendingChannelActions();
  if (actions.some((existing) => existing.approvalRequestId === action.approvalRequestId)) {
    return;
  }
  actions.push(action);
  savePendingChannelActions(actions);
}

export function getPendingChannelAction(
  approvalRequestId: string,
): PendingChannelAction | null {
  return (
    loadPendingChannelActions().find(
      (action) => action.approvalRequestId === approvalRequestId,
    ) ?? null
  );
}

export function updatePendingChannelActionStatus(
  approvalRequestId: string,
  status: PendingChannelActionStatus,
): PendingChannelAction | null {
  const actions = loadPendingChannelActions();
  const index = actions.findIndex((action) => action.approvalRequestId === approvalRequestId);
  if (index === -1) return null;

  const updated: PendingChannelAction = {
    ...actions[index]!,
    status,
    updatedAt: new Date().toISOString(),
  };
  actions[index] = updated;
  savePendingChannelActions(actions);
  return updated;
}

export function removePendingChannelAction(approvalRequestId: string): boolean {
  const actions = loadPendingChannelActions();
  const filtered = actions.filter((action) => action.approvalRequestId !== approvalRequestId);
  if (filtered.length === actions.length) return false;
  savePendingChannelActions(filtered);
  return true;
}
