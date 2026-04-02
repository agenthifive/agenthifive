"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  SERVICE_CATALOG,
  ACTION_TEMPLATES,
  type ServiceId,
  type ServiceCategory,
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_LABELS,
  getServicesByCategory,
} from "@agenthifive/contracts";
import { toast } from "sonner";
import type { RawApiConnection } from "./types";
import PolicyWizard from "./policy-wizard";
import { HelpTooltip } from "@/components/help-tooltip";

// ── Types ──────────────────────────────────────────────────────────

interface CreateConnectionModalProps {
  agentId: string;
  agentName: string;
  /** Existing connections (for singleton checks) */
  existingConnections: RawApiConnection[];
  onClose: () => void;
  onRefresh: () => void;
}

interface ServiceMetadata {
  id: string;
  name: string;
  provider: string;
  icon: string;
  singleton: boolean;
  actions: Array<{
    id: string;
    label: string;
    description: string;
    requiresApproval: boolean;
  }>;
}

type Step = "select" | "flow" | "success";

interface BotTokenResult {
  botInfo: Record<string, unknown>;
  label: string;
  message: string;
  connection: { id: string };
}

const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;

function openCenteredPopup(url: string, name: string): Window | null {
  const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
  return window.open(
    url,
    name,
    `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},popup=yes`,
  );
}

// ── Component ──────────────────────────────────────────────────────

