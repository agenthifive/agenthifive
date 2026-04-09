"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  SERVICE_CATALOG,
  isRevocationInstant,
  getAllowedModelsForService,
  getPolicyTemplate,
  type ServiceId,
} from "@agenthifive/contracts";

const GUARD_INFO: Record<string, { name: string; description: string }> = {
  "cs-pii-redact": {
    name: "PII Response Redaction",
    description: "Redacts sensitive information (emails, phone numbers, SSN) from responses",
  },
  "dest-delete-protect": {
    name: "Delete Protection",
    description: "Prevents permanent deletion of data",
  },
  "cs-profanity": {
    name: "Profanity Filter",
    description: "Blocks messages containing profanity or inappropriate content",
  },
  "cs-pii-outbound": {
    name: "PII Outbound Guard",
    description: "Prevents sending sensitive information externally",
  },
  "msg-send-approval": {
    name: "Send Approval",
    description: "Requires approval for sending messages",
  },
  "cal-external-attendee": {
    name: "External Attendee Guard",
    description: "Requires approval when adding external attendees to events",
  },
  "fs-public-share": {
    name: "Block Public Sharing",
    description: "Prevents making files publicly accessible",
  },
  "fs-external-share": {
    name: "External Sharing Guard",
    description: "Requires approval for sharing files externally",
  },
  "fs-dangerous-file": {
    name: "Dangerous File Type Guard",
    description: "Blocks upload of potentially dangerous file types",
  },
  "dr-file-download": {
    name: "File Download Guard",
    description: "Requires approval for binary file downloads that bypass content filtering",
  },
  "llm-prompt-injection": {
    name: "Prompt Injection Guard",
    description: "Detects common prompt injection patterns: instruction overrides and delimiter injection",
  },
  "llm-pii-prompt": {
    name: "PII in Prompts Guard",
    description: "Requires approval when prompts contain PII (SSN, credit card numbers)",
  },
  "llm-model-restrict": {
    name: "Model Restriction Guard",
    description: "Blocks expensive models (e.g., Opus) for cost control",
  },
  "llm-max-tokens-limit": {
    name: "Max Tokens Limit Guard",
    description: "Requires approval for very high token requests (> 10,000)",
  },
  "tg-chat-allowlist": {
    name: "Chat Allowlist",
    description: "Restricts messaging to approved chats only",
  },
};
import type {
  AgentConnection,
  AgentPolicy,
  AllowlistEntry,
  RateLimits,
  TimeWindow,
} from "./types";
import { STATUS_CONFIG, inferPolicyTier } from "./types";
import PolicyWizard from "./policy-wizard";

interface ConnectionDetailModalProps {
  agentId: string;
  agentName: string;
  connection: AgentConnection;
  onClose: () => void;
  onRefresh: () => void;
  showAddPolicy?: boolean;
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export default function ConnectionDetailModal({
  agentId,
  agentName,
  connection,
  onClose,
  onRefresh,
  showAddPolicy: initialShowAddPolicy = false,
}: ConnectionDetailModalProps) {
  const serviceConfig = SERVICE_CATALOG[connection.connectionService as keyof typeof SERVICE_CATALOG];
  const statusConfig = STATUS_CONFIG[connection.connectionStatus];
  const serviceIcon = connection.connectionService === "google-gmail"
    ? "📧"
    : serviceConfig?.icon || "🔌";

  // Connection details expand
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);

