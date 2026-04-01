import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type ApprovedLlmApproval = {
  approvalId: string;
  createdAt: number;
};

const _approvedBySession = new Map<string, ApprovedLlmApproval>();
let _storePath: string | null = null;

function getRuntimeApprovalStore(): Record<string, string> {
  const g = globalThis as Record<string, unknown>;
  const state = (g["__ah5_runtime"] ??= {
    vaultBearerToken: null,
    credentialProvider: null,
    proxiedProviders: [],
    currentSessionKey: null,
    approvedLlmApprovals: {},
  }) as { approvedLlmApprovals?: Record<string, string> };
  if (!state.approvedLlmApprovals) state.approvedLlmApprovals = {};
  return state.approvedLlmApprovals;
}

function persistApprovedLlmApprovals(): void {
  if (!_storePath) return;
  try {
    mkdirSync(dirname(_storePath), { recursive: true });
    const serialized: Record<string, string> = {};
    for (const [sessionKey, entry] of _approvedBySession.entries()) {
      serialized[sessionKey] = entry.approvalId;
    }
    writeFileSync(_storePath, JSON.stringify(serialized, null, 2));
  } catch {
    // Best-effort persistence only.
  }
}

export function initApprovedLlmApprovals(stateDir: string): void {
  _storePath = join(stateDir, "ah5-approved-llm-approvals.json");
  _approvedBySession.clear();

  try {
    const raw = readFileSync(_storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [sessionKey, approvalId] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof approvalId === "string" && approvalId) {
          _approvedBySession.set(sessionKey, { approvalId, createdAt: Date.now() });
        }
      }
    }
  } catch {
    // No persisted state yet.
  }

  const runtimeStore = getRuntimeApprovalStore();
  for (const key of Object.keys(runtimeStore)) {
    delete runtimeStore[key];
  }
  for (const [sessionKey, entry] of _approvedBySession.entries()) {
    runtimeStore[sessionKey] = entry.approvalId;
  }
}

export function storeApprovedLlmApproval(sessionKey: string, approvalId: string): void {
  _approvedBySession.set(sessionKey, {
    approvalId,
    createdAt: Date.now(),
  });
  getRuntimeApprovalStore()[sessionKey] = approvalId;
  persistApprovedLlmApprovals();
}

export function consumeApprovedLlmApproval(sessionKey: string): string | null {
  const entry = _approvedBySession.get(sessionKey);
  const runtimeStore = getRuntimeApprovalStore();
  const runtimeApprovalId = runtimeStore[sessionKey];
  if (!entry && !runtimeApprovalId) return null;
  _approvedBySession.delete(sessionKey);
  delete runtimeStore[sessionKey];
  persistApprovedLlmApprovals();
  return entry?.approvalId ?? runtimeApprovalId ?? null;
}

export function clearApprovedLlmApproval(sessionKey: string): void {
  _approvedBySession.delete(sessionKey);
  delete getRuntimeApprovalStore()[sessionKey];
  persistApprovedLlmApprovals();
}

export function resetApprovedLlmApprovals(): void {
  _approvedBySession.clear();
  const runtimeStore = getRuntimeApprovalStore();
  for (const key of Object.keys(runtimeStore)) {
    delete runtimeStore[key];
  }
  persistApprovedLlmApprovals();
}

export function resetApprovedLlmApprovalsRuntimeOnlyForTest(): void {
  _approvedBySession.clear();
  const runtimeStore = getRuntimeApprovalStore();
  for (const key of Object.keys(runtimeStore)) {
    delete runtimeStore[key];
  }
}
