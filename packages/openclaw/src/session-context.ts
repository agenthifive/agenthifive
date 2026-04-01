/**
 * Lightweight session context tracking for vault tools.
 *
 * The `before_agent_start` hook has access to the current session's key
 * (via PluginHookAgentContext), but agent tools receive no session context.
 * This module bridges the gap with a module-scoped variable.
 *
 * The hook sets the current session at the start of each agent turn;
 * the vault_execute tool reads it when writing pending approvals.
 *
 * Safety: OpenClaw serialises agent turns per session lane, so within
 * a single session the set → read ordering is guaranteed. Concurrent
 * sessions on different lanes have a theoretical race window, but the
 * impact is minimal (worst case: an approval notification routes to a
 * slightly wrong session; the correct session still picks it up via the
 * before_agent_start fallback hook on its next turn).
 */

export type SessionContext = {
  sessionKey: string;
  channel?: string;
  peerId?: string;
  peerKind?: string;
};

let _current: SessionContext | undefined;

export function setCurrentSessionContext(ctx: SessionContext): void {
  _current = ctx;
  const g = globalThis as Record<string, unknown>;
  const state = (g["__ah5_runtime"] ??= {
    vaultBearerToken: null,
    credentialProvider: null,
    proxiedProviders: [],
    currentSessionKey: null,
    approvedLlmApprovals: {},
  }) as { currentSessionKey?: string | null };
  state.currentSessionKey = ctx.sessionKey || null;
}

export function getCurrentSessionContext(): SessionContext | undefined {
  return _current;
}

/**
 * Parse routing info from a session key.
 *
 * Session keys from buildAgentPeerSessionKey use these formats:
 *   "agent:{agentId}:{channel}:{peerKind}:{peerId}"              (per-channel-peer / group)
 *   "agent:{agentId}:{channel}:{accountId}:{peerKind}:{peerId}"  (per-account-channel-peer)
 *   "agent:{agentId}:main"                                        (TUI/webchat dmScope=main)
 */
export function parseSessionKey(sessionKey: string): {
  channel?: string;
  peerKind?: string;
  peerId?: string;
} {
  const parts = sessionKey.split(":");
  if (parts.length < 5) {
    return {};
  }
  if (parts.length === 5) {
    const result: { channel?: string; peerKind?: string; peerId?: string } = {};
    if (parts[2]) result.channel = parts[2];
    if (parts[3]) result.peerKind = parts[3];
    if (parts[4]) result.peerId = parts[4];
    return result;
  }
  const result: { channel?: string; peerKind?: string; peerId?: string } = {};
  if (parts[2]) result.channel = parts[2];
  if (parts[4]) result.peerKind = parts[4];
  const peerId = parts.slice(5).join(":");
  if (peerId) result.peerId = peerId;
  return result;
}