  // Editing state
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelValue, setLabelValue] = useState(connection.connectionLabel);
  const [savingLabel, setSavingLabel] = useState(false);

  // Auto-open the simplified editor for the first policy if there's only one
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(
    connection.policies.length === 1 ? connection.policies[0]!.id : null
  );

  const [showAddPolicy, setShowAddPolicy] = useState(initialShowAddPolicy);

  const [deletingPolicyId, setDeletingPolicyId] = useState<string | null>(null);

  // Reconnect
  const [showReconnect, setShowReconnect] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectCredential, setReconnectCredential] = useState("");
  const [reconnectAppKey, setReconnectAppKey] = useState("");
  const [reconnectEmail, setReconnectEmail] = useState("");
  const [reconnectShowKey, setReconnectShowKey] = useState(false);

  // Revocation
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [revoking, setRevoking] = useState(false);

  // Sub-editors
  const [allowlistEditPolicy, setAllowlistEditPolicy] = useState<AgentPolicy | null>(null);
  const [allowlistEntries, setAllowlistEntries] = useState<AllowlistEntry[]>([]);
  const [savingAllowlists, setSavingAllowlists] = useState(false);

  const [rateLimitEditPolicy, setRateLimitEditPolicy] = useState<AgentPolicy | null>(null);
  const [rateLimitValues, setRateLimitValues] = useState<RateLimits | null>(null);
  const [savingRateLimits, setSavingRateLimits] = useState(false);

  const [timeWindowEditPolicy, setTimeWindowEditPolicy] = useState<AgentPolicy | null>(null);
  const [timeWindowEntries, setTimeWindowEntries] = useState<TimeWindow[]>([]);
  const [savingTimeWindows, setSavingTimeWindows] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const serviceAllowedModels = getAllowedModelsForService(connection.connectionService as ServiceId);

  // --- Handlers ---

  async function handleSaveLabel() {
    setSavingLabel(true);
    try {
      const res = await apiFetch(`/connections/${connection.connectionId}/label`, {
        method: "PUT",
        body: JSON.stringify({ label: labelValue.trim() }),
      });
      if (!res.ok) throw new Error("Failed to update label");
      setEditingLabel(false);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update label");
    } finally {
      setSavingLabel(false);
    }
  }

  async function handleRevoke() {
    setRevoking(true);
    try {
      const res = await apiFetch(`/connections/${connection.connectionId}/revoke`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to revoke connection");
      onRefresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke");
    } finally {
      setRevoking(false);
    }
  }

  async function handleReconnect() {
    setReconnecting(true);
    setError(null);

    const credType = serviceConfig?.credentialType;
    const isInline = credType === "bot_token" || credType === "api_key";
    const isCredentialUpdate = isInline && connection.connectionStatus !== "needs_reauth";
    const provider = serviceConfig?.provider;

    try {
      if (isInline) {
        const body: Record<string, string> = {};
        if (credType === "bot_token") body.botToken = reconnectCredential;
        else body.apiKey = reconnectCredential;

        if (provider === "trello" && reconnectAppKey.trim()) {
          body.appKey = reconnectAppKey.trim();
        }

        if (provider === "jira") {
          if (reconnectAppKey.trim()) body.siteUrl = reconnectAppKey.trim();
          if (reconnectEmail.trim()) body.email = reconnectEmail.trim();
        }

        const res = await apiFetch(`/connections/${connection.connectionId}/${isCredentialUpdate ? "credentials" : "reauth"}`, {
          method: isCredentialUpdate ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const data = (await res.json()) as { error: string };
          throw new Error(data.error);
        }

        setShowReconnect(false);
        setReconnectCredential("");
        setReconnectAppKey("");
        setReconnectEmail("");
        setReconnectShowKey(false);
        onRefresh();
      } else {
        // OAuth — redirect flow
        const res = await apiFetch(`/connections/${connection.connectionId}/reauth`, {
          method: "POST",
        });

        if (!res.ok) {
          const data = (await res.json()) as { error: string };
          throw new Error(data.error);
        }

        const data = (await res.json()) as { authorizationUrl: string };
        window.open(data.authorizationUrl, "oauth-reauth", "width=600,height=700");
        setShowReconnect(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : isCredentialUpdate ? "Failed to update credential" : "Failed to reconnect");
    } finally {
      setReconnecting(false);
    }
  }

  function handlePolicySaved() {
    setEditingPolicyId(null);
    onRefresh();
  }

  async function handleDeletePolicy(policyId: string) {
    setDeletingPolicyId(policyId);
    try {
      const res = await apiFetch(`/policies/${policyId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete policy");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete policy");
    } finally {
      setDeletingPolicyId(null);
    }
  }

  function handlePolicyCreated() {
    setShowAddPolicy(false);
    onRefresh();
  }

  async function handleSaveAllowlists() {
    if (!allowlistEditPolicy) return;
    setSavingAllowlists(true);
    try {
      const cleaned = allowlistEntries.map((entry) => ({
        baseUrl: entry.baseUrl.trim(),
        methods: entry.methods,
        pathPatterns: entry.pathPatterns.filter((p) => p.trim().length > 0),
      }));
      const res = await apiFetch(`/policies/${allowlistEditPolicy.id}/allowlists`, {
        method: "PUT",
        body: JSON.stringify({ allowlists: cleaned }),
      });
      if (!res.ok) throw new Error("Failed to save allowlists");
      setAllowlistEditPolicy(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save allowlists");
    } finally {
      setSavingAllowlists(false);
    }
  }

  async function handleSaveRateLimits() {
    if (!rateLimitEditPolicy || !rateLimitValues) return;
    setSavingRateLimits(true);
    try {
      const res = await apiFetch(`/policies/${rateLimitEditPolicy.id}/rate-limits`, {
        method: "PUT",
        body: JSON.stringify({ rateLimits: rateLimitValues }),
      });
      if (!res.ok) throw new Error("Failed to save rate limits");
      setRateLimitEditPolicy(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save rate limits");
    } finally {
      setSavingRateLimits(false);
    }
  }

  async function handleDeleteRateLimits() {
    if (!rateLimitEditPolicy) return;
    setSavingRateLimits(true);
    try {
      const res = await apiFetch(`/policies/${rateLimitEditPolicy.id}/rate-limits`, {
        method: "PUT",
        body: JSON.stringify({ rateLimits: null }),
      });
      if (!res.ok) throw new Error("Failed to delete rate limits");
      setRateLimitEditPolicy(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rate limits");
    } finally {
      setSavingRateLimits(false);
    }
  }

  async function handleSaveTimeWindows() {
    if (!timeWindowEditPolicy) return;
    setSavingTimeWindows(true);
    try {
      const res = await apiFetch(`/policies/${timeWindowEditPolicy.id}/time-windows`, {
        method: "PUT",
        body: JSON.stringify({ timeWindows: timeWindowEntries }),
      });
      if (!res.ok) throw new Error("Failed to save time windows");
      setTimeWindowEditPolicy(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save time windows");
    } finally {
      setSavingTimeWindows(false);
    }
  }

  // --- Render ---

  return (
    <>
      {/* Main modal at z-40 */}
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
        onClick={onClose}
      >
        <div
          className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto bg-white rounded-lg shadow-xl m-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Sticky Header */}
          <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-2xl flex-shrink-0">{serviceIcon}</span>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-foreground truncate">
                  {connection.connectionLabel}
                </h2>
                <p className="text-xs text-muted">
                  Agent: {agentName} · {serviceConfig?.displayName || connection.connectionService}
                </p>
              </div>
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium flex-shrink-0 ${statusConfig.bg} ${statusConfig.color}`}>
                {statusConfig.label}
              </span>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-5 space-y-6">
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-600">{error}</p>
                <button onClick={() => setError(null)} className="mt-1 text-xs text-red-500 underline">
                  Dismiss
                </button>
              </div>
            )}

            {/* ── Connection Summary ──────────────────── */}
            <div className="rounded-lg border border-border bg-gray-50 px-4 py-3">
              {editingLabel ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={labelValue}
                    onChange={(e) => setLabelValue(e.target.value)}
                    className="rounded border border-border px-2 py-1 text-sm w-48"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveLabel}
                    disabled={savingLabel || !labelValue.trim()}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                  >
                    {savingLabel ? "..." : "Save"}
                  </button>
                  <button
                    onClick={() => { setEditingLabel(false); setLabelValue(connection.connectionLabel); }}
                    className="text-xs text-muted hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Connection name and metadata */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-foreground">{connection.connectionLabel}</div>
                      <div className="flex items-center gap-2 text-xs text-muted mt-0.5">
                        {connection.metadata && connection.connectionProvider === "telegram" && (
                          <>
                            <span>@{(connection.metadata as Record<string, string>).botUsername || "unknown"}</span>
                            <span>•</span>
                          </>
                        )}
                        {connection.metadata && connection.connectionProvider === "microsoft" && (
                          <>
                            <span>{(connection.metadata as Record<string, string>).email || "unknown"}</span>
                            <span>•</span>
                          </>
                        )}
                        <span>Connected {new Date(connection.connectionCreatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                        <span>•</span>
                        <span className="capitalize">{connection.connectionProvider}</span>
                        <span>•</span>
                        <span
                          className="font-mono cursor-pointer hover:text-foreground transition-colors"
                          title={`Connection ID: ${connection.connectionId} (click to copy)`}
                          onClick={() => { navigator.clipboard.writeText(connection.connectionId); }}
                        >ID: {connection.connectionId.slice(0, 8)}…</span>
                      </div>
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {connection.connectionStatus !== "revoked" && (
                        <button
                          onClick={() => setEditingLabel(true)}
                          className="text-xs font-medium text-blue-600 hover:text-blue-700"
                        >
                          Rename
                        </button>
                      )}
      {serviceConfig && (serviceConfig.credentialType === "bot_token" || serviceConfig.credentialType === "api_key") && connection.connectionStatus === "healthy" && (
        <button
          onClick={() => setShowReconnect(true)}
          className="text-xs font-medium text-blue-600 hover:text-blue-700"
        >
          Update credential
        </button>
      )}
      {serviceConfig?.credentialType === "oauth" && connection.connectionStatus === "healthy" && (
        <button
          onClick={() => setShowReconnect(true)}
          className="text-xs font-medium text-blue-600 hover:text-blue-700"
        >
          Reconnect
        </button>
      )}
      {connection.connectionStatus === "needs_reauth" && (
        <button
          onClick={() => setShowReconnect(true)}
                          className="text-xs font-medium text-yellow-600 hover:text-yellow-700"
                        >
                          Reconnect
                        </button>
                      )}
                      {connection.connectionStatus !== "revoked" && (
                        <button
                          onClick={() => setShowRevokeConfirm(true)}
                          className="text-xs font-medium text-red-600 hover:text-red-700"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Permissions */}
                  {connection.grantedScopes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {connection.grantedScopes.map((scope, idx) => {
                        const scopeDef = serviceConfig?.scopes.find((s) => s.value === scope);
                        return (
                          <span
                            key={idx}
                            className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-blue-50 text-blue-700"
                            title={scope}
                          >
                            {scopeDef?.label || scope}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* Reconnect warning */}
                  {connection.connectionStatus === "needs_reauth" && (
                    <div className="rounded bg-yellow-50 border border-yellow-200 px-2 py-1.5">
                      <p className="text-xs text-yellow-800">
                        ⚠️ This connection needs to be reconnected
                      </p>
                    </div>
                  )}

                  {connection.credentialPreview && (
                    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                      <div className="text-xs text-slate-700">
                        {connection.credentialPreview.primaryLabel}: <span className="font-mono">{connection.credentialPreview.primaryMasked}</span>
                      </div>
                      {connection.credentialPreview.secondaryLabel && connection.credentialPreview.secondaryMasked && (
                        <div className="mt-1 text-xs text-slate-700">
                          {connection.credentialPreview.secondaryLabel}: <span className="font-mono">{connection.credentialPreview.secondaryMasked}</span>
                        </div>
                      )}
                      {connection.credentialPreview.tertiaryLabel && connection.credentialPreview.tertiaryValue && (
                        <div className="mt-1 text-xs text-slate-700">
                          {connection.credentialPreview.tertiaryLabel}: {connection.credentialPreview.tertiaryValue}
                        </div>
                      )}
                      {connection.connectionUpdatedAt && (
                        <div className="mt-1 text-[11px] text-slate-500">
                          Updated {new Date(connection.connectionUpdatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Policies ───────────────────────────────────── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground">
                  Policies ({connection.policies.length})
                </h3>
                {connection.connectionStatus !== "revoked" && !showAddPolicy && (
                  <button
                    onClick={() => setShowAddPolicy(true)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700"
                  >
                    + Add Policy
                  </button>
                )}
              </div>

              {connection.policies.length === 0 && !showAddPolicy && (
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                  <p className="text-sm text-muted">No policies for this connection yet.</p>
                  {connection.connectionStatus !== "revoked" && (
                    <button
                      onClick={() => setShowAddPolicy(true)}
                      className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-700"
                    >
                      + Add Policy
                    </button>
                  )}
                </div>
              )}

              <div className="space-y-3">
                {connection.policies.map((policy) => {
                  const tier = inferPolicyTier(policy, connection.connectionProvider);
                  const template = policy.actionTemplateId
                    ? getPolicyTemplate(policy.actionTemplateId, tier)
                    : null;
                  const isEditing = editingPolicyId === policy.id;
                  const isDeleting = deletingPolicyId === policy.id;

                  const tierColors = {
                    strict: "bg-red-100 text-red-700",
                    standard: "bg-blue-100 text-blue-700",
                    minimal: "bg-green-100 text-green-700",
                  };

                  return (
                    <div
                      key={policy.id}
                      className="rounded-lg border border-border bg-white p-4"
                    >
                      {isEditing ? (
                        /* Reuse the full PolicyWizard in edit mode */
                        <PolicyWizard
                          agentId={agentId}
                          agentName={agentName}
                          connectionId={connection.connectionId}
                          connectionLabel={connection.connectionLabel}
                          connectionProvider={connection.connectionProvider}
                          connectionService={connection.connectionService}
                          {...(policy.actionTemplateId ? { actionTemplateId: policy.actionTemplateId } : {})}
                          editPolicyId={policy.id}
                          editInitialValues={{
                            allowedModels: policy.allowedModels,
                            defaultMode: policy.defaultMode,
                            stepUpApproval: policy.stepUpApproval,
                            securityPreset: policy.securityPreset,
                            providerConstraints: policy.providerConstraints,
                          }}
                          onCreated={handlePolicySaved}
                          onCancel={() => setEditingPolicyId(null)}
                        />
                      ) : (
                        /* Policy summary + actions */
                        <>
                          {/* Policy header */}
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              {policy.actionTemplateId && (
                                <span className="text-xs font-medium text-muted">
                                  {policy.actionTemplateId}
                                </span>
                              )}
                              <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${tierColors[tier]}`}>
                                {tier.charAt(0).toUpperCase() + tier.slice(1)}
                              </span>
                            </div>
                            {connection.connectionStatus !== "revoked" && (
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => setEditingPolicyId(policy.id)}
                                  className="text-xs font-medium text-blue-600 hover:text-blue-700"
                                >
                                  Edit Policy
                                </button>
                                <button
                                  onClick={() => handleDeletePolicy(policy.id)}
                                  disabled={isDeleting}
                                  className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
                                >
                                  {isDeleting ? "Deleting..." : "Delete"}
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Core settings summary */}
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground">
                              <span>
                                <span className="text-muted">Mode: </span>
                                {policy.defaultMode === "read_only" ? "Read Only" : policy.defaultMode === "read_write" ? "Read/Write" : "Custom"}
                              </span>
                              <span>
                                <span className="text-muted">Approval: </span>
                                {policy.stepUpApproval === "always" ? "Always" : policy.stepUpApproval === "risk_based" ? "Risk-Based" : "Never"}
                              </span>
                              <span>
                                <span className="text-muted">Models: </span>
                                {policy.allowedModels.join(", ")}
                              </span>
                            </div>

                            {/* Rate limits + time windows + allowlists summary */}
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                              {policy.rateLimits && (
                                <span>{policy.rateLimits.maxRequestsPerHour} req/hr</span>
                              )}
                              {policy.timeWindows.length > 0 && (
                                <span>
                                  {policy.timeWindows.map((tw) => DAY_SHORT[tw.dayOfWeek]).join(", ")}{" "}
                                  {policy.timeWindows[0]!.startHour}:00-{policy.timeWindows[0]!.endHour}:00
                                </span>
                              )}
                              {policy.allowlists.length > 0 && (
                                <span>{policy.allowlists.length} allowlist rule{policy.allowlists.length !== 1 ? "s" : ""}</span>
                              )}
                            </div>

                            {/* Trusted recipients (provider constraints) */}
                            {policy.providerConstraints && (
                              <div className="text-xs text-muted">
                                {policy.providerConstraints.provider === "telegram" && (
                                  policy.providerConstraints.allowedChatIds && policy.providerConstraints.allowedChatIds.length > 0
                                    ? <span>Trusted chat IDs: {policy.providerConstraints.allowedChatIds.join(", ")}</span>
                                    : <span>All chats allowed</span>
                                )}
                                {policy.providerConstraints.provider === "slack" && (
                                  <span>
                                    {[
                                      policy.providerConstraints.allowedChannelIds?.length
                                        ? `Channels: ${policy.providerConstraints.allowedChannelIds.join(", ")}`
                                        : null,
                                      policy.providerConstraints.allowedUserIds?.length
                                        ? `Users: ${policy.providerConstraints.allowedUserIds.join(", ")}`
                                        : null,
                                    ].filter(Boolean).join(" · ") || "All channels/users allowed"}
                                  </span>
                                )}
                              </div>
                            )}

                            {/* Security guards */}
                            {template && template.guards.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pt-1">
                                {template.guards.map((guardId) => {
                                  const guard = GUARD_INFO[guardId];
                                  return guard ? (
                                    <span
                                      key={guardId}
                                      className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200"
                                      title={guard.description}
                                    >
                                      {guard.name}
                                    </span>
                                  ) : null;
                                })}
                              </div>
                            )}

                            {/* Sub-editor buttons */}
                            {connection.connectionStatus !== "revoked" && (
                              <div className="flex items-center gap-3 pt-2 border-t border-border mt-2">
                                <button
                                  onClick={() => {
                                    setAllowlistEditPolicy(policy);
                                    setAllowlistEntries(
                                      policy.allowlists.length > 0
                                        ? policy.allowlists.map((a) => ({ ...a }))
                                        : [{ baseUrl: "", methods: ["GET"], pathPatterns: [""] }],
                                    );
                                  }}
                                  className="text-xs text-blue-600 hover:text-blue-700"
                                >
                                  Edit Allowlists ({policy.allowlists.length})
                                </button>
                                <button
                                  onClick={() => {
                                    setRateLimitEditPolicy(policy);
                                    setRateLimitValues(
                                      policy.rateLimits || { maxRequestsPerHour: 100 },
                                    );
                                  }}
                                  className="text-xs text-blue-600 hover:text-blue-700"
                                >
                                  Edit Rate Limits
                                </button>
                                <button
                                  onClick={() => {
                                    setTimeWindowEditPolicy(policy);
                                    setTimeWindowEntries(
                                      policy.timeWindows.length > 0
                                        ? policy.timeWindows.map((tw) => ({ ...tw }))
                                        : [],
                                    );
                                  }}
                                  className="text-xs text-blue-600 hover:text-blue-700"
                                >
                                  Edit Time Windows ({policy.timeWindows.length})
                                </button>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add Policy — full wizard */}
              {showAddPolicy && (
                <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-4">
                  <PolicyWizard
                    agentId={agentId}
                    agentName={agentName}
                    connectionId={connection.connectionId}
                    connectionLabel={connection.connectionLabel}
                    connectionProvider={connection.connectionProvider}
                    connectionService={connection.connectionService}
                    onCreated={handlePolicyCreated}
                    onCancel={() => setShowAddPolicy(false)}
                  />
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Reconnect Dialog (z-50, on top of modal) */}
      {showReconnect && (() => {
        const credType = serviceConfig?.credentialType;
        const isInline = credType === "bot_token" || credType === "api_key";
        const provider = serviceConfig?.provider;
        const isCredentialUpdate = isInline && connection.connectionStatus !== "needs_reauth";

        const placeholders: Record<string, string> = {
          telegram: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ",
          slack: "xoxb-...",
          anthropic: "sk-ant-api...",
          openai: "sk-...",
          gemini: "AIza...",
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
              <h3 className="text-lg font-semibold text-foreground">
                {isCredentialUpdate ? "Update credential for" : "Reconnect"} {connection.connectionLabel}
              </h3>
              <p className="mt-2 text-sm text-muted">
                {isInline
                  ? isCredentialUpdate
                    ? `Enter a replacement ${credType === "bot_token" ? "bot token" : "API key"}. Existing policies and settings will be preserved.`
                    : `Enter a new ${credType === "bot_token" ? "bot token" : "API key"} to restore access. Existing policies and settings will be preserved.`
                  : "Your connection needs to be reauthorized. Existing policies and settings will be preserved. You will be redirected to sign in again."}
              </p>

              {isInline && connection.credentialPreview && (
                <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  <div>
                    {connection.credentialPreview.primaryLabel}: <span className="font-mono">{connection.credentialPreview.primaryMasked}</span>
                  </div>
                  {connection.credentialPreview.secondaryLabel && connection.credentialPreview.secondaryMasked && (
                    <div className="mt-1">
                      {connection.credentialPreview.secondaryLabel}: <span className="font-mono">{connection.credentialPreview.secondaryMasked}</span>
                    </div>
                  )}
                  {connection.credentialPreview.tertiaryLabel && connection.credentialPreview.tertiaryValue && (
                    <div className="mt-1">
                      {connection.credentialPreview.tertiaryLabel}: {connection.credentialPreview.tertiaryValue}
                    </div>
                  )}
                </div>
              )}

              {isInline && provider === "trello" && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-foreground">
                    Power-Up API Key
                  </label>
                  <input
                    type="text"
                    value={reconnectAppKey}
                    onChange={(e) => setReconnectAppKey(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="32-character API key from Power-Up settings"
                  />
                </div>
              )}

              {isInline && provider === "jira" && (
                <>
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-foreground">
                      Jira Site URL
                    </label>
                    <input
                      type="text"
                      value={reconnectAppKey}
                      onChange={(e) => setReconnectAppKey(e.target.value)}
                      className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="mycompany.atlassian.net"
                    />
                  </div>
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-foreground">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={reconnectEmail}
                      onChange={(e) => setReconnectEmail(e.target.value)}
                      className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="you@company.com"
                    />
                  </div>
                </>
              )}

              {isInline && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-foreground">
                    {credType === "bot_token" ? "Bot Token" : provider === "trello" ? "User Token" : provider === "jira" ? "API Token" : "API Key"}
                  </label>
                  <div className="relative mt-1">
                    <input
                      type={reconnectShowKey ? "text" : "password"}
                      value={reconnectCredential}
                      onChange={(e) => setReconnectCredential(e.target.value)}
                      className="block w-full rounded-md border border-border bg-white px-3 py-2 pr-10 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder={placeholders[provider ?? ""] ?? "Enter credential"}
                    />
                    <button
                      type="button"
                      onClick={() => setReconnectShowKey(!reconnectShowKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
                    >
                      {reconnectShowKey ? (
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
              <div className="mt-5 flex justify-end gap-3">
                <button
                  onClick={() => {
                    setShowReconnect(false);
                    setReconnectCredential("");
                    setReconnectAppKey("");
                    setReconnectEmail("");
                    setReconnectShowKey(false);
                    setError(null);
                  }}
                  disabled={reconnecting}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReconnect}
                  disabled={reconnecting || (isInline && !reconnectCredential.trim()) || (provider === "trello" && !reconnectAppKey.trim()) || (provider === "jira" && (!reconnectAppKey.trim() || !reconnectEmail.trim()))}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {reconnecting ? (isInline ? "Saving..." : "Redirecting...") : isCredentialUpdate ? "Update credential" : "Reconnect"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Revocation Confirmation (z-50, on top of modal) */}
      {showRevokeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Revoke Connection</h3>
            <p className="mt-2 text-sm text-muted">
              Are you sure you want to revoke{" "}
              <span className="font-medium text-foreground">{connection.connectionLabel}</span>?
              This will also revoke all {connection.policies.length} associated policies.
            </p>
            <div className="mt-3 rounded-md bg-yellow-50 border border-yellow-200 p-3">
              <p className="text-sm text-yellow-800">
                {isRevocationInstant(connection.connectionService as ServiceId)
                  ? "Agents will immediately and permanently lose access to this data."
                  : "Agents will immediately lose access. Previously issued tokens (Model A) may remain valid for up to 1 hour."}
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setShowRevokeConfirm(false)}
                disabled={revoking}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {revoking ? "Revoking..." : "Revoke"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sub-editor modals (z-50) ─────────────────── */}

      {/* Allowlist Editor */}
      {allowlistEditPolicy && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12">
          <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Edit Allowlists</h3>
            <p className="mt-1 text-sm text-muted">
              Define which API endpoints this agent can access.
            </p>
            <div className="mt-4 space-y-3">
              {allowlistEntries.map((entry, idx) => (
                <div key={idx} className="rounded-lg border border-border bg-gray-50 p-3">
                  <div className="mb-2">
                    <label className="text-xs font-medium text-foreground">Base URL</label>
                    <input
                      type="text"
                      value={entry.baseUrl}
                      onChange={(e) => {
                        const updated = [...allowlistEntries];
                        updated[idx]!.baseUrl = e.target.value;
                        setAllowlistEntries(updated);
                      }}
                      className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm"
                      placeholder="https://api.example.com"
                    />
                  </div>
                  <div className="mb-2">
                    <label className="text-xs font-medium text-foreground">HTTP Methods</label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {["GET", "POST", "PUT", "DELETE", "PATCH"].map((method) => (
                        <label key={method} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={entry.methods.includes(method)}
                            onChange={(e) => {
                              const updated = [...allowlistEntries];
                              if (e.target.checked) {
                                updated[idx]!.methods = [...updated[idx]!.methods, method];
                              } else {
                                updated[idx]!.methods = updated[idx]!.methods.filter((m) => m !== method);
                              }
                              setAllowlistEntries(updated);
                            }}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <span className="text-xs">{method}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="mb-2">
                    <label className="text-xs font-medium text-foreground">Path Patterns (comma-separated)</label>
                    <input
                      type="text"
                      value={entry.pathPatterns.join(", ")}
                      onChange={(e) => {
                        const updated = [...allowlistEntries];
                        updated[idx]!.pathPatterns = e.target.value.split(",").map((p) => p.trim());
                        setAllowlistEntries(updated);
                      }}
                      className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm font-mono"
                      placeholder="/v1/users, /v1/posts/*"
                    />
                  </div>
                  <button
                    onClick={() => setAllowlistEntries(allowlistEntries.filter((_, i) => i !== idx))}
                    className="text-xs text-red-600 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                onClick={() => setAllowlistEntries([...allowlistEntries, { baseUrl: "", methods: ["GET"], pathPatterns: [""] }])}
                className="w-full rounded-md border border-dashed border-border py-2 text-sm font-medium text-muted hover:border-blue-500 hover:text-blue-600"
              >
                + Add Allowlist Rule
              </button>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setAllowlistEditPolicy(null)}
                disabled={savingAllowlists}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveAllowlists}
                disabled={savingAllowlists}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {savingAllowlists ? "Saving..." : "Save Allowlists"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rate Limits Editor */}
      {rateLimitEditPolicy && rateLimitValues && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Edit Rate Limits</h3>
            <p className="mt-1 text-sm text-muted">
              Configure request rate limits and payload size constraints.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-foreground">Max Requests per Hour</label>
                <input
                  type="number"
                  value={rateLimitValues.maxRequestsPerHour}
                  onChange={(e) => setRateLimitValues({ ...rateLimitValues, maxRequestsPerHour: parseInt(e.target.value) || 0 })}
                  className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
                  min="1"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground">Max Payload Size (bytes, optional)</label>
                <input
                  type="number"
                  value={rateLimitValues.maxPayloadSizeBytes || ""}
                  onChange={(e) => {
                    const { maxPayloadSizeBytes: _, ...rest } = rateLimitValues;
                    setRateLimitValues(e.target.value ? { ...rateLimitValues, maxPayloadSizeBytes: parseInt(e.target.value) } : rest);
                  }}
                  className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
                  placeholder="e.g., 1048576 for 1MB"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground">Max Response Size (bytes, optional)</label>
                <input
                  type="number"
                  value={rateLimitValues.maxResponseSizeBytes || ""}
                  onChange={(e) => {
                    const { maxResponseSizeBytes: _, ...rest } = rateLimitValues;
                    setRateLimitValues(e.target.value ? { ...rateLimitValues, maxResponseSizeBytes: parseInt(e.target.value) } : rest);
                  }}
                  className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
                  placeholder="e.g., 10485760 for 10MB"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-between">
              <button
                onClick={handleDeleteRateLimits}
                disabled={savingRateLimits}
                className="rounded-md px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Delete Limits
              </button>
              <div className="flex gap-3">
                <button
                  onClick={() => setRateLimitEditPolicy(null)}
                  disabled={savingRateLimits}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveRateLimits}
                  disabled={savingRateLimits}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingRateLimits ? "Saving..." : "Save Limits"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Time Windows Editor */}
      {timeWindowEditPolicy && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12">
          <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Edit Time Windows</h3>
            <p className="mt-1 text-sm text-muted">
              Define when the agent is allowed to access this connection.
            </p>
            <div className="mt-4 space-y-3">
              {timeWindowEntries.map((tw, idx) => (
                <div key={idx} className="rounded-lg border border-border bg-gray-50 p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-foreground">Day of Week</label>
                      <select
                        value={tw.dayOfWeek}
                        onChange={(e) => {
                          const updated = [...timeWindowEntries];
                          updated[idx]!.dayOfWeek = parseInt(e.target.value);
                          setTimeWindowEntries(updated);
                        }}
                        className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm"
                      >
                        {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, i) => (
                          <option key={i} value={i}>{day}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-foreground">Timezone</label>
                      <input
                        type="text"
                        value={tw.timezone}
                        onChange={(e) => {
                          const updated = [...timeWindowEntries];
                          updated[idx]!.timezone = e.target.value;
                          setTimeWindowEntries(updated);
                        }}
                        className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm"
                        placeholder="America/New_York"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-foreground">Start Hour (0-23)</label>
                      <input
                        type="number"
                        value={tw.startHour}
                        onChange={(e) => {
                          const updated = [...timeWindowEntries];
                          updated[idx]!.startHour = parseInt(e.target.value) || 0;
                          setTimeWindowEntries(updated);
                        }}
                        className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm"
                        min="0" max="23"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-foreground">End Hour (0-23)</label>
                      <input
                        type="number"
                        value={tw.endHour}
                        onChange={(e) => {
                          const updated = [...timeWindowEntries];
                          updated[idx]!.endHour = parseInt(e.target.value) || 0;
                          setTimeWindowEntries(updated);
                        }}
                        className="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm"
                        min="0" max="23"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => setTimeWindowEntries(timeWindowEntries.filter((_, i) => i !== idx))}
                    className="mt-2 text-xs text-red-600 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                onClick={() => setTimeWindowEntries([...timeWindowEntries, { dayOfWeek: 1, startHour: 9, endHour: 17, timezone: "America/New_York" }])}
                className="w-full rounded-md border border-dashed border-border py-2 text-sm font-medium text-muted hover:border-blue-500 hover:text-blue-600"
              >
                + Add Time Window
              </button>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setTimeWindowEditPolicy(null)}
                disabled={savingTimeWindows}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTimeWindows}
                disabled={savingTimeWindows}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {savingTimeWindows ? "Saving..." : "Save Time Windows"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