export default function CreateConnectionModal({
  agentId,
  agentName,
  existingConnections,
  onClose,
  onRefresh,
}: CreateConnectionModalProps) {
  const [step, setStep] = useState<Step>("select");
  const [activeCategory, setActiveCategory] = useState<ServiceCategory>("llm");

  // Loading + error
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Service metadata from /capabilities/services (for singleton info)
  const [servicesMetadata, setServicesMetadata] = useState<ServiceMetadata[]>([]);

  // OAuth credential availability per provider (google, microsoft)
  const [oauthStatus, setOauthStatus] = useState<Record<string, { available: boolean; source: string | null }>>({});

  // Bot token flow (Telegram, Slack, etc.)
  const [botToken, setBotToken] = useState("");
  const [botTokenLabel, setBotTokenLabel] = useState("");

  // API key flow (Anthropic, OpenAI, Gemini, Trello, etc.)
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [apiKeyLabel, setApiKeyLabel] = useState("");
  const [appKeyValue, setAppKeyValue] = useState("");
  const [emailValue, setEmailValue] = useState("");


  // Active flow service
  const [flowService, setFlowService] = useState<ServiceId | null>(null);
  // Selected action template ID (e.g., "trello-read" vs "trello-manage")
  const [selectedActionTemplateId, setSelectedActionTemplateId] = useState<string | null>(null);

  // Success state
  const [createdConnectionId, setCreatedConnectionId] = useState<string | null>(null);
  const [createdServiceId, setCreatedServiceId] = useState<ServiceId | null>(null);

  // Success step: show full policy wizard or skip
  const [showPolicyWizard, setShowPolicyWizard] = useState(true);

  // Track whether a policy was created (to distinguish cancel vs done)
  const [policyCreated, setPolicyCreated] = useState(false);

  // Fetch service metadata for singleton checks and OAuth status
  useEffect(() => {
    apiFetch("/capabilities/services")
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as {
            services: ServiceMetadata[];
            oauthStatus?: Record<string, { available: boolean; source: string | null }>;
          };
          setServicesMetadata(data.services);
          if (data.oauthStatus) setOauthStatus(data.oauthStatus);
        }
      })
      .catch(() => {
        toast.error("Failed to load service capabilities");
      });
  }, []);

  // Listen for OAuth popup completion
  const handlePopupMessage = useCallback(
    (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;

      if (event.data?.type === "connection-oauth-complete") {
        const connectionId = event.data.connectionId as string;
        setCreatedConnectionId(connectionId);
        setStep("success");
        onRefresh();
      } else if (event.data?.type === "connection-oauth-error") {
        const msg = event.data.error ?? "OAuth connection failed";
        setError(msg);
        toast.error("Connection failed", { description: msg, duration: 8000 });
        setStep("select");
      }
    },
    [onRefresh],
  );

  useEffect(() => {
    window.addEventListener("message", handlePopupMessage);
    return () => window.removeEventListener("message", handlePopupMessage);
  }, [handlePopupMessage]);

  // ── Helpers ─────────────────────────────────────────────────────

  const isSingleton = (serviceId: string): boolean => {
    const meta = servicesMetadata.find((s) => s.id === serviceId);
    return meta?.singleton ?? SERVICE_CATALOG[serviceId as ServiceId]?.singleton ?? false;
  };

  const hasSingletonConnection = (serviceId: string): boolean => {
    return isSingleton(serviceId) && existingConnections.some((c) => c.service === serviceId);
  };

  /** Check if OAuth credentials are available for an OAuth service's provider */
  const isOauthAvailable = (serviceId: string): boolean => {
    const entry = SERVICE_CATALOG[serviceId as ServiceId];
    if (!entry || entry.credentialType !== "oauth") return true; // non-OAuth always available
    const status = oauthStatus[entry.provider];
    return status?.available ?? false;
  };

  const getOauthSource = (serviceId: string): string | null => {
    const entry = SERVICE_CATALOG[serviceId as ServiceId];
    if (!entry) return null;
    return oauthStatus[entry.provider]?.source ?? null;
  };

  // Connection info for success step
  const createdServiceConfig = createdServiceId ? SERVICE_CATALOG[createdServiceId] : null;

  // ── Service Selection Handlers ──────────────────────────────────

  function handleSelectAction(serviceId: ServiceId, scopes: string[], label: string, actionTemplateId?: string) {
    if (hasSingletonConnection(serviceId)) {
      setError(`Only one ${SERVICE_CATALOG[serviceId].displayName} connection is allowed per workspace.`);
      return;
    }

    setSelectedActionTemplateId(actionTemplateId ?? null);
    const credType = SERVICE_CATALOG[serviceId].credentialType;

    if (credType === "bot_token") {
      // Telegram
      setFlowService(serviceId);
      setStep("flow");
      setError(null);
      return;
    }

    if (credType === "api_key") {
      setFlowService(serviceId);
      // Pre-fill label with action type (e.g., "Jira Cloud - Manage Jira issues")
      if (actionTemplateId) {
        const action = ACTION_TEMPLATES.find((a) => a.id === actionTemplateId);
        if (action) {
          setApiKeyLabel(`${SERVICE_CATALOG[serviceId].displayName} - ${action.label}`);
        }
      }
      setStep("flow");
      setError(null);
      return;
    }

    // OAuth flow
    startOAuthConnection(serviceId, scopes, label);
  }

  async function startOAuthConnection(serviceId: ServiceId, scopes: string[], label: string) {
    setLoading(true);
    setError(null);
    setCreatedServiceId(serviceId);

    try {
      const res = await apiFetch("/connections/start", {
        method: "POST",
        body: JSON.stringify({ service: serviceId, scopes, label }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as {
        pendingConnectionId: string;
        authorizationUrl: string;
      };
      const popup = openCenteredPopup(data.authorizationUrl, "oauth-connection");
      if (!popup) {
        // Fallback: redirect in current window
        window.location.href = data.authorizationUrl;
      }
      // Stay on select step — popup completion will advance to success
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start connection");
      setCreatedServiceId(null);
    } finally {
      setLoading(false);
    }
  }

  // ── Telegram Flow ───────────────────────────────────────────────

  async function handleBotTokenValidate() {
    if (!botToken.trim() || !flowService) return;

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch("/connections/bot-token", {
        method: "POST",
        body: JSON.stringify({
          service: flowService,
          botToken: botToken.trim(),
          label: botTokenLabel || undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as BotTokenResult;
      setCreatedConnectionId(data.connection.id);
      setCreatedServiceId(flowService);
      setStep("success");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to validate bot token");
    } finally {
      setLoading(false);
    }
  }

  // ── API Key Flow (Anthropic, OpenAI, Gemini) ───────────────────

  async function handleApiKeySubmit() {
    if (!apiKeyValue.trim() || !flowService) return;

    const entry = SERVICE_CATALOG[flowService];
    setLoading(true);
    setError(null);

    try {
      const payload: Record<string, string> = {
        provider: entry.provider,
        service: flowService,
        apiKey: apiKeyValue.trim(),
        label: apiKeyLabel.trim() || entry.displayName,
      };
      if (entry.provider === "jira") {
        payload.siteUrl = appKeyValue.trim();
        payload.email = emailValue.trim();
      } else if (appKeyValue.trim()) {
        payload.appKey = appKeyValue.trim();
      }

      const res = await apiFetch("/connections/api-key", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { connection: { id: string; label: string } };
      setCreatedConnectionId(data.connection.id);
      setCreatedServiceId(flowService);
      setStep("success");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to create ${entry.displayName} connection`);
    } finally {
      setLoading(false);
    }
  }

  // ── Add Policy (success step) ──────────────────────────────────

  function handlePolicyCreated() {
    setPolicyCreated(true);
    onRefresh();
    onClose();
  }

  /** Delete connection and close */
  async function handleDeleteConnection() {
    if (createdConnectionId) {
      try {
        await apiFetch(`/connections/${createdConnectionId}/revoke`, { method: "POST" });
      } catch {
        toast.error("Failed to revoke connection", { description: "You may need to revoke it manually from the connections page." });
      }
      onRefresh();
    }
    onClose();
  }

  /** Smart close: delete orphaned connection if user cancels before adding a policy */
  async function handleClose() {
    if (step === "success" && createdConnectionId && !policyCreated) {
      try {
        await apiFetch(`/connections/${createdConnectionId}/revoke`, { method: "POST" });
      } catch {
        toast.error("Failed to clean up connection", { description: "An unused connection may remain. You can revoke it from the connections page." });
      }
      onRefresh();
    }
    onClose();
  }

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={handleClose}
    >
      <div
        className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto bg-white rounded-lg shadow-xl m-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-foreground">
              {step === "success"
                ? `${createdServiceConfig?.displayName ?? "Service"} Connected`
                : step === "flow"
                  ? `Connect ${flowService ? SERVICE_CATALOG[flowService].displayName : ""}`
                  : "Add Connection"}
            </h2>
            <p className="text-xs text-muted">
              {step === "success"
                ? `${agentName} → ${createdServiceConfig?.displayName ?? "Service"}`
                : `Agent: ${agentName}`}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          {error && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-600">{error}</p>
              <button onClick={() => setError(null)} className="mt-1 text-xs text-red-500 underline">
                Dismiss
              </button>
            </div>
          )}

          {/* ─── Step: Service Selection ─────────────────── */}
          {step === "select" && (
            <div>
              <p className="mb-6 text-sm text-muted">
                Select a service to connect. Each service shows the specific capabilities provided by the connector.
              </p>

              {/* Category tabs */}
              <div className="border-b border-border mb-6">
                <nav className="flex gap-6" aria-label="Service categories">
                  {SERVICE_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setActiveCategory(cat)}
                      className={`pb-3 text-sm font-medium transition-colors border-b-2 ${
                        activeCategory === cat
                          ? "border-blue-600 text-blue-600"
                          : "border-transparent text-muted hover:text-foreground hover:border-gray-300"
                      }`}
                    >
                      {SERVICE_CATEGORY_LABELS[cat]}
                    </button>
                  ))}
                </nav>
              </div>

              {/* Services for active category */}
              <div className="space-y-6">
                {getServicesByCategory(activeCategory).map(([serviceId, entry]) => {
                  const actions = ACTION_TEMPLATES.filter((a) => a.serviceId === serviceId);
                  const hasConn = hasSingletonConnection(serviceId);

                  // Services with no action templates (direct connect)
                  if (actions.length === 0) {
                    const oauthOk = isOauthAvailable(serviceId);
                    const oauthSrc = getOauthSource(serviceId);
                    const isDisabled = loading || hasConn || !oauthOk;
                    return (
                      <div key={serviceId}>
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-lg">{entry.icon}</span>
                          <h3 className="text-base font-semibold text-foreground">
                            {entry.displayName}
                          </h3>
                          {oauthSrc === "bya" && (
                            <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600 border border-blue-200">
                              using your app
                            </span>
                          )}
                        </div>
                        {!oauthOk && entry.credentialType === "oauth" && (
                          <div className="mb-3 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                            OAuth app not configured for {entry.provider}.{" "}
                            <a href="/dashboard/settings/apps" className="font-medium underline hover:text-yellow-900">
                              Set up in Settings → Apps
                            </a>
                          </div>
                        )}
                        <button
                          onClick={() => handleSelectAction(serviceId, [], entry.displayName)}
                          disabled={isDisabled}
                          className={`w-full rounded-lg border-2 p-3 text-left transition-all ${
                            hasConn || !oauthOk
                              ? "border-gray-300 bg-gray-50 cursor-not-allowed opacity-60"
                              : "border-border bg-card hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <div className="font-medium text-sm text-foreground">
                              Connect {entry.displayName}
                            </div>
                            {entry.singleton && (
                              <span className="inline-flex items-center rounded-full bg-purple-100 px-1.5 py-0.5 text-xs font-medium text-purple-700 border border-purple-300">
                                One per workspace
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted">{entry.description}</div>
                          {hasConn && (
                            <div className="mt-1 text-xs text-orange-600 font-medium">
                              Already connected — only one allowed per workspace
                            </div>
                          )}
                        </button>
                      </div>
                    );
                  }

                  // Services with action templates
                  const svcOauthOk = isOauthAvailable(serviceId);
                  const svcOauthSrc = getOauthSource(serviceId);
                  return (
                    <div key={serviceId}>
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-lg">{entry.icon}</span>
                        <h3 className="text-base font-semibold text-foreground">
                          {entry.displayName}
                        </h3>
                        {svcOauthSrc === "bya" && (
                          <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600 border border-blue-200">
                            using your app
                          </span>
                        )}
                      </div>
                      {!svcOauthOk && entry.credentialType === "oauth" && (
                        <div className="mb-3 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                          OAuth app not configured for {entry.provider}.{" "}
                          <a href="/dashboard/settings/apps" className="font-medium underline hover:text-yellow-900">
                            Set up in Settings → Apps
                          </a>
                        </div>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        {actions.map((action) => {
                          const serviceConfig = SERVICE_CATALOG[action.serviceId];
                          const scopeLabels = action.scopes
                            .map((scopeValue) => {
                              const scopeDef = serviceConfig.scopes.find((s) => s.value === scopeValue);
                              return scopeDef?.label || scopeValue;
                            })
                            .filter(Boolean);
                          const actionHasConn = hasSingletonConnection(action.serviceId);
                          const isDisabled = loading || actionHasConn || !svcOauthOk;

                          return (
                            <button
                              key={action.id}
                              onClick={() =>
                                handleSelectAction(
                                  action.serviceId,
                                  action.scopes,
                                  `${serviceConfig.displayName} - ${action.label}`,
                                  action.id,
                                )
                              }
                              disabled={isDisabled}
                              className={`rounded-lg border-2 p-3 text-left transition-all ${
                                actionHasConn
                                  ? "border-gray-300 bg-gray-50 cursor-not-allowed opacity-60"
                                  : "border-border bg-card hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <div className="font-medium text-sm text-foreground">{action.label}</div>
                                {isSingleton(action.serviceId) && (
                                  <span className="inline-flex items-center rounded-full bg-purple-100 px-1.5 py-0.5 text-xs font-medium text-purple-700 border border-purple-300">
                                    One per workspace
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-muted">{action.description}</div>
                              {actionHasConn && (
                                <div className="mt-1 text-xs text-orange-600 font-medium">
                                  Already connected — only one allowed per workspace
                                </div>
                              )}
                              {!actionHasConn && scopeLabels.length > 0 && (
                                <div className="mt-2 pt-2 border-t border-border">
                                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                                    {scopeLabels.map((scopeLabel, idx) => (
                                      <div key={idx} className="flex items-center gap-1 text-xs text-muted">
                                        <span className="text-green-600">&#10003;</span>
                                        <span>{scopeLabel}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─── Step: Bot Token Flow (Telegram, Slack, etc.) ─── */}
          {step === "flow" && flowService && SERVICE_CATALOG[flowService].credentialType === "bot_token" && (() => {
            const flowEntry = SERVICE_CATALOG[flowService];
            const hints: Record<string, { description: string; placeholder: string; helpText?: string; docsPath?: string | undefined }> = {
              telegram: { description: "Enter the bot token from @BotFather to connect your Telegram bot.", placeholder: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ", helpText: "Create a bot with @BotFather on Telegram, then copy the token it gives you.", docsPath: "/connections/telegram" },
              slack: { description: "Enter the Bot User OAuth Token from your Slack App settings.", placeholder: "xoxb-...", helpText: "Go to api.slack.com/apps, select your app, then find the Bot User OAuth Token under OAuth & Permissions.", docsPath: "/connections/slack" },
            };
            const hint = hints[flowEntry.provider] ?? { description: `Enter the bot token for ${flowEntry.displayName}.`, placeholder: "bot-token-here" };
            return (
            <div className="max-w-xl mx-auto">
              <div className="rounded-lg border border-border bg-card p-6">
                <div className="flex items-start justify-between mb-4">
                  <p className="text-sm text-muted">
                    {hint.description}
                  </p>
                  {(hint.helpText || hint.docsPath) && (
                    <HelpTooltip docsPath={hint.docsPath}>{hint.helpText ?? hint.description}</HelpTooltip>
                  )}
                </div>
                <div className="mb-4">
                  <label htmlFor="create-bot-label" className="block text-sm font-medium text-foreground">
                    Connection Label
                  </label>
                  <input
                    id="create-bot-label"
                    type="text"
                    value={botTokenLabel || flowEntry.displayName}
                    onChange={(e) => setBotTokenLabel(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={`e.g., My ${flowEntry.displayName}`}
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="create-bot-token" className="block text-sm font-medium text-foreground">
                    Bot Token
                  </label>
                  <input
                    id="create-bot-token"
                    type="text"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={hint.placeholder}
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setStep("select"); setFlowService(null); setBotToken(""); setError(null); }}
                    className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleBotTokenValidate}
                    disabled={loading || !botToken.trim()}
                    className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? "Validating..." : "Validate & Connect"}
                  </button>
                </div>
              </div>
            </div>
            );
          })()}

          {/* ─── Step: API Key Flow (Anthropic, OpenAI, Gemini) ─── */}
          {step === "flow" && flowService && SERVICE_CATALOG[flowService].credentialType === "api_key" && (() => {
            const flowEntry = SERVICE_CATALOG[flowService];
            const hints: Record<string, { description: string; placeholder: string; keyLabel: string; helpText?: string; docsPath?: string; appKeyLabel?: string; appKeyPlaceholder?: string }> = {
              anthropic: {
                description: "Enter your Anthropic API key or Claude Code setup token to allow agents to use Claude models through AgentHiFive.",
                placeholder: "sk-ant-api... or sk-ant-oat01-...",
                keyLabel: "API Key or Setup Token",
                helpText: "Get an API key from console.anthropic.com, or run `claude setup-token` in Claude Code to use your Pro/Max subscription.",
                docsPath: "/connections/anthropic",
              },
              openai: {
                description: "Enter your OpenAI API key to allow agents to use GPT models and embeddings.",
                placeholder: "sk-...",
                keyLabel: "API Key",
                helpText: "Get an API key from platform.openai.com under API Keys.",
                docsPath: "/connections/openai",
              },
              gemini: {
                description: "Enter your Google AI API key to allow agents to use Gemini models and embeddings.",
                placeholder: "AIza...",
                keyLabel: "API Key",
                helpText: "Get an API key from aistudio.google.com/apikey.",
                docsPath: "/connections/gemini",
              },
              openrouter: {
                description: "Enter your OpenRouter API key to allow agents to use models from multiple providers.",
                placeholder: "sk-or-v1-...",
                keyLabel: "API Key",
                helpText: "Get an API key from openrouter.ai/settings/keys.",
                docsPath: "/connections/openrouter",
              },
              notion: {
                description: "Enter your Notion internal integration token to allow agents to read and write Notion pages.",
                placeholder: "ntn_...",
                keyLabel: "Integration Token",
                helpText: "Create an integration at notion.so/profile/integrations, then share pages with it.",
                docsPath: "/connections/notion",
              },
              trello: {
                description: "Enter your Trello Power-Up API key and user token to allow agents to manage boards and cards.",
                placeholder: "ATTA...",
                keyLabel: "User Token",
                helpText: "Create a Power-Up at trello.com/power-ups/admin to get the API key, then generate a user token via the authorize URL.",
                docsPath: "/connections/trello",
                appKeyLabel: "Power-Up API Key",
                appKeyPlaceholder: "32-character API key from Power-Up settings",
              },
              jira: {
                description: "Enter your Jira Cloud credentials to connect your project.",
                placeholder: "ATATT3xFfGF0...",
                keyLabel: "API Token",
                helpText: "Create an API token at id.atlassian.com/manage/api-tokens.",
                docsPath: "/connections/jira",
                appKeyLabel: "Jira Site URL",
                appKeyPlaceholder: "mycompany.atlassian.net",
              },
            };
            const hint = hints[flowEntry.provider] ?? { description: `Enter your ${flowEntry.displayName} API key.`, placeholder: "api-key-here", keyLabel: "API Key" };
            return (
            <div className="max-w-xl mx-auto">
              <div className="rounded-lg border border-border bg-card p-6">
                <div className="flex items-start justify-between mb-4">
                  <p className="text-sm text-muted">
                    {hint.description}
                  </p>
                  {(hint.helpText || hint.docsPath) && (
                    <HelpTooltip docsPath={hint.docsPath}>{hint.helpText ?? hint.description}</HelpTooltip>
                  )}
                </div>
                <div className="mb-4">
                  <label htmlFor="create-apikey-label" className="block text-sm font-medium text-foreground">
                    Connection Label
                  </label>
                  <input
                    id="create-apikey-label"
                    type="text"
                    value={apiKeyLabel || flowEntry.displayName}
                    onChange={(e) => setApiKeyLabel(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={`e.g., ${flowEntry.displayName}`}
                  />
                </div>
                {hint.appKeyLabel && (
                  <div className="mb-4">
                    <label htmlFor="create-apikey-appkey" className="block text-sm font-medium text-foreground">
                      {hint.appKeyLabel}
                    </label>
                    <input
                      id="create-apikey-appkey"
                      type="text"
                      value={appKeyValue}
                      onChange={(e) => setAppKeyValue(e.target.value)}
                      className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder={hint.appKeyPlaceholder ?? ""}
                    />
                  </div>
                )}
                {flowEntry.provider === "jira" && (
                  <div className="mb-4">
                    <label htmlFor="create-apikey-email" className="block text-sm font-medium text-foreground">
                      Email Address <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="create-apikey-email"
                      type="email"
                      value={emailValue}
                      onChange={(e) => setEmailValue(e.target.value)}
                      placeholder="you@company.com"
                      className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                )}
                <div className="mb-4">
                  <label htmlFor="create-apikey-key" className="block text-sm font-medium text-foreground">
                    {hint.keyLabel}
                  </label>
                  <input
                    id="create-apikey-key"
                    type="text"
                    value={apiKeyValue}
                    onChange={(e) => setApiKeyValue(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={hint.placeholder}
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setStep("select"); setFlowService(null); setApiKeyValue(""); setAppKeyValue(""); setEmailValue(""); setError(null); }}
                    className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleApiKeySubmit}
                    disabled={loading || !apiKeyValue.trim() || (!!hint.appKeyLabel && !appKeyValue.trim()) || (flowEntry.provider === "jira" && !emailValue.trim())}
                    className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? "Connecting..." : "Connect"}
                  </button>
                </div>
              </div>
            </div>
            );
          })()}

          {/* ─── Step: Success + Add Policy ──────────────── */}
          {step === "success" && (
            <div>
              {/* Full policy wizard or skip */}
              {showPolicyWizard && createdConnectionId && createdServiceId ? (
                <PolicyWizard
                  agentId={agentId}
                  agentName={agentName}
                  connectionId={createdConnectionId}
                  connectionLabel={createdServiceConfig?.displayName ?? "Connection"}
                  connectionProvider={createdServiceConfig?.provider ?? "unknown"}
                  connectionService={createdServiceId}
                  {...(selectedActionTemplateId ? { actionTemplateId: selectedActionTemplateId } : {})}
                  onCreated={handlePolicyCreated}
                  onCancel={handleClose}
                  onDelete={handleDeleteConnection}
                />
              ) : (
                <div className="text-center">
                  <button
                    onClick={() => setShowPolicyWizard(true)}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    Add Policy
                  </button>
                  <button
                    onClick={() => { onRefresh(); onClose(); }}
                    className="ml-3 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50"
                  >
                    Skip
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sticky Footer */}
        {!(step === "success" && showPolicyWizard) && (
          <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-3 flex justify-end">
            <button
              onClick={handleClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-foreground hover:bg-white transition-colors"
            >
              {step === "success" && !policyCreated
                ? "Cancel — remove connection"
                : step === "success"
                  ? "Done"
                  : "Cancel"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
