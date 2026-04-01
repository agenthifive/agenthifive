"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";

interface Agent {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  status: "created" | "active" | "disabled";
  enrolledAt: string | null;
  createdAt: string;
}

export default function AgentsPage() {
  const { data: session } = useSession();
  const [agentsList, setAgentsList] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Registration form state
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formIconUrl, setFormIconUrl] = useState("");
  const [creating, setCreating] = useState(false);

  // Bootstrap secret display (used after creation and after bootstrap-secret generation)
  const [bootstrapSecret, setBootstrapSecret] = useState<string | null>(null);

  // Agent action state
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmBootstrap, setConfirmBootstrap] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchAgents = useCallback(async (retry = true) => {
    try {
      const res = await apiFetch("/agents");
      if (res.ok) {
        const data = (await res.json()) as { agents: Agent[] };
        setAgentsList(data.agents);
        setLoading(false);
        return;
      }
      if (retry) {
        setTimeout(() => fetchAgents(false), 1000);
        return;
      }
      setError("Failed to load agents");
    } catch {
      if (retry) {
        setTimeout(() => fetchAgents(false), 1000);
        return;
      }
      setError("Failed to load agents");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (session) {
      fetchAgents();
    }
  }, [session, fetchAgents]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setBootstrapSecret(null);

    try {
      const res = await apiFetch("/agents", {
        method: "POST",
        body: JSON.stringify({
          name: formName,
          description: formDescription || undefined,
          iconUrl: formIconUrl || undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { agent: Agent; bootstrapSecret: string };
      setAgentsList((prev) => [...prev, data.agent]);
      setBootstrapSecret(data.bootstrapSecret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(agentId: string) {
    setActionLoading(agentId);
    try {
      const res = await apiFetch(`/agents/${agentId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      setAgentsList((prev) => prev.filter((a) => a.id !== agentId));
      setConfirmDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleBootstrapSecret(agentId: string) {
    setActionLoading(agentId);
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
      setActionLoading(null);
    }
  }

  async function handleDisable(agentId: string) {
    setActionLoading(agentId);
    try {
      const res = await apiFetch(`/agents/${agentId}/disable`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      setAgentsList((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, status: "disabled" as const } : a)),
      );
      setConfirmDisable(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable agent");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleEnable(agentId: string) {
    setActionLoading(agentId);
    try {
      const res = await apiFetch(`/agents/${agentId}/enable`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      const data = (await res.json()) as { status: "created" | "active" };
      setAgentsList((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, status: data.status } : a)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable agent");
    } finally {
      setActionLoading(null);
    }
  }

  function resetForm() {
    setShowForm(false);
    setFormName("");
    setFormDescription("");
    setFormIconUrl("");
    setBootstrapSecret(null);
  }

  function statusBadge(status: Agent["status"]) {
    switch (status) {
      case "created":
        return (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            Awaiting Bootstrap
          </span>
        );
      case "active":
        return (
          <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
            Active
          </span>
        );
      case "disabled":
        return (
          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
            Disabled
          </span>
        );
    }
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-foreground">Agents</h1>
        <p className="mt-4 text-muted">Loading agents...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Agents</h1>
          <p className="mt-2 text-muted">Register and manage your AI agents.</p>
        </div>
        {!showForm && !bootstrapSecret && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Register Agent
          </button>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={() => setError(null)}
            className="mt-1 text-xs text-red-500 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Bootstrap Secret Display */}
      {bootstrapSecret && (
        <div className="mt-6 rounded-lg border border-yellow-300 bg-yellow-50 p-6">
          <h3 className="text-lg font-semibold text-yellow-800">Enrolment Key</h3>
          <p className="mt-1 text-sm text-yellow-700">
            Use this secret to register the agent&apos;s public key. It expires in 1 hour and will not be shown again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="block flex-1 overflow-x-auto rounded bg-white px-3 py-2 font-mono text-sm text-foreground border border-yellow-200">
              {bootstrapSecret}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(bootstrapSecret);
              }}
              className="rounded-md border border-yellow-300 bg-white px-3 py-2 text-sm font-medium text-yellow-800 hover:bg-yellow-100"
            >
              Copy
            </button>
          </div>
          <button
            onClick={resetForm}
            className="mt-4 rounded-md bg-yellow-600 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-700"
          >
            Done
          </button>
        </div>
      )}

      {/* Registration Form */}
      {showForm && !bootstrapSecret && (
        <div className="mt-6 max-w-xl rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground">Register Agent</h2>
          <form onSubmit={handleCreate} className="mt-4 space-y-4">
            <div>
              <label htmlFor="agent-name" className="block text-sm font-medium text-foreground">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                id="agent-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="My AI Agent"
                required
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="agent-description" className="block text-sm font-medium text-foreground">
                Description
              </label>
              <textarea
                id="agent-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="What does this agent do?"
                rows={3}
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="agent-icon" className="block text-sm font-medium text-foreground">
                Icon URL
              </label>
              <input
                id="agent-icon"
                type="url"
                value={formIconUrl}
                onChange={(e) => setFormIconUrl(e.target.value)}
                placeholder="https://example.com/icon.png"
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <p className="text-xs text-muted">
              A bootstrap secret will be generated automatically. You will need it to register the agent.
            </p>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={creating || !formName.trim()}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? "Creating..." : "Create Agent"}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Agents List */}
      <div className="mt-8">
        {agentsList.length === 0 && !showForm ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
            <p className="text-muted">No agents registered yet.</p>
            <p className="mt-1 text-sm text-muted">
              Register an agent to start binding policies and delegating authority.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agentsList.map((agent) => (
              <div
                key={agent.id}
                className="rounded-lg border border-border bg-card p-6"
              >
                <div className="flex items-start gap-4">
                  {agent.iconUrl ? (
                    <img
                      src={agent.iconUrl}
                      alt=""
                      className="h-12 w-12 rounded-md object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-md bg-blue-100 text-blue-600 font-bold text-xl">
                      {agent.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground truncate">{agent.name}</h3>
                    {agent.description && (
                      <p className="mt-1 text-sm text-muted line-clamp-2">{agent.description}</p>
                    )}
                    <div className="mt-2">{statusBadge(agent.status)}</div>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-3 text-xs text-muted">
                  <span className="truncate">ID: <code className="font-mono text-xs">{agent.id}</code></span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  Created: {new Date(agent.createdAt).toLocaleDateString()}
                  {agent.enrolledAt && (
                    <> | Enrolled: {new Date(agent.enrolledAt).toLocaleDateString()}</>
                  )}
                </div>

                {/* Action buttons */}
                <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
                  {confirmBootstrap === agent.id ? (
                    <div className="flex flex-1 items-center gap-2">
                      <span className="text-xs text-yellow-700">Generate bootstrap secret?</span>
                      <button
                        onClick={() => handleBootstrapSecret(agent.id)}
                        disabled={actionLoading === agent.id}
                        className="rounded px-2 py-1 text-xs font-medium bg-yellow-600 text-white hover:bg-yellow-700 disabled:opacity-50"
                      >
                        {actionLoading === agent.id ? "..." : "Yes"}
                      </button>
                      <button
                        onClick={() => setConfirmBootstrap(null)}
                        className="rounded px-2 py-1 text-xs font-medium border border-border text-foreground hover:bg-gray-100"
                      >
                        No
                      </button>
                    </div>
                  ) : confirmDisable === agent.id ? (
                    <div className="flex flex-1 items-center gap-2">
                      <span className="text-xs text-red-700">Disable agent? All tokens will be revoked.</span>
                      <button
                        onClick={() => handleDisable(agent.id)}
                        disabled={actionLoading === agent.id}
                        className="rounded px-2 py-1 text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {actionLoading === agent.id ? "..." : "Yes"}
                      </button>
                      <button
                        onClick={() => setConfirmDisable(null)}
                        className="rounded px-2 py-1 text-xs font-medium border border-border text-foreground hover:bg-gray-100"
                      >
                        No
                      </button>
                    </div>
                  ) : confirmDelete === agent.id ? (
                    <div className="flex flex-1 items-center gap-2">
                      <span className="text-xs text-red-700">Delete agent permanently?</span>
                      <button
                        onClick={() => handleDelete(agent.id)}
                        disabled={actionLoading === agent.id}
                        className="rounded px-2 py-1 text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {actionLoading === agent.id ? "..." : "Yes"}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="rounded px-2 py-1 text-xs font-medium border border-border text-foreground hover:bg-gray-100"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <>
                      {agent.status !== "disabled" && (
                        <button
                          onClick={() => setConfirmBootstrap(agent.id)}
                          className="rounded px-2.5 py-1 text-xs font-medium border border-blue-300 text-blue-700 hover:bg-blue-50"
                        >
                          Regenerate enrolment key
                        </button>
                      )}
                      {agent.status === "disabled" ? (
                        <button
                          onClick={() => handleEnable(agent.id)}
                          disabled={actionLoading === agent.id}
                          className="rounded px-2.5 py-1 text-xs font-medium border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-50"
                        >
                          {actionLoading === agent.id ? "..." : "Enable"}
                        </button>
                      ) : (
                        <button
                          onClick={() => setConfirmDisable(agent.id)}
                          className="rounded px-2.5 py-1 text-xs font-medium border border-red-300 text-red-600 hover:bg-red-50"
                        >
                          Disable
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmDelete(agent.id)}
                        className="rounded px-2.5 py-1 text-xs font-medium border border-red-300 text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
