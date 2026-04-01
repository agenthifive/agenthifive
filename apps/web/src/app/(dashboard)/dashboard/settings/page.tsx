"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";

interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

interface Token {
  id: string;
  name: string;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  isExpired: boolean;
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Token state
  const [tokensList, setTokensList] = useState<Token[]>([]);
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenExpiry, setTokenExpiry] = useState(30);
  const [creatingToken, setCreatingToken] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Version info
  const [backendVersion, setBackendVersion] = useState("Loading...");

  useEffect(() => {
    apiFetch("/version")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { buildNumber?: string; buildDate?: string } | null) => {
        if (data?.buildNumber && data.buildNumber !== "dev") {
          setBackendVersion(`Build #${data.buildNumber} \u00b7 ${data.buildDate}`);
        } else {
          setBackendVersion("Development");
        }
      })
      .catch(() => setBackendVersion("Unavailable"));
  }, []);

  const fetchTokens = useCallback(async () => {
    try {
      const res = await apiFetch("/tokens");
      if (res.ok) {
        const data = (await res.json()) as { tokens: Token[] };
        setTokensList(data.tokens);
      }
    } catch {
      // Tokens section is non-critical — silently ignore
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchWorkspace() {
      try {
        const res = await apiFetch("/workspaces/current");
        if (!res.ok) {
          throw new Error("Failed to load workspace");
        }
        const data = (await res.json()) as Workspace;
        if (!cancelled) {
          setWorkspace(data);
          setName(data.name);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    if (session) {
      fetchWorkspace();
      fetchTokens();
    }

    return () => {
      cancelled = true;
    };
  }, [session, fetchTokens]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMessage(null);

    try {
      const res = await apiFetch("/workspaces/current", {
        method: "PUT",
        body: JSON.stringify({ name }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const updated = (await res.json()) as Workspace;
      setWorkspace(updated);
      setName(updated.name);
      setSaveMessage("Workspace updated successfully.");
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateToken(e: React.FormEvent) {
    e.preventDefault();
    setCreatingToken(true);
    try {
      const res = await apiFetch("/tokens", {
        method: "POST",
        body: JSON.stringify({ name: tokenName, expiresInDays: tokenExpiry }),
      });
      if (res.ok) {
        const data = (await res.json()) as { token: Token; plainToken: string };
        setCreatedToken(data.plainToken);
        setTokensList((prev) => [...prev, data.token]);
        setTokenName("");
        setShowTokenForm(false);
      }
    } catch {
      // handled by UI state
    } finally {
      setCreatingToken(false);
    }
  }

  async function handleRevokeToken(id: string) {
    const res = await apiFetch(`/tokens/${id}`, { method: "DELETE" });
    if (res.ok) {
      setTokensList((prev) => prev.filter((t) => t.id !== id));
    }
  }

  function handleCopy() {
    if (createdToken) {
      navigator.clipboard.writeText(createdToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (loading) {
    return <p className="mt-4 text-muted">Loading workspace...</p>;
  }

  if (error) {
    return <p className="mt-4 text-red-600">{error}</p>;
  }

  return (
    <div className="space-y-8">
      {/* Workspace Settings */}
      <div className="max-w-xl">
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground">Workspace</h2>

          <form onSubmit={handleSave} className="mt-4 space-y-4">
            <div>
              <label htmlFor="workspace-name" className="block text-sm font-medium text-foreground">
                Name
              </label>
              <input
                id="workspace-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground">Workspace ID</label>
              <p className="mt-1 text-sm font-mono text-muted">{workspace?.id}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground">Owner</label>
              <p className="mt-1 text-sm text-muted">{session?.user.email}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground">Created</label>
              <p className="mt-1 text-sm text-muted">
                {workspace?.createdAt ? new Date(workspace.createdAt).toLocaleDateString() : "—"}
              </p>
            </div>

            {saveMessage && (
              <p
                className={`text-sm ${saveMessage.includes("success") ? "text-green-600" : "text-red-600"}`}
              >
                {saveMessage}
              </p>
            )}

            <button
              type="submit"
              disabled={saving || name === workspace?.name}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </form>
        </div>
      </div>

      {/* API Tokens */}
      <div className="max-w-xl">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">API Tokens</h2>
            {!showTokenForm && !createdToken && (
              <button
                onClick={() => setShowTokenForm(true)}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              >
                Generate Token
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            Personal access tokens authenticate API requests via the X-API-Key header.
            Use them in Swagger UI or external tools.
          </p>

          {/* Token created — shown once */}
          {createdToken && (
            <div className="mt-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4">
              <h3 className="text-sm font-semibold text-yellow-800">Token Created</h3>
              <p className="mt-1 text-xs text-yellow-700">
                Copy this token now. It will not be shown again.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="block flex-1 overflow-x-auto rounded border border-yellow-200 bg-white px-3 py-2 font-mono text-xs text-foreground">
                  {createdToken}
                </code>
                <button
                  onClick={handleCopy}
                  className="rounded-md border border-yellow-300 bg-white px-3 py-2 text-sm font-medium text-yellow-800 hover:bg-yellow-100"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <button
                onClick={() => { setCreatedToken(null); setCopied(false); }}
                className="mt-3 rounded-md bg-yellow-600 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-700"
              >
                Done
              </button>
            </div>
          )}

          {/* Create form */}
          {showTokenForm && !createdToken && (
            <form onSubmit={handleCreateToken} className="mt-4 space-y-3">
              <div>
                <label htmlFor="token-name" className="block text-sm font-medium text-foreground">
                  Token Name <span className="text-red-500">*</span>
                </label>
                <input
                  id="token-name"
                  type="text"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  placeholder="e.g. CI/CD Pipeline"
                  required
                  maxLength={100}
                  className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="token-expiry" className="block text-sm font-medium text-foreground">
                  Expires In
                </label>
                <select
                  id="token-expiry"
                  value={tokenExpiry}
                  onChange={(e) => setTokenExpiry(Number(e.target.value))}
                  className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={creatingToken || !tokenName.trim()}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creatingToken ? "Creating..." : "Generate"}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowTokenForm(false); setTokenName(""); }}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Token list */}
          <div className="mt-4 space-y-3">
            {tokensList.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <span className="text-sm font-medium text-foreground">{t.name}</span>
                  {t.isExpired && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
                      Expired
                    </span>
                  )}
                  <div className="mt-0.5 flex gap-3 text-xs text-muted">
                    <span>Created {new Date(t.createdAt).toLocaleDateString()}</span>
                    <span>Expires {new Date(t.expiresAt).toLocaleDateString()}</span>
                    {t.lastUsedAt && (
                      <span>Last used {new Date(t.lastUsedAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRevokeToken(t.id)}
                  className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  Revoke
                </button>
              </div>
            ))}
            {tokensList.length === 0 && !showTokenForm && !createdToken && (
              <p className="text-sm text-muted">No active tokens.</p>
            )}
          </div>
        </div>
      </div>

      {/* About */}
      <div className="max-w-xl">
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground">About</h2>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Frontend</span>
              <span className="font-mono text-foreground">
                {process.env.NEXT_PUBLIC_BUILD_NUMBER
                  ? `Build #${process.env.NEXT_PUBLIC_BUILD_NUMBER} \u00b7 ${process.env.NEXT_PUBLIC_BUILD_DATE}`
                  : "Development"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Backend</span>
              <span className="font-mono text-foreground">{backendVersion}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
