"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";
import { SERVICE_CATALOG, isRevocationInstant, getPolicyTemplate, getActionTemplate, type ServiceId } from "@agenthifive/contracts";
import { toast } from "sonner";
import { HelpTooltip } from "@/components/help-tooltip";
import ConnectionDetailModal from "./connection-detail-modal";
import CreateConnectionModal from "./create-connection-modal";
import type {
  Agent,
  AgentConnection,
  AgentStatus,
  RawApiConnection,
  ConnectionStatus,
} from "./types";
import { STATUS_CONFIG, inferPolicyTier } from "./types";

export default function MyAgentsPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [agentsList, setAgentsList] = useState<Agent[]>([]);
  const [allConnections, setAllConnections] = useState<RawApiConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Connection detail modal state
  const [detailModal, setDetailModal] = useState<{
    agentId: string;
    agentName: string;
    connection: AgentConnection;
    showAddPolicy?: boolean;
  } | null>(null);

  // Create connection modal state
  const [createModal, setCreateModal] = useState<{
    agentId: string;
    agentName: string;
  } | null>(null);

  // Bootstrap secret state
  const [bootstrapSecret, setBootstrapSecret] = useState<string | null>(null);
  const [confirmBootstrap, setConfirmBootstrap] = useState<string | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const agentsRes = await apiFetch("/agents");
      if (!agentsRes.ok) throw new Error("Failed to load agents");
      const agentsData = (await agentsRes.json()) as {
        agents: Array<{
          id: string;
          name: string;
          description: string;
          iconUrl: string | null;
          status: AgentStatus;
          createdAt: string;
        }>;
      };

      const connectionsRes = await apiFetch("/connections");
      if (!connectionsRes.ok) throw new Error("Failed to load connections");
      const connectionsData = (await connectionsRes.json()) as {
        connections: RawApiConnection[];
      };

      // Store all connections for "available" section
      setAllConnections(connectionsData.connections);

      // Group connections by agent, with policies nested under each connection
      const agentsWithConnections = agentsData.agents.map((agent) => {
        const connectionMap = new Map<string, AgentConnection>();

        connectionsData.connections.forEach((connection) => {
          if (!connection.policies || !Array.isArray(connection.policies)) return;

          const agentPolicies = connection.policies.filter(
            (p) => p.agentId === agent.id,
          );
          if (agentPolicies.length === 0) return;

          connectionMap.set(connection.id, {
            connectionId: connection.id,
            connectionLabel: connection.label,
            connectionService: connection.service,
            connectionProvider: connection.provider,
            connectionStatus: connection.status as ConnectionStatus,
            grantedScopes: connection.grantedScopes,
            metadata: connection.metadata ?? null,
            connectionCreatedAt: connection.createdAt,
            credentialPreview: connection.credentialPreview ?? null,
            connectionUpdatedAt: connection.updatedAt,
            policies: agentPolicies.map((policy) => ({
              id: policy.id,
              connectionId: connection.id,
              actionTemplateId: policy.actionTemplateId || null,
              defaultMode: policy.defaultMode,
              stepUpApproval: policy.stepUpApproval,
              allowedModels: policy.allowedModels,
              allowlists: policy.allowlists || [],
              rateLimits: policy.rateLimits || null,
              timeWindows: policy.timeWindows || [],
              providerConstraints: policy.providerConstraints || null,
              securityPreset: policy.securityPreset || null,
              createdAt: connection.createdAt,
            })),
          });
        });

        return {
          ...agent,
          connections: Array.from(connectionMap.values()),
        };
      });

      setAgentsList(agentsWithConnections);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) {
      fetchAgents();
    }
  }, [session, fetchAgents]);

  // Redirect to setup if no agents or agent has no connections (first-time onboarding).
  // Only redirect when the load succeeded (no error) — a 401/network error
  // leaves agentsList empty but shouldn't loop the user to /setup.
  // Skip if user explicitly dismissed the wizard (sessionStorage flag).
  useEffect(() => {
    if (loading || error) return;
    if (typeof window !== "undefined" && sessionStorage.getItem("ah5_skip_setup")) return;
    if (agentsList.length === 0) {
      router.push("/dashboard/setup");
      return;
    }
    const totalConnections = agentsList.reduce((sum, a) => sum + (a.connections?.length ?? 0), 0);
    if (totalConnections === 0) {
      router.push("/dashboard/setup");
    }
  }, [loading, error, agentsList, router]);

  // Update detail modal data when agentsList refreshes
  useEffect(() => {
    if (!detailModal) return;
    const agent = agentsList.find((a) => a.id === detailModal.agentId);
    if (!agent) return;
    const conn = agent.connections.find(
      (c) => c.connectionId === detailModal.connection.connectionId,
    );
    if (conn) {
      setDetailModal((prev) => (prev ? { ...prev, connection: conn } : null));
    }
  }, [agentsList]); // eslint-disable-line react-hooks/exhaustive-deps

  function openDetailModal(agent: Agent, connection: AgentConnection, showAddPolicy = false) {
    setDetailModal({
      agentId: agent.id,
      agentName: agent.name,
      connection,
      showAddPolicy,
    });
  }

  function openGrantAccess(agent: Agent, rawConn: RawApiConnection) {
    // Create an AgentConnection with no policies (for Grant Access flow)
    const conn: AgentConnection = {
      connectionId: rawConn.id,
      connectionLabel: rawConn.label,
      connectionService: rawConn.service,
      connectionProvider: rawConn.provider,
      connectionStatus: rawConn.status as ConnectionStatus,
      grantedScopes: rawConn.grantedScopes,
      metadata: rawConn.metadata ?? null,
      connectionCreatedAt: rawConn.createdAt,
      credentialPreview: rawConn.credentialPreview ?? null,
      connectionUpdatedAt: rawConn.updatedAt,
      policies: [],
    };
    setDetailModal({
      agentId: agent.id,
      agentName: agent.name,
      connection: conn,
      showAddPolicy: true,
    });
  }

  // Revoke connection state
  const [revokeTarget, setRevokeTarget] = useState<AgentConnection | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await apiFetch(`/connections/${revokeTarget.connectionId}/revoke`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to revoke connection");
      setRevokeTarget(null);
      fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke");
    } finally {
      setRevoking(false);
    }
  }

  async function handleBootstrapSecret(agentId: string) {
    setBootstrapLoading(agentId);
    try {
      const res = await apiFetch(`/agents/${agentId}/bootstrap-secret`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      const data = (await res.json()) as { bootstrapSecret: string };
      setBootstrapSecret(data.bootstrapSecret);
      setConfirmBootstrap(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate bootstrap secret");
    } finally {
      setBootstrapLoading(null);
    }
  }

  // Test connection state
  const [testingConnectionId, setTestingConnectionId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail?: string; error?: string; hint?: string } | null>(null);

  async function handleTestConnection(connectionId: string) {
    setTestingConnectionId(connectionId);
    setTestResult(null);
    try {
      const res = await apiFetch(`/connections/${connectionId}/test`, { method: "POST" });
      const data = (await res.json()) as { ok: boolean; detail?: string; error?: string; hint?: string };
      const result: { id: string; ok: boolean; detail?: string; error?: string; hint?: string } = { id: connectionId, ok: data.ok };
      if (data.detail) result.detail = data.detail;
      if (data.error) result.error = data.error;
      if (data.hint) result.hint = data.hint;
      setTestResult(result);
      fetchAgents();
    } catch (err) {
      setTestResult({ id: connectionId, ok: false, error: err instanceof Error ? err.message : "Failed to test connection" });
    } finally {
      setTestingConnectionId(null);
    }
  }

  // Kill switch state
  const [killSwitchConfirm, setKillSwitchConfirm] = useState<string | null>(null);
  const [killSwitchLoading, setKillSwitchLoading] = useState<string | null>(null);
  const [killSwitchResult, setKillSwitchResult] = useState<{ agentId: string; agentName: string; tokensRevoked: number } | null>(null);
  const [enableLoading, setEnableLoading] = useState<string | null>(null);

  async function handleKillSwitch(agentId: string) {
    setKillSwitchLoading(agentId);
    try {
      const res = await apiFetch(`/agents/${agentId}/disable`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      const data = (await res.json()) as { tokensRevoked: number };
      const agent = agentsList.find((a) => a.id === agentId);
      setKillSwitchResult({ agentId, agentName: agent?.name ?? "Agent", tokensRevoked: data.tokensRevoked });
      setKillSwitchConfirm(null);
      fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable agent");
    } finally {
      setKillSwitchLoading(null);
    }
  }

  async function handleEnableAgent(agentId: string) {
    setEnableLoading(agentId);
    try {
      const res = await apiFetch(`/agents/${agentId}/enable`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      toast.success("Agent re-enabled");
      fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable agent");
    } finally {
      setEnableLoading(null);
    }
  }

  // Reconnect state
  const [reconnectTarget, setReconnectTarget] = useState<AgentConnection | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectCredential, setReconnectCredential] = useState("");
  const [reconnectShowKey, setReconnectShowKey] = useState(false);

  // Listen for OAuth reauth popup completion
  useEffect(() => {
    function onPopupMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "connection-oauth-complete") {
        setReconnectTarget(null);
        setReconnectCredential("");
        setReconnectShowKey(false);
        fetchAgents();
      } else if (event.data?.type === "connection-oauth-error") {
        const msg = event.data.error ?? "OAuth reconnection failed";
        setError(msg);
        toast.error("Reconnection failed", { description: msg, duration: 8000 });
      }
    }
    window.addEventListener("message", onPopupMessage);
    return () => window.removeEventListener("message", onPopupMessage);
  }, [fetchAgents]);

  async function handleReconnect() {
    if (!reconnectTarget) return;
    setReconnecting(true);
    setError(null);

    const serviceConfig = SERVICE_CATALOG[reconnectTarget.connectionService as ServiceId];
    const credType = serviceConfig?.credentialType;
    const isInline = credType === "bot_token" || credType === "api_key";

    try {
      if (isInline) {
        const body: Record<string, string> = {};
        if (credType === "bot_token") body.botToken = reconnectCredential;
        else body.apiKey = reconnectCredential;

        const res = await apiFetch(`/connections/${reconnectTarget.connectionId}/reauth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error: string };
          throw new Error(data.error);
        }

        setReconnectTarget(null);
        setReconnectCredential("");
        setReconnectShowKey(false);
        fetchAgents();
      } else {
        const res = await apiFetch(`/connections/${reconnectTarget.connectionId}/reauth`, {
          method: "POST",
        });
        if (!res.ok) {
          const data = (await res.json()) as { error: string };
          throw new Error(data.error);
        }
        const data = (await res.json()) as { authorizationUrl: string };
        window.open(data.authorizationUrl, "oauth-reauth", "width=600,height=700");
        setReconnectTarget(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reconnect");
    } finally {
      setReconnecting(false);
    }
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-foreground">My Agents</h1>
        <p className="mt-4 text-muted">Loading agents...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Agent 🙌</h1>
          <p className="mt-2 text-muted">Your agents and their accounts</p>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-600">{error}</p>
          <button onClick={() => setError(null)} className="mt-1 text-xs text-red-500 underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Bootstrap Secret Display */}
      {bootstrapSecret && (
        <div className="mt-6 rounded-lg border border-yellow-300 bg-yellow-50 p-6">
          <h3 className="text-lg font-semibold text-yellow-800">Bootstrap Secret</h3>
          <p className="mt-1 text-sm text-yellow-700">
            Use this secret to register the agent&apos;s public key. It expires in 1 hour and will not be shown again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="block flex-1 overflow-x-auto rounded bg-white px-3 py-2 font-mono text-sm text-foreground border border-yellow-200">
              {bootstrapSecret}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(bootstrapSecret)}
              className="rounded-md border border-yellow-300 bg-white px-3 py-2 text-sm font-medium text-yellow-800 hover:bg-yellow-100"
            >
              Copy
            </button>
          </div>
          <button
            onClick={() => setBootstrapSecret(null)}
            className="mt-4 rounded-md bg-yellow-600 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-700"
          >
            Done
          </button>
        </div>
      )}

      {/* Agents List */}
      <div className="mt-8">
        {agentsList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
            <p className="text-muted">No agents registered yet.</p>
            <p className="mt-1 text-sm text-muted">
              Visit the{" "}
              <a href="/dashboard/agents" className="text-blue-600 hover:underline">
                Agents
              </a>{" "}
              page to register an agent.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {agentsList.map((agent) => {
              // Connections with policies for this agent
              const agentConnectionIds = new Set(
                agent.connections.map((c) => c.connectionId),
              );

              // Workspace connections without policies for this agent
              const availableConnections = allConnections.filter(
                (c) =>
                  !agentConnectionIds.has(c.id) &&
                  c.status !== "revoked",
              );

              return (
                <div
                  key={agent.id}
                  className="rounded-xl border-2 border-blue-200/50 bg-gradient-to-br from-blue-50 via-purple-50 to-blue-50 p-6 shadow-lg hover:shadow-xl transition-shadow"
                >
                  {/* Disabled banner */}
                  {agent.status === "disabled" && (
                    <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-red-500 text-lg">&#x26D4;</span>
                        <div>
                          <p className="text-sm font-semibold text-red-700">Agent disabled — all access blocked</p>
                          <p className="text-xs text-red-600">Vault requests are rejected. Tokens have been revoked.</p>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-red-600/80 pl-7">
                        If you suspect compromise, <button onClick={() => setConfirmBootstrap(agent.id)} className="font-medium underline hover:text-red-800">regenerate the enrollment key</button> before re-enabling so the old key cannot be reused.
                      </p>
                    </div>
                  )}

                  {/* Agent Header */}
                  <div className="flex items-start gap-4 mb-4">
                    {agent.iconUrl ? (
                      <img
                        src={agent.iconUrl}
                        alt=""
                        className="h-14 w-14 rounded-lg object-cover ring-4 ring-blue-300 ring-opacity-50 shadow-md"
                      />
                    ) : (
                      <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 text-white font-bold text-xl ring-4 ring-blue-300 ring-opacity-50 shadow-md">
                        {agent.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="text-lg font-bold text-foreground">
                          {agent.name}
                        </h3>
                        {agent.connections.length > 0 && (
                          <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
                            {agent.connections.length}{" "}
                            {agent.connections.length === 1
                              ? "app connected"
                              : "apps connected"}
                          </span>
                        )}
                        {confirmBootstrap === agent.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted">Regenerate?</span>
                            <button
                              onClick={() => handleBootstrapSecret(agent.id)}
                              disabled={bootstrapLoading === agent.id}
                              className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors disabled:opacity-50"
                            >
                              {bootstrapLoading === agent.id ? "Generating..." : "Yes"}
                            </button>
                            <button
                              onClick={() => setConfirmBootstrap(null)}
                              className="text-xs font-medium text-muted hover:text-foreground transition-colors"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmBootstrap(agent.id)}
                            className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
                          >
                            Regenerate enrolment key
                          </button>
                        )}
                      </div>
                      {agent.description && (
                        <p className="text-sm text-muted">{agent.description}</p>
                      )}
                      <div className="mt-2 flex items-center gap-4 text-xs text-muted">
                        <span>
                          Created: {new Date(agent.createdAt).toLocaleDateString()}
                        </span>
                        <span className="font-mono opacity-60" title="Agent ID">
                          {agent.id.slice(0, 8)}…
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {agent.status === "disabled" ? (
                        <button
                          onClick={() => handleEnableAgent(agent.id)}
                          disabled={enableLoading === agent.id}
                          className="rounded-md border border-green-300 bg-green-50 px-4 py-2 text-sm font-medium text-green-700 transition-colors hover:bg-green-100 disabled:opacity-50"
                        >
                          {enableLoading === agent.id ? "Enabling..." : "Re-enable agent"}
                        </button>
                      ) : (
                        <>
                          {killSwitchConfirm === agent.id ? (
                            <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-1.5">
                              <span className="text-xs text-red-700">Block all access?</span>
                              <button
                                onClick={() => handleKillSwitch(agent.id)}
                                disabled={killSwitchLoading === agent.id}
                                className="text-xs font-bold text-red-600 hover:text-red-800 disabled:opacity-50"
                              >
                                {killSwitchLoading === agent.id ? "Disabling..." : "Yes, kill"}
                              </button>
                              <button
                                onClick={() => setKillSwitchConfirm(null)}
                                className="text-xs text-muted hover:text-foreground"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setKillSwitchConfirm(agent.id)}
                              className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
                              title="Instantly block all vault access for this agent"
                            >
                              Block Agent Access Immediately
                            </button>
                          )}
                          <button
                            onClick={() => setCreateModal({ agentId: agent.id, agentName: agent.name })}
                            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                          >
                            + Connect app
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Connected Accounts */}
                  {agent.connections.length > 0 && (
                    <div className="border-t border-border pt-4">
                      <h4 className="text-sm font-semibold text-foreground mb-3">
                        Connected apps
                      </h4>
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {agent.connections
                          .sort(
                            (a, b) =>
                              new Date(b.connectionCreatedAt).getTime() -
                              new Date(a.connectionCreatedAt).getTime(),
                          )
                          .map((conn) => (
                            <ConnectionCard
                              key={conn.connectionId}
                              connection={conn}
                              onEdit={() => openDetailModal(agent, conn)}
                              onRevoke={() => setRevokeTarget(conn)}
                              onReconnect={conn.connectionStatus === "needs_reauth" ? () => setReconnectTarget(conn) : undefined}
                              onTest={() => handleTestConnection(conn.connectionId)}
                              testing={testingConnectionId === conn.connectionId}
                              testResult={testResult?.id === conn.connectionId ? testResult : undefined}
                            />
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Available Connections (no policies for this agent) */}
                  {availableConnections.length > 0 && (
                    <div className={`${agent.connections.length > 0 ? "mt-4" : ""} border-t border-border pt-4`}>
                      <h4 className="text-sm font-semibold text-muted mb-3">
                        Accounts needing rules
                      </h4>
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {availableConnections.map((rawConn) => {
                          const serviceConfig =
                            SERVICE_CATALOG[
                              rawConn.service as keyof typeof SERVICE_CATALOG
                            ];
                          const statusConf = STATUS_CONFIG[rawConn.status as ConnectionStatus] ?? STATUS_CONFIG.healthy;
                          const serviceIcon =
                            rawConn.service === "google-gmail"
                              ? "📧"
                              : serviceConfig?.icon || "🔌";

                          return (
                            <div
                              key={rawConn.id}
                              className="rounded-lg border border-dashed border-gray-300 bg-white/60 p-4 opacity-75"
                            >
                              <div className="flex items-start gap-3 mb-3">
                                <span className="text-2xl flex-shrink-0">
                                  {serviceIcon}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <h4 className="font-semibold text-sm text-foreground truncate">
                                    {serviceConfig?.displayName ||
                                      rawConn.service}
                                  </h4>
                                  <p className="text-xs text-muted mt-0.5">
                                    {rawConn.label}
                                  </p>
                                </div>
                                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusConf.bg} ${statusConf.color}`}>
                                  {statusConf.label}
                                </span>
                              </div>
                              <div className="text-center py-2">
                                <p className="text-xs text-muted mb-2">
                                  No rules set — using safe defaults
                                </p>
                                <button
                                  onClick={() =>
                                    openGrantAccess(agent, rawConn)
                                  }
                                  className="text-sm font-medium text-blue-600 hover:text-blue-700"
                                >
                                  + Security settings
                                </button>
                              </div>
                              {/* Test result */}
                              {testResult?.id === rawConn.id && (
                                <div className={`mt-2 rounded-md p-2 text-xs ${
                                  testResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
                                }`}>
                                  {testResult.ok
                                    ? `\u2713 ${testResult.detail}`
                                    : `\u2717 ${testResult.error}${testResult.hint ? ` \u2014 ${testResult.hint}` : ""}`}
                                </div>
                              )}
                              {/* Edit / Test / Revoke footer */}
                              <div className="flex items-center justify-between gap-2 pt-3 mt-2 border-t border-border">
                                <div className="text-xs text-muted whitespace-nowrap">
                                  {new Date(rawConn.createdAt).toLocaleString(undefined, {
                                    day: "numeric",
                                    month: "short",
                                    year: "numeric",
                                  })}
                                </div>
                                <div className="flex items-center gap-3">
                                  <button
                                    onClick={() => openGrantAccess(agent, rawConn)}
                                    className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors whitespace-nowrap"
                                  >
                                    Edit
                                  </button>
                                  {rawConn.status !== "revoked" && (
                                    <button
                                      onClick={() => handleTestConnection(rawConn.id)}
                                      disabled={testingConnectionId === rawConn.id}
                                      className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      {testingConnectionId === rawConn.id ? "Testing..." : "Test"}
                                    </button>
                                  )}
                                  {rawConn.status === "needs_reauth" && (
                                    <button
                                      onClick={() => {
                                        setReconnectTarget({
                                          connectionId: rawConn.id,
                                          connectionLabel: rawConn.label,
                                          connectionService: rawConn.service,
                                          connectionProvider: rawConn.provider,
                                          connectionStatus: rawConn.status as ConnectionStatus,
                                          grantedScopes: rawConn.grantedScopes,
                                          metadata: rawConn.metadata ?? null,
                                          connectionCreatedAt: rawConn.createdAt,
                                          credentialPreview: rawConn.credentialPreview ?? null,
                                          connectionUpdatedAt: rawConn.updatedAt,
                                          policies: [],
                                        });
                                      }}
                                      className="text-xs font-medium text-yellow-600 hover:text-yellow-700 transition-colors whitespace-nowrap"
                                    >
                                      Reconnect
                                    </button>
                                  )}
                                  {rawConn.status !== "revoked" && (
                                    <button
                                      onClick={() => {
                                        setRevokeTarget({
                                          connectionId: rawConn.id,
                                          connectionLabel: rawConn.label,
                                          connectionService: rawConn.service,
                                          connectionProvider: rawConn.provider,
                                          connectionStatus: rawConn.status as ConnectionStatus,
                                          grantedScopes: rawConn.grantedScopes,
                                          metadata: rawConn.metadata ?? null,
                                          connectionCreatedAt: rawConn.createdAt,
                                          credentialPreview: rawConn.credentialPreview ?? null,
                                          connectionUpdatedAt: rawConn.updatedAt,
                                          policies: [],
                                        });
                                      }}
                                      className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors whitespace-nowrap"
                                    >
                                      Block
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* No connections at all */}
                  {agent.connections.length === 0 &&
                    availableConnections.length === 0 && (
                      <div className="border-t border-border pt-4">
                        <p className="text-sm text-muted text-center py-4">
                          No connections yet.{" "}
                          <button
                            onClick={() => setCreateModal({ agentId: agent.id, agentName: agent.name })}
                            className="text-blue-600 hover:underline font-medium"
                          >
                            Add a connection
                          </button>{" "}
                          to get started.
                        </p>
                      </div>
                    )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Connection Detail Modal */}
      {detailModal && (
        <ConnectionDetailModal
          agentId={detailModal.agentId}
          agentName={detailModal.agentName}
          connection={detailModal.connection}
          onClose={() => setDetailModal(null)}
          onRefresh={fetchAgents}
          showAddPolicy={detailModal.showAddPolicy ?? false}
        />
      )}

      {/* Create Connection Modal */}
      {createModal && (
        <CreateConnectionModal
          agentId={createModal.agentId}
          agentName={createModal.agentName}
          existingConnections={allConnections}
          onClose={() => setCreateModal(null)}
          onRefresh={fetchAgents}
        />
      )}

      {/* Reconnect Dialog */}
      {reconnectTarget && (() => {
        const serviceConfig = SERVICE_CATALOG[reconnectTarget.connectionService as ServiceId];
        const credType = serviceConfig?.credentialType;
        const isInline = credType === "bot_token" || credType === "api_key";
        const provider = serviceConfig?.provider;

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
                Reconnect {reconnectTarget.connectionLabel}
              </h3>
              <p className="mt-2 text-sm text-muted">
                {isInline
                  ? `Enter a new ${credType === "bot_token" ? "bot token" : "API key"} to restore access. Existing policies and settings will be preserved.`
                  : "Your connection needs to be reauthorized. Existing policies and settings will be preserved. You will be redirected to sign in again."}
              </p>

              {isInline && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-foreground">
                    {credType === "bot_token" ? "Bot Token" : "API Key"}
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
                    setReconnectTarget(null);
                    setReconnectCredential("");
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
                  disabled={reconnecting || (isInline && !reconnectCredential.trim())}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {reconnecting ? (isInline ? "Saving..." : "Redirecting...") : "Reconnect"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Kill Switch Guidance Modal */}
      {killSwitchResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <svg className="h-5 w-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">
                  {killSwitchResult.agentName} has been disabled
                </h3>
                <p className="text-sm text-muted">
                  {killSwitchResult.tokensRevoked} access token{killSwitchResult.tokensRevoked !== 1 ? "s" : ""} revoked. All vault requests are now blocked.
                </p>
              </div>
            </div>

            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 mb-4">
              <h4 className="text-sm font-semibold text-amber-800 mb-2">Recommended next steps</h4>
              <ol className="text-sm text-amber-700 space-y-2 list-decimal list-inside">
                <li>
                  <strong>Check the Activity log</strong> for any suspicious requests made before access was blocked.
                </li>
                <li>
                  <strong>Review connected accounts</strong> for unauthorized changes (emails sent, files accessed, messages posted).
                </li>
                <li>
                  <strong>Investigate the agent host</strong> — if you suspect compromise, secure the machine before re-enabling.
                </li>
                <li>
                  <strong>Regenerate the enrollment key</strong> before re-enabling so the old key cannot be reused.
                </li>
              </ol>
            </div>

            <div className="flex items-center justify-between">
              <a
                href={`${process.env.NEXT_PUBLIC_DOCS_URL || "/docs"}/security/incident-response`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:text-blue-800 font-medium"
              >
                Full incident response guide &rarr;
              </a>
              <div className="flex gap-3">
                <a
                  href="/dashboard/activity"
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50"
                >
                  View Activity
                </a>
                <button
                  onClick={() => setKillSwitchResult(null)}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Revoke Confirmation Dialog */}
      {revokeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Block Connection</h3>
            <p className="mt-2 text-sm text-muted">
              Are you sure you want to block{" "}
              <span className="font-medium text-foreground">{revokeTarget.connectionLabel}</span>?
              {revokeTarget.policies.length > 0 && (
                <> This will also block all {revokeTarget.policies.length} associated {revokeTarget.policies.length === 1 ? "policy" : "policies"}.</>
              )}
            </p>
            <div className="mt-3 rounded-md bg-yellow-50 border border-yellow-200 p-3">
              <p className="text-sm text-yellow-800">
                {isRevocationInstant(revokeTarget.connectionService as ServiceId)
                  ? "Agents will immediately and permanently lose access to this data."
                  : "Agents will immediately lose access. Previously issued tokens (Model A) may remain valid for up to 1 hour."}
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setRevokeTarget(null)}
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
                {revoking ? "Blocking..." : "Block"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ── Connection Card (one per connection, grouped policies) ──────────

// Helper function to generate dynamic protection status
function getProtectionStatus(connection: AgentConnection, spec: any, primaryPolicy: any, tier: "strict" | "standard" | "minimal" | null, actionTemplateId?: string | null) {
  const hasPolicy = connection.policies.length > 0;
  const hasGuards = spec?.guards && spec.guards.length > 0;
  const hasRateLimits = primaryPolicy?.rateLimits?.maxRequestsPerHour;

  // Check for policy rules (request/response rules from presets)
  const hasRequestRules = spec?.rules?.request && spec.rules.request.length > 0;
  const hasResponseRules = spec?.rules?.response && spec.rules.response.length > 0;
  const hasApprovalRules = spec?.rules?.request?.some((r: any) => r.action === "require_approval");
  const hasPolicyRules = hasRequestRules || hasResponseRules;

  // Fallback: If no spec (legacy policies), check stepUpApproval setting
  const hasApprovalFromSettings = primaryPolicy?.stepUpApproval === "always" || primaryPolicy?.stepUpApproval === "risk_based";

  // Consider protected if has any of these
  const hasAnyProtection = hasGuards || hasRateLimits || hasPolicyRules || hasApprovalFromSettings;

  // Headline - show specific protection level based on tier
  let headline: string;
  if (!hasPolicy) {
    headline = "⚠️ No rules set";
  } else if (tier === "strict") {
    headline = "🔒 Strict Protection";
  } else if (tier === "standard") {
    headline = "🛡️ Balanced Protection";
  } else if (tier === "minimal") {
    headline = "⚠️ Minimal Protection";
  } else if (!hasAnyProtection) {
    headline = "⚠️ Limited protection";
  } else {
    headline = "🛡️ Protected";
  }

  // Subtitle - concise summary based on preset tier, service-aware
  const isTelegram = connection.connectionProvider === "telegram";
  const hasTrustedList = isTelegram && primaryPolicy?.providerConstraints?.allowedChatIds?.length > 0;
  const isSlack = connection.connectionProvider === "slack";
  const hasSlackTrustedList = isSlack && (
    (primaryPolicy?.providerConstraints?.allowedChannelIds?.length ?? 0) > 0 ||
    (primaryPolicy?.providerConstraints?.allowedUserIds?.length ?? 0) > 0
  );

  let subtitle: string;
  if (!hasPolicy) {
    subtitle = "No security policy configured";
  } else if (isTelegram) {
    // Telegram-specific subtitles
    if (hasTrustedList) {
      if (tier === "strict") subtitle = "Trusted contacts only · Media and deletes blocked · Personal info filtered";
      else if (tier === "standard") subtitle = "Trusted contacts only · Personal info filtered";
      else subtitle = "Trusted contacts only";
    } else {
      if (tier === "strict") subtitle = "Receives from anyone · Sending needs approval · Media and deletes blocked · Personal info filtered";
      else if (tier === "standard") subtitle = "Receives from anyone · Sending needs approval · Personal info filtered";
      else if (tier === "minimal") subtitle = "Receives from anyone · No approval required";
      else subtitle = "Receives from anyone";
    }
  } else if (isSlack) {
    // Slack-specific subtitles
    if (hasSlackTrustedList) {
      if (tier === "strict") subtitle = "Trusted channels/users only · Deletes blocked · Personal info filtered";
      else if (tier === "standard") subtitle = "Trusted channels/users only · Personal info filtered";
      else subtitle = "Trusted channels/users only";
    } else {
      if (tier === "strict") subtitle = "All channels · Sending needs approval · Deletes blocked · Personal info filtered";
      else if (tier === "standard") subtitle = "All channels · Sending needs approval · Personal info filtered";
      else if (tier === "minimal") subtitle = "All channels · No approval required";
      else subtitle = "All channels";
    }
  } else if (actionTemplateId?.endsWith("-read")) {
    // Read-only connections: no writes possible, subtitle reflects that
    if (tier === "strict" || tier === "standard") subtitle = "Read-only access · Personal info filtered";
    else subtitle = "Read-only access";
  } else if (tier === "strict") {
    subtitle = "Reads allowed · Writes need approval · Destructive actions blocked · Personal info filtered";
  } else if (tier === "standard") {
    subtitle = "Reads allowed · Writes need approval · Personal info filtered";
  } else if (tier === "minimal") {
    subtitle = "Full access · No approvals required";
  } else {
    // Legacy policies without a stored preset
    const parts: string[] = [];
    if (hasApprovalRules || hasApprovalFromSettings) parts.push("Writes need approval");
    if (hasResponseRules) parts.push("Personal info filtered");
    if (hasRateLimits) parts.push("Rate limited");
    subtitle = parts.length > 0 ? parts.join(" · ") : "Custom policy";
  }

  return { headline, subtitle, hasPolicy };
}

function ConnectionCard({
  connection,
  onEdit,
  onRevoke,
  onReconnect,
  onTest,
  testing,
  testResult,
}: {
  connection: AgentConnection;
  onEdit: () => void;
  onRevoke: () => void;
  onReconnect?: (() => void) | undefined;
  onTest: () => void;
  testing: boolean;
  testResult?: { ok: boolean; detail?: string; error?: string; hint?: string } | undefined;
}) {
  const serviceConfig =
    SERVICE_CATALOG[
      connection.connectionService as keyof typeof SERVICE_CATALOG
    ];
  const statusConfig = STATUS_CONFIG[connection.connectionStatus];
  const serviceIcon =
    connection.connectionService === "google-gmail"
      ? "📧"
      : serviceConfig?.icon || "🔌";

  const docsPath = serviceConfig?.docsPath;

  // Summary from the first (or best) policy
  const primaryPolicy = connection.policies[0];
  const policyCount = connection.policies.length;

  // Infer tier from primary policy
  const tier = primaryPolicy ? inferPolicyTier(primaryPolicy, connection.connectionProvider) : null;
  const spec =
    primaryPolicy?.actionTemplateId && tier
      ? getPolicyTemplate(primaryPolicy.actionTemplateId, tier)
      : null;

  // Rate limit summary
  const rateLimitSummary = primaryPolicy?.rateLimits?.maxRequestsPerHour
    ? `${primaryPolicy.rateLimits.maxRequestsPerHour} req/hr`
    : null;

  const tierColors = {
    strict: "bg-red-100 text-red-700",
    standard: "bg-blue-100 text-blue-700",
    minimal: "bg-green-100 text-green-700",
  };

  // Get dynamic protection status
  const protectionStatus = getProtectionStatus(connection, spec, primaryPolicy, tier, primaryPolicy?.actionTemplateId);

  // Derive card title from action template label (e.g., "Read Gmail emails" vs "Send and manage Gmail emails")
  const actionTemplate = primaryPolicy?.actionTemplateId
    ? getActionTemplate(primaryPolicy.actionTemplateId)
    : null;
  const cardTitle = connection.connectionLabel
    || actionTemplate?.label
    || serviceConfig?.displayName
    || connection.connectionService;

  return (
    <div
      className={`group rounded-lg border border-border bg-white overflow-hidden hover:shadow-lg hover:border-blue-400 transition-all flex flex-col ${
        connection.connectionStatus === "healthy"
          ? "border-t-4 border-t-green-200"
          : connection.connectionStatus === "revoked"
            ? "border-t-4 border-t-red-200"
            : connection.connectionStatus === "needs_reauth"
              ? "border-t-4 border-t-yellow-200"
              : ""
      }`}
    >
      <div className="p-3 flex-1 flex flex-col">
        {/* Header: Icon, Name, Status */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl flex-shrink-0">{serviceIcon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 min-w-0">
                <h4 className="font-semibold text-sm text-foreground truncate">
                  {cardTitle}
                </h4>
                {docsPath && (
                  <HelpTooltip docsPath={docsPath}>
                    Learn how to configure and manage this {serviceConfig?.displayName || "service"} connection.
                  </HelpTooltip>
                )}
              </div>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0 ${statusConfig.bg} ${statusConfig.color}`}
              >
                {statusConfig.label}
              </span>
            </div>
          </div>
        </div>

        {/* Dynamic Protection Status */}
        <div className="mb-2">
          <div className="mb-1">
            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
              protectionStatus.headline.includes("⚠️")
                ? "bg-yellow-100 text-yellow-700"
                : "bg-blue-100 text-blue-700"
            }`}>
              {protectionStatus.headline}
            </span>
          </div>

          <p className="text-xs text-muted leading-tight">
            {protectionStatus.subtitle}
          </p>
        </div>

        {/* Test result */}
        {testResult && (
          <div className={`mt-2 rounded-md p-2 text-xs ${
            testResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
          }`}>
            {testResult.ok
              ? `\u2713 ${testResult.detail}`
              : `\u2717 ${testResult.error}${testResult.hint ? ` \u2014 ${testResult.hint}` : ""}`}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-2 mt-auto border-t border-border">
          <div className="text-xs text-muted whitespace-nowrap">
            {new Date(connection.connectionCreatedAt).toLocaleString(undefined, {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onEdit}
              className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors whitespace-nowrap"
            >
              Settings
            </button>
            {connection.connectionStatus !== "revoked" && (
              <button
                onClick={onTest}
                disabled={testing}
                className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {testing ? "Testing..." : "Test"}
              </button>
            )}
            {connection.connectionStatus === "needs_reauth" && onReconnect && (
              <button
                onClick={onReconnect}
                className="text-xs font-medium text-yellow-600 hover:text-yellow-700 transition-colors whitespace-nowrap"
              >
                Reconnect
              </button>
            )}
            {connection.connectionStatus !== "revoked" && (
              <button
                onClick={onRevoke}
                className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors whitespace-nowrap"
              >
                Block
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
