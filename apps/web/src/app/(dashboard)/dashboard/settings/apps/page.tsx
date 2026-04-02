"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";
import { HelpTooltip } from "@/components/help-tooltip";

interface OAuthApp {
  id: string;
  provider: string;
  clientId: string;
  tenantId: string | null;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export default function AppsPage() {
  const { data: session } = useSession();

  const [oauthApps, setOauthApps] = useState<OAuthApp[]>([]);
  const [callbackUrl, setCallbackUrl] = useState("");

  // Google form
  const [showGoogleForm, setShowGoogleForm] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [googleLabel, setGoogleLabel] = useState("");
  const [savingGoogle, setSavingGoogle] = useState(false);
  const [googleMessage, setGoogleMessage] = useState<string | null>(null);

  // Microsoft form
  const [showMicrosoftForm, setShowMicrosoftForm] = useState(false);
  const [microsoftClientId, setMicrosoftClientId] = useState("");
  const [microsoftClientSecret, setMicrosoftClientSecret] = useState("");
  const [microsoftTenantId, setMicrosoftTenantId] = useState("");
  const [microsoftLabel, setMicrosoftLabel] = useState("");
  const [savingMicrosoft, setSavingMicrosoft] = useState(false);
  const [microsoftMessage, setMicrosoftMessage] = useState<string | null>(null);

  const [copiedCallback, setCopiedCallback] = useState(false);

  const fetchOauthApps = useCallback(async () => {
    try {
      const res = await apiFetch("/workspace-oauth-apps");
      if (res.ok) {
        const data = (await res.json()) as { apps: OAuthApp[]; callbackUrl: string };
        setOauthApps(data.apps);
        setCallbackUrl(data.callbackUrl);
      }
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    if (session) {
      fetchOauthApps();
    }
  }, [session, fetchOauthApps]);

  function handleCopyCallback() {
    navigator.clipboard.writeText(callbackUrl);
    setCopiedCallback(true);
    setTimeout(() => setCopiedCallback(false), 2000);
  }

  async function handleSaveGoogleApp(e: React.FormEvent) {
    e.preventDefault();
    setSavingGoogle(true);
    setGoogleMessage(null);

    try {
      const res = await apiFetch("/workspace-oauth-apps", {
        method: "POST",
        body: JSON.stringify({
          provider: "google",
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          label: googleLabel || "My Google App",
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      setGoogleMessage("Google OAuth app saved.");
      setShowGoogleForm(false);
      setGoogleClientId("");
      setGoogleClientSecret("");
      setGoogleLabel("");
      fetchOauthApps();
    } catch (err) {
      setGoogleMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingGoogle(false);
    }
  }

  async function handleSaveMicrosoftApp(e: React.FormEvent) {
    e.preventDefault();
    setSavingMicrosoft(true);
    setMicrosoftMessage(null);

    try {
      const res = await apiFetch("/workspace-oauth-apps", {
        method: "POST",
        body: JSON.stringify({
          provider: "microsoft",
          clientId: microsoftClientId,
          clientSecret: microsoftClientSecret,
          ...(microsoftTenantId ? { tenantId: microsoftTenantId } : {}),
          label: microsoftLabel || "My Microsoft App",
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      setMicrosoftMessage("Microsoft OAuth app saved.");
      setShowMicrosoftForm(false);
      setMicrosoftClientId("");
      setMicrosoftClientSecret("");
      setMicrosoftTenantId("");
      setMicrosoftLabel("");
      fetchOauthApps();
    } catch (err) {
      setMicrosoftMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingMicrosoft(false);
    }
  }

  async function handleDeleteOauthApp(id: string) {
    if (!confirm("Delete this OAuth app? Connections using it will need to be re-authenticated if no corporate credentials are configured.")) {
      return;
    }
    const res = await apiFetch(`/workspace-oauth-apps/${id}`, { method: "DELETE" });
    if (res.ok) {
      setOauthApps((prev) => prev.filter((a) => a.id !== id));
    }
  }

  function handleEditGoogleApp(app: OAuthApp) {
    setGoogleClientId(app.clientId);
    setGoogleClientSecret("");
    setGoogleLabel(app.label);
    setShowGoogleForm(true);
  }

  function handleEditMicrosoftApp(app: OAuthApp) {
    setMicrosoftClientId(app.clientId);
    setMicrosoftClientSecret("");
    setMicrosoftTenantId(app.tenantId ?? "");
    setMicrosoftLabel(app.label);
    setShowMicrosoftForm(true);
  }

  const hasGoogle = oauthApps.some((a) => a.provider === "google");
  const hasMicrosoft = oauthApps.some((a) => a.provider === "microsoft");

  return (
    <div className="max-w-xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Custom OAuth Apps</h2>
        <p className="mt-1 text-sm text-muted">
          Use your own OAuth app credentials to connect Google or Microsoft services.{" "}
          <a href="/docs/connections/custom-oauth-apps" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-800">
            Learn more
          </a>
        </p>
      </div>

      {/* Callback URL */}
      {callbackUrl && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
          <p className="text-xs font-medium text-blue-800">
            Callback URL (add this to your OAuth app&apos;s redirect URIs):
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto text-xs font-mono text-blue-900">
              {callbackUrl}
            </code>
            <button
              onClick={handleCopyCallback}
              className="rounded border border-blue-300 bg-white px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
            >
              {copiedCallback ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* Google OAuth App */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <h3 className="text-base font-semibold text-foreground">Google OAuth App</h3>
            <HelpTooltip docsPath="/connections/google">
              How to create a Google Cloud OAuth app and configure credentials for Gmail, Calendar, Drive, Docs, and Sheets.
            </HelpTooltip>
          </div>
          {!showGoogleForm && !hasGoogle && (
            <button
              onClick={() => {
                setGoogleClientId("");
                setGoogleClientSecret("");
                setGoogleLabel("");
                setGoogleMessage(null);
                setShowGoogleForm(true);
              }}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Add
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          Gmail, Google Calendar, Drive, Sheets, and Docs.
        </p>

        {/* Existing Google app */}
        {oauthApps.filter((a) => a.provider === "google").map((app) => (
          <div key={app.id} className="mt-3 flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <span className="text-sm font-medium text-foreground">{app.label}</span>
              <div className="mt-0.5 text-xs text-muted">
                Client ID: {app.clientId.slice(0, 24)}...
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleEditGoogleApp(app)}
                className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-gray-50"
              >
                Update
              </button>
              <button
                onClick={() => handleDeleteOauthApp(app.id)}
                className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          </div>
        ))}

        {/* Google form */}
        {showGoogleForm && (
          <form onSubmit={handleSaveGoogleApp} className="mt-4 space-y-3">
            <div>
              <label htmlFor="google-client-id" className="block text-sm font-medium text-foreground">
                Client ID <span className="text-red-500">*</span>
              </label>
              <input
                id="google-client-id"
                type="text"
                value={googleClientId}
                onChange={(e) => setGoogleClientId(e.target.value)}
                placeholder="123456789.apps.googleusercontent.com"
                required
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="google-client-secret" className="block text-sm font-medium text-foreground">
                Client Secret <span className="text-red-500">*</span>
              </label>
              <input
                id="google-client-secret"
                type="password"
                value={googleClientSecret}
                onChange={(e) => setGoogleClientSecret(e.target.value)}
                placeholder="Enter client secret"
                required
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="google-label" className="block text-sm font-medium text-foreground">
                Label
              </label>
              <input
                id="google-label"
                type="text"
                value={googleLabel}
                onChange={(e) => setGoogleLabel(e.target.value)}
                placeholder="My Google App"
                maxLength={100}
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {googleMessage && (
              <p className={`text-sm ${googleMessage.includes("saved") ? "text-green-600" : "text-red-600"}`}>
                {googleMessage}
              </p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={savingGoogle || !googleClientId.trim() || !googleClientSecret.trim()}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingGoogle ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                onClick={() => { setShowGoogleForm(false); setGoogleMessage(null); }}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {!hasGoogle && !showGoogleForm && (
          <p className="mt-3 text-sm text-muted">No Google OAuth app configured.</p>
        )}
      </div>

      {/* Microsoft OAuth App */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <h3 className="text-base font-semibold text-foreground">Microsoft OAuth App</h3>
            <HelpTooltip docsPath="/connections/microsoft">
              How to register a Microsoft Entra ID app and configure credentials for Outlook, Calendar, Contacts, OneDrive, and Teams.
            </HelpTooltip>
          </div>
          {!showMicrosoftForm && !hasMicrosoft && (
            <button
              onClick={() => {
                setMicrosoftClientId("");
                setMicrosoftClientSecret("");
                setMicrosoftTenantId("");
                setMicrosoftLabel("");
                setMicrosoftMessage(null);
                setShowMicrosoftForm(true);
              }}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Add
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          Outlook Mail, Calendar, Contacts, OneDrive, and Teams.
        </p>

        {/* Existing Microsoft app */}
        {oauthApps.filter((a) => a.provider === "microsoft").map((app) => (
          <div key={app.id} className="mt-3 flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <span className="text-sm font-medium text-foreground">{app.label}</span>
              <div className="mt-0.5 text-xs text-muted">
                <span>Client ID: {app.clientId.slice(0, 12)}...</span>
                {app.tenantId && <span className="ml-3">Tenant: {app.tenantId.slice(0, 12)}...</span>}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleEditMicrosoftApp(app)}
                className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-gray-50"
              >
                Update
              </button>
              <button
                onClick={() => handleDeleteOauthApp(app.id)}
                className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          </div>
        ))}

        {/* Microsoft form */}
        {showMicrosoftForm && (
          <form onSubmit={handleSaveMicrosoftApp} className="mt-4 space-y-3">
            <div>
              <label htmlFor="ms-client-id" className="block text-sm font-medium text-foreground">
                Client ID <span className="text-red-500">*</span>
              </label>
              <input
                id="ms-client-id"
                type="text"
                value={microsoftClientId}
                onChange={(e) => setMicrosoftClientId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                required
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="ms-client-secret" className="block text-sm font-medium text-foreground">
                Client Secret <span className="text-red-500">*</span>
              </label>
              <input
                id="ms-client-secret"
                type="password"
                value={microsoftClientSecret}
                onChange={(e) => setMicrosoftClientSecret(e.target.value)}
                placeholder="Enter client secret"
                required
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="ms-tenant-id" className="block text-sm font-medium text-foreground">
                Tenant ID <span className="text-xs text-muted">(optional, defaults to &ldquo;common&rdquo;)</span>
              </label>
              <input
                id="ms-tenant-id"
                type="text"
                value={microsoftTenantId}
                onChange={(e) => setMicrosoftTenantId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="ms-label" className="block text-sm font-medium text-foreground">
                Label
              </label>
              <input
                id="ms-label"
                type="text"
                value={microsoftLabel}
                onChange={(e) => setMicrosoftLabel(e.target.value)}
                placeholder="My Microsoft App"
                maxLength={100}
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {microsoftMessage && (
              <p className={`text-sm ${microsoftMessage.includes("saved") ? "text-green-600" : "text-red-600"}`}>
                {microsoftMessage}
              </p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={savingMicrosoft || !microsoftClientId.trim() || !microsoftClientSecret.trim()}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingMicrosoft ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                onClick={() => { setShowMicrosoftForm(false); setMicrosoftMessage(null); }}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {!hasMicrosoft && !showMicrosoftForm && (
          <p className="mt-3 text-sm text-muted">No Microsoft OAuth app configured.</p>
        )}
      </div>
    </div>
  );
}
