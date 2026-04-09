"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";
import {
  SERVICE_CATALOG,
  type ServiceId,
  type ServiceCategory,
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_LABELS,
  getServicesByCategory,
  isRevocationInstant,
} from "@agenthifive/contracts";
import {
  ACTION_TEMPLATES,
  type ActionTemplate,
} from "@/lib/mock-data";
import { toast } from "sonner";
import { HelpTooltip } from "@/components/help-tooltip";

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

type ConnectionStatus = "healthy" | "needs_reauth" | "revoked";

const STATUS_CONFIG: Record<
  ConnectionStatus,
  { label: string; color: string; bg: string }
> = {
  healthy: { label: "Healthy", color: "text-green-700", bg: "bg-green-100" },
  needs_reauth: {
    label: "Needs Reconnect",
    color: "text-yellow-700",
    bg: "bg-yellow-100",
  },
  revoked: { label: "Revoked", color: "text-red-700", bg: "bg-red-100" },
};

interface TelegramMetadata {
  botId?: number;
  botUsername?: string;
  botFirstName?: string;
}

interface MicrosoftMetadata {
  email?: string;
  displayName?: string;
  tenantId?: string;
}

interface ConnectionPolicy {
  id: string;
  agentId: string;
  agentName: string;
  defaultMode: "read_only" | "read_write" | "custom";
  stepUpApproval: "always" | "risk_based" | "never";
  allowedModels: string[];
  securityPreset?: string | null;
}

interface Connection {
  id: string;
  provider: string;
  service: string;
  label: string;
  status: ConnectionStatus;
  grantedScopes: string[];
  metadata?: TelegramMetadata | MicrosoftMetadata | null;
  createdAt: string;
  updatedAt?: string;
  credentialPreview?: {
    primaryLabel: string;
    primaryMasked: string;
    secondaryLabel?: string;
    secondaryMasked?: string;
    tertiaryLabel?: string;
    tertiaryValue?: string;
  } | null;
  policies: ConnectionPolicy[];
}

interface AuthCodeResult {
  pendingConnectionId: string;
  authorizationUrl: string;
}

interface BotTokenResult {
  botInfo: Record<string, unknown>;
  label: string;
  message: string;
  connection: { id: string };
}

/** Resolve a scope string to its human-readable label */
function formatScope(scope: string): string {
  for (const serviceId of Object.keys(SERVICE_CATALOG)) {
    const found = SERVICE_CATALOG[serviceId as ServiceId].scopes.find((s) => s.value === scope);
    if (found) return found.label;
  }
  return scope;
}

/** Derive a protection status headline + subtitle from connection policies */
function getConnectionProtectionStatus(conn: Connection) {
  const hasPolicy = conn.policies.length > 0;
  if (!hasPolicy) {
    return { headline: "⚠️ No rules set", subtitle: "No security policy configured" };
  }

  const primary = conn.policies[0]!;
  const preset = primary.securityPreset;

  // Use securityPreset when available (rules-based policies set stepUpApproval to "never")
  if (preset === "strict") {
    return { headline: "🔒 Strict Protection", subtitle: "Maximum oversight · Sensitive actions blocked or require approval" };
  }
  if (preset === "standard") {
    return { headline: "🛡️ Balanced Protection", subtitle: "Reads allowed · Writes and sensitive actions need approval" };
  }
  if (preset === "minimal") {
    return { headline: "⚠️ Minimal Protection", subtitle: "Full access · No approval required" };
  }

  // Fallback for policies without securityPreset (legacy or custom)
  const hasApproval = primary.stepUpApproval === "always" || primary.stepUpApproval === "risk_based";
  const isReadOnly = primary.defaultMode === "read_only";

  let headline: string;
  if (isReadOnly && hasApproval) headline = "🔒 Strict Protection";
  else if (hasApproval) headline = "🛡️ Balanced Protection";
  else if (isReadOnly) headline = "🛡️ Read-Only";
  else headline = "⚠️ Minimal Protection";

  const parts: string[] = [];
  if (isReadOnly) parts.push("Read-only access");
  else parts.push("Read/write access");
  if (primary.stepUpApproval === "always") parts.push("All writes need approval");
  else if (primary.stepUpApproval === "risk_based") parts.push("Risky writes need approval");
  else parts.push("No approval required");

  return { headline, subtitle: parts.join(" · ") };
}

export default function ConnectionsPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const [step, setStep] = useState<"list" | "select" | "flow">("list");
  const [selectedAction, setSelectedAction] = useState<ActionTemplate | null>(null);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botToken, setBotToken] = useState("");
  const [botTokenResult, setBotTokenResult] = useState<BotTokenResult | null>(null);

  // Category tabs
  const [activeCategory, setActiveCategory] = useState<ServiceCategory>("llm");

  // Tracks which service's custom flow is active (telegram, anthropic-messages)
  const [flowService, setFlowService] = useState<ServiceId | null>(null);

  // API key flow (Anthropic, OpenAI, Gemini, Trello)
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [apiKeyLabel, setApiKeyLabel] = useState("");

  const [apiKeyResult, setApiKeyResult] = useState<{ label: string } | null>(null);
  // Trello requires a second credential (Power-Up API key)
  const [appKeyValue, setAppKeyValue] = useState("");
  // Jira requires an email address in addition to siteUrl (appKey) and API token
  const [emailValue, setEmailValue] = useState("");

  // Email (IMAP/SMTP) flow
  const [emailAddress, setEmailAddress] = useState("");
  const [emailDisplayName, setEmailDisplayName] = useState("");
  const [emailImapHost, setEmailImapHost] = useState("");
  const [emailImapPort, setEmailImapPort] = useState(993);
  const [emailImapTls, setEmailImapTls] = useState(true);
  const [emailSmtpHost, setEmailSmtpHost] = useState("");
  const [emailSmtpPort, setEmailSmtpPort] = useState(587);
  const [emailSmtpStarttls, setEmailSmtpStarttls] = useState(true);
  const [emailUsername, setEmailUsername] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailLabel, setEmailLabel] = useState("");
  const [emailResult, setEmailResult] = useState<{ label: string } | null>(null);


  // Connections list state
  const [connectionsList, setConnectionsList] = useState<Connection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [filterService, setFilterService] = useState<string>("all");
  const [revokeTarget, setRevokeTarget] = useState<Connection | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [reauthTarget, setReauthTarget] = useState<Connection | null>(null);
  const [reauthLoading, setReauthLoading] = useState(false);
  const [reauthCredential, setReauthCredential] = useState("");

  const [reauthAppKey, setReauthAppKey] = useState("");
  const [reauthEmail, setReauthEmail] = useState("");


  // Test connection state
  const [testingConnectionId, setTestingConnectionId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail?: string; error?: string; hint?: string } | null>(null);

  // Permission request approval flow metadata (passed via URL params from approvals page)
  const [approvalMeta, setApprovalMeta] = useState<{
    agentId: string;
    actionTemplateId: string;
    policyTier: string;
    permissionRequestId: string;
    allowedModels: string;
  } | null>(null);

  // Service metadata (including singleton info)
  const [servicesMetadata, setServicesMetadata] = useState<ServiceMetadata[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);

  // OAuth credential availability per provider (google, microsoft)
  const [oauthStatus, setOauthStatus] = useState<Record<string, { available: boolean; source: string | null }>>({});

  // Tracks the action template through the connection creation flow
  const [pendingAction, setPendingAction] = useState<ActionTemplate | null>(null);

  // Post-creation assignment dialog
  const [assignConnection, setAssignConnection] = useState<{
    connectionId: string;
    actionTemplateId: string;
    serviceId: string;
  } | null>(null);
  const [assignAgents, setAssignAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [assignAgentId, setAssignAgentId] = useState("");
  const [assignPolicyTier, setAssignPolicyTier] = useState<"standard" | "strict" | "minimal">("standard");
  const [assignLoading, setAssignLoading] = useState(false);

  const fetchConnections = useCallback(async (retry = true) => {
    try {
      const res = await apiFetch("/connections");
      if (res.ok) {
        const data = (await res.json()) as { connections: Connection[] };
        setConnectionsList(data.connections);
        setConnectionsLoading(false);
        return;
      }
      if (retry) {
        setTimeout(() => fetchConnections(false), 1000);
        return;
      }
      toast.error("Failed to load connections");
    } catch {
      if (retry) {
        setTimeout(() => fetchConnections(false), 1000);
        return;
      }
      toast.error("Failed to load connections");
    }
    setConnectionsLoading(false);
  }, []);

  const fetchServices = useCallback(async () => {
    try {
      const res = await apiFetch("/capabilities/services");
      if (res.ok) {
        const data = (await res.json()) as {
          services: ServiceMetadata[];
          oauthStatus?: Record<string, { available: boolean; source: string | null }>;
        };
        setServicesMetadata(data.services);
        if (data.oauthStatus) setOauthStatus(data.oauthStatus);
      }
    } catch {
      toast.error("Failed to load service capabilities");
    } finally {
      setServicesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) {
      fetchConnections();
      fetchServices();
    }
  }, [session, fetchConnections, fetchServices]);

  // Check URL params for success/error from OAuth callback.
  // If running inside a popup, notify the opener and close.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get("success");
    const callbackError = params.get("error");
    const connectionId = params.get("connectionId");
    const policyId = params.get("policyId");

    if (window.opener) {
      if (success === "true") {
        window.opener.postMessage(
          {
            type: "connection-oauth-complete",
            connectionId,
            policyId,
          },
          window.location.origin,
        );
      } else if (callbackError) {
        window.opener.postMessage(
          { type: "connection-oauth-error", error: callbackError },
          window.location.origin,
        );
      }
      window.close();
      return;
    }

    if (success === "true") {
      // If a policy was created (permission request flow), redirect to policies page
      if (policyId) {
        router.push(`/dashboard/policies?highlight=${policyId}`);
        return;
      }
      // Otherwise redirect to connections page (remove query params)
      window.history.replaceState({}, "", window.location.pathname);
      fetchConnections();
      return;
    }
    if (callbackError) {
      setError(callbackError);
      toast.error("Connection failed", { description: callbackError, duration: 8000 });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [fetchConnections, router]);

  // Check URL params for permission request approval flow (non-OAuth)
  // When redirected from approvals page with service + approval metadata,
  // auto-navigate to the connection setup form
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const service = params.get("service");
    const agentId = params.get("agentId");
    const actionTemplateId = params.get("actionTemplateId");
    const policyTier = params.get("policyTier");
    const permissionRequestId = params.get("permissionRequestId");
    const allowedModels = params.get("allowedModels");

    if (service && agentId && actionTemplateId && policyTier && permissionRequestId) {
      // Store metadata for auto-policy creation after connection is made
      setApprovalMeta({ agentId, actionTemplateId, policyTier, permissionRequestId, allowedModels: allowedModels || "B" });

      // Auto-select the service flow
      const svcEntry = SERVICE_CATALOG[service as ServiceId];
      if (svcEntry?.credentialType === "bot_token") {
        setFlowService(service as ServiceId);
        setStep("flow");
        setLabel(svcEntry.displayName);
      } else if (svcEntry?.credentialType === "api_key") {
        setFlowService(service as ServiceId);
        setStep("flow");
      }

      // Clean URL params
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Listen for popup completion messages
  useEffect(() => {
    function onPopupMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;

      if (event.data?.type === "connection-oauth-complete") {
        if (event.data.policyId) {
          // Approval flow — policy already created by API callback
          router.push(`/dashboard/policies?highlight=${event.data.policyId}`);
        } else if (event.data.connectionId && !approvalMeta) {
          // Direct creation — show assignment dialog
          triggerAssignDialog(event.data.connectionId, pendingAction, pendingAction?.serviceId ?? null);
        } else {
          fetchConnections();
          setStep("list");
          setSelectedAction(null);
        }
        setReauthTarget(null);
      } else if (event.data?.type === "connection-oauth-error") {
        const msg = event.data.error ?? "OAuth connection failed";
        setError(msg);
        toast.error("Connection failed", { description: msg, duration: 8000 });
        setStep("list");
        setReauthTarget(null);
      }
    }

    window.addEventListener("message", onPopupMessage);
    return () => window.removeEventListener("message", onPopupMessage);
  }, [fetchConnections]);

  const filteredConnections =
    filterService === "all"
      ? connectionsList
      : connectionsList.filter((c) => c.service === filterService);

  // Get unique services from existing connections for filter dropdown
  const availableServices = [...new Set(connectionsList.map((c) => c.service))];

  // Helper: check if a service is singleton
  const isSingleton = (serviceId: string): boolean => {
    const meta = servicesMetadata.find((s) => s.id === serviceId);
    return meta?.singleton ?? false;
  };

  // Helper: check if a singleton service already has a connection
  const hasSingletonConnection = (serviceId: string): boolean => {
    return isSingleton(serviceId) && connectionsList.some((c) => c.service === serviceId);
  };

  /** Check if OAuth credentials are available for an OAuth service's provider */
  const isOauthAvailable = (serviceId: string): boolean => {
    const entry = SERVICE_CATALOG[serviceId as ServiceId];
    if (!entry || entry.credentialType !== "oauth") return true;
    const status = oauthStatus[entry.provider];
    return status?.available ?? false;
  };

  const getOauthSource = (serviceId: string): string | null => {
    const entry = SERVICE_CATALOG[serviceId as ServiceId];
    if (!entry) return null;
    return oauthStatus[entry.provider]?.source ?? null;
  };

  // Group connections by service (separates Gmail and Google Calendar)
  function getConnectionsByProvider() {
    const grouped = new Map<string, { service: string; displayName: string; icon: string; connections: Connection[] }>();

    for (const conn of filteredConnections) {
      const serviceConfig = SERVICE_CATALOG[conn.service as ServiceId];
      const displayName = serviceConfig?.displayName ?? conn.service;
      const icon = serviceConfig?.icon ?? conn.service[0]?.toUpperCase();

      if (!grouped.has(conn.service)) {
        grouped.set(conn.service, { service: conn.service, displayName, icon, connections: [] });
      }
      grouped.get(conn.service)!.connections.push(conn);
    }

    return Array.from(grouped.values());
  }

  function handleSelectAction(action: ActionTemplate) {
    // Block duplicate singleton connections
    if (hasSingletonConnection(action.serviceId)) {
      setError(`Only one ${SERVICE_CATALOG[action.serviceId].displayName} connection is allowed per workspace.`);
      return;
    }

    // Track the action for post-creation assignment dialog
    setPendingAction(action);

    // Non-OAuth providers use custom flows (API key, bot token, etc.)
    const svcEntry = SERVICE_CATALOG[action.serviceId];
    if (svcEntry.credentialType === "bot_token") {
      handleSelectBotToken(action.serviceId);
      return;
    }
    if (svcEntry.credentialType === "api_key") {
      handleSelectApiKey(action.serviceId);
      return;
    }
    if (svcEntry.credentialType === "email") {
      handleSelectEmail(action.serviceId);
      return;
    }

    setFlowService(action.serviceId);
    setSelectedAction(action);
    setError(null);
    const serviceConfig = SERVICE_CATALOG[action.serviceId];
    setLabel(`${serviceConfig.displayName} - ${action.label}`);
    setStep("flow");
  }

  function handleSelectBotToken(serviceId: ServiceId) {
    const entry = SERVICE_CATALOG[serviceId];
    if (entry.singleton && hasSingletonConnection(serviceId)) {
      setError(`Only one ${entry.displayName} connection is allowed per workspace.`);
      return;
    }

    setFlowService(serviceId);
    setStep("flow");
    setLabel(entry.displayName);
  }

  function handleSelectApiKey(serviceId: ServiceId) {
    const entry = SERVICE_CATALOG[serviceId];
    if (entry.singleton && hasSingletonConnection(serviceId)) {
      setError(`Only one ${entry.displayName} connection is allowed per workspace.`);
      return;
    }

    setFlowService(serviceId);
    setStep("flow");
    setError(null);
  }

  function handleSelectEmail(serviceId: ServiceId) {
    const entry = SERVICE_CATALOG[serviceId];
    if (entry.singleton && hasSingletonConnection(serviceId)) {
      setError(`Only one ${entry.displayName} connection is allowed per workspace.`);
      return;
    }

    setFlowService(serviceId);
    setStep("flow");
    setError(null);
    setTimeout(() => {
      document.documentElement.scrollTop = 0;
    }, 100);
  }

  function handleBack() {
    setStep("list");
    setSelectedAction(null);
    setFlowService(null);
    setBotToken("");
    setBotTokenResult(null);
    setApiKeyValue("");
    setApiKeyLabel("");
    setApiKeyResult(null);
    setAppKeyValue("");
    setEmailValue("");
    setEmailAddress("");
    setEmailDisplayName("");
    setEmailImapHost("");
    setEmailImapPort(993);
    setEmailImapTls(true);
    setEmailSmtpHost("");
    setEmailSmtpPort(587);
    setEmailSmtpStarttls(true);
    setEmailUsername("");
    setEmailPassword("");
    setEmailLabel("");
    setEmailResult(null);
    setError(null);
  }

  async function handleStartConnection(action: ActionTemplate) {
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch("/connections/start", {
        method: "POST",
        body: JSON.stringify({
          service: action.serviceId,
          scopes: action.scopes,
          label,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as AuthCodeResult;
      const popup = openCenteredPopup(data.authorizationUrl, "oauth-connection");
      if (!popup) {
        window.location.href = data.authorizationUrl;
      }

      setStep("list"); // Return to list immediately
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start connection",
      );
      setStep("select"); // Stay on select screen if error
    } finally {
      setLoading(false);
    }
  }

  /**
   * After creating a non-OAuth connection, auto-create the policy and delete
   * the permission request if this was triggered from the approvals flow.
   */
  async function finalizeApprovalFlow(connectionId: string) {
    if (!approvalMeta) return;

    try {
      // Create the policy
      const policyRes = await apiFetch("/policies", {
        method: "POST",
        body: JSON.stringify({
          agentId: approvalMeta.agentId,
          connectionId,
          actionTemplateId: approvalMeta.actionTemplateId,
          policyTier: approvalMeta.policyTier,
          allowedModels: approvalMeta.allowedModels.split(","),
        }),
      });

      if (policyRes.ok) {
        // Mark the permission request as approved with connection reference
        await apiFetch(`/agent-permission-requests/${approvalMeta.permissionRequestId}/approve-complete`, {
          method: "PATCH",
          body: JSON.stringify({ connectionId }),
        }).catch(() => {
          toast.error("Failed to update approval status", { description: "The connection was created but the permission request was not marked as approved." });
        });

        const policyData = (await policyRes.json()) as { policy: { id: string } };
        // Redirect to policies page to show the newly created policy
        router.push(`/dashboard/policies?highlight=${policyData.policy.id}`);
        return;
      }
      const errData = await policyRes.json().catch(() => ({ error: "Policy creation failed" })) as { error?: string };
      toast.error("Failed to create policy", { description: errData.error ?? `Server returned ${policyRes.status}`, duration: 8000 });
    } catch (err) {
      toast.error("Failed to create policy", { description: err instanceof Error ? err.message : "Connection was created but policy creation failed. You can create the policy manually.", duration: 8000 });
    }

    setApprovalMeta(null);
  }

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
          label: label || undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as BotTokenResult;
      setBotTokenResult(data);

      // If this came from the approvals flow, auto-create policy
      if (approvalMeta && data.connection?.id) {
        await finalizeApprovalFlow(data.connection.id);
        return;
      }

      // Direct creation — show assignment dialog
      if (data.connection?.id) {
        triggerAssignDialog(data.connection.id, pendingAction, flowService);
        return;
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to validate bot token",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleApiKeySubmit() {
    if (!apiKeyValue.trim() || !flowService) return;

    const entry = SERVICE_CATALOG[flowService];

    // Trello requires both fields
    if (entry.provider === "trello" && !appKeyValue.trim()) {
      setError("Both the Power-Up API Key and User Token are required for Trello.");
      return;
    }

    // Jira requires site URL, email, and API token
    if (entry.provider === "jira" && (!appKeyValue.trim() || !emailValue.trim())) {
      setError("Site URL, email address, and API token are all required for Jira.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload: Record<string, string> = {
        provider: entry.provider,
        service: flowService,
        apiKey: apiKeyValue.trim(),
        label: apiKeyLabel.trim() || entry.displayName,
      };
      if (entry.provider === "trello") {
        payload.appKey = appKeyValue.trim();
      }
      if (entry.provider === "jira") {
        payload.siteUrl = appKeyValue.trim();
        payload.email = emailValue.trim();
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
      setApiKeyResult({ label: data.connection.label });

      // If this came from the approvals flow, auto-create policy
      if (approvalMeta && data.connection?.id) {
        await finalizeApprovalFlow(data.connection.id);
        return;
      }

      // Direct creation — show assignment dialog
      if (data.connection?.id) {
        triggerAssignDialog(data.connection.id, pendingAction, flowService);
        return;
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to create ${entry.displayName} connection`,
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleEmailSubmit() {
    if (!emailAddress.trim() || !emailImapHost.trim() || !emailSmtpHost.trim() || !emailPassword.trim() || !flowService) return;

    setLoading(true);
    setError(null);

    try {
      const payload = {
        email: emailAddress.trim(),
        displayName: emailDisplayName.trim() || undefined,
        imapHost: emailImapHost.trim(),
        imapPort: emailImapPort,
        imapTls: emailImapTls,
        smtpHost: emailSmtpHost.trim(),
        smtpPort: emailSmtpPort,
        smtpStarttls: emailSmtpStarttls,
        username: emailUsername.trim() || undefined,
        password: emailPassword,
        label: emailLabel.trim() || undefined,
      };

      const res = await apiFetch("/connections/email", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { connection: { id: string; label: string } };
      setEmailResult({ label: data.connection.label });

      // If this came from the approvals flow, auto-create policy
      if (approvalMeta && data.connection?.id) {
        await finalizeApprovalFlow(data.connection.id);
        return;
      }

      // Direct creation — show assignment dialog
      if (data.connection?.id) {
        triggerAssignDialog(data.connection.id, pendingAction, flowService);
        return;
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create email connection",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;

    setRevoking(true);
    try {
      const res = await apiFetch(`/connections/${revokeTarget.id}/revoke`, {
        method: "POST",
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      setConnectionsList((prev) =>
        prev.map((c) =>
          c.id === revokeTarget.id ? { ...c, status: "revoked" as const } : c,
        ),
      );
      setRevokeTarget(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to revoke connection",
      );
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
    }
  }

  async function handleTestConnection(connectionId: string) {
    setTestingConnectionId(connectionId);
    setTestResult(null);
    try {
      const res = await apiFetch(`/connections/${connectionId}/test`, { method: "POST" });
      const data = (await res.json()) as { ok: boolean; detail?: string; error?: string; hint?: string; provider?: string };
      const result: { id: string; ok: boolean; detail?: string; error?: string; hint?: string } = { id: connectionId, ok: data.ok };
      if (data.detail) result.detail = data.detail;
      if (data.error) result.error = data.error;
      if (data.hint) result.hint = data.hint;
      setTestResult(result);
      if (data.ok) {
        setConnectionsList((prev) =>
          prev.map((c) =>
            c.id === connectionId ? { ...c, status: "healthy" as const } : c,
          ),
        );
      } else {
        setConnectionsList((prev) =>
          prev.map((c) =>
            c.id === connectionId ? { ...c, status: "needs_reauth" as const } : c,
          ),
        );
      }
    } catch (err) {
      setTestResult({ id: connectionId, ok: false, error: err instanceof Error ? err.message : "Failed to test connection" });
    } finally {
      setTestingConnectionId(null);
    }
  }

  async function handleReauth() {
    if (!reauthTarget) return;

    setReauthLoading(true);
    setError(null);

    const credType = SERVICE_CATALOG[reauthTarget.service as ServiceId]?.credentialType;
    const isInline = credType === "bot_token" || credType === "api_key" || credType === "email";
    const isCredentialUpdate = isInline && reauthTarget.status !== "needs_reauth";

    try {
      if (isInline) {
        // Inline credential reauth — send credential in body, no popup needed
        const body: Record<string, string> = {};
        if (credType === "bot_token") body.botToken = reauthCredential;
        else body.apiKey = reauthCredential;

        // Trello needs both app key and user token
        const provider = SERVICE_CATALOG[reauthTarget.service as ServiceId]?.provider;
        if (provider === "trello" && reauthAppKey.trim()) {
          body.appKey = reauthAppKey.trim();
        }

        // Jira needs site URL and email
        if (provider === "jira") {
          if (reauthAppKey.trim()) body.siteUrl = reauthAppKey.trim();
          if (reauthEmail.trim()) body.email = reauthEmail.trim();
        }

        const res = await apiFetch(`/connections/${reauthTarget.id}/${isCredentialUpdate ? "credentials" : "reauth"}`, {
          method: isCredentialUpdate ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const data = (await res.json()) as { error: string };
          throw new Error(data.error);
        }

        // Success — refresh connections list
        setReauthTarget(null);
        setReauthCredential("");
        setReauthAppKey("");
        setReauthEmail("");
        fetchConnections();
      } else {
        // OAuth reauth — existing redirect flow
        const res = await apiFetch(`/connections/${reauthTarget.id}/reauth`, {
          method: "POST",
        });

        if (!res.ok) {
          const data = (await res.json()) as { error: string };
          throw new Error(data.error);
        }

        const data = (await res.json()) as AuthCodeResult;
        const popup = openCenteredPopup(data.authorizationUrl, "oauth-reauth");
        if (!popup) {
          window.location.href = data.authorizationUrl;
        }
        setReauthTarget(null);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : isCredentialUpdate ? "Failed to update credential" : "Failed to reconnect",
      );
    } finally {
      setReauthLoading(false);
    }
  }

  async function fetchAgentsForAssignment() {
    try {
      const res = await apiFetch("/agents");
      if (res.ok) {
        const data = (await res.json()) as { agents: Array<{ id: string; name: string }> };
        setAssignAgents(data.agents);
        if (data.agents.length === 1 && data.agents[0]) setAssignAgentId(data.agents[0].id);
      }
    } catch {
      toast.error("Failed to load agents");
    }
  }

  function triggerAssignDialog(connectionId: string, action: ActionTemplate | null, serviceId: string | null) {
    const actionTemplateId = action?.id ?? ACTION_TEMPLATES.find((t) => t.serviceId === serviceId)?.id ?? "";
    const svc = action?.serviceId ?? serviceId ?? "";
    setAssignConnection({ connectionId, actionTemplateId, serviceId: svc });
    setStep("list");
    setSelectedAction(null);
    fetchAgentsForAssignment();
  }

  function clearAssignDialog() {
    setAssignConnection(null);
    setAssignAgentId("");
    setAssignPolicyTier("standard");
    setAssignAgents([]);
    setPendingAction(null);
    fetchConnections();
  }

  async function handleAssignPolicy() {
    if (!assignConnection || !assignAgentId) return;
    setAssignLoading(true);
    try {
      const res = await apiFetch("/policies", {
        method: "POST",
        body: JSON.stringify({
          agentId: assignAgentId,
          connectionId: assignConnection.connectionId,
          actionTemplateId: assignConnection.actionTemplateId,
          policyTier: assignPolicyTier,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }
      const data = (await res.json()) as { policy: { id: string } };
      router.push(`/dashboard/policies?highlight=${data.policy.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create policy");
    } finally {
      setAssignLoading(false);
      setAssignConnection(null);
    }
  }

  if (!session) return null;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Agent Connections</h1>
          <p className="mt-1 text-muted">
            Control what agents can do on your behalf
          </p>
        </div>
        {step === "list" && (
          <button
            onClick={() => setStep("select")}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            + Connect App
          </button>
        )}
      </div>

      {error && step === "list" && (
        <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {step === "list" && (
        <div className="mt-8">
          {connectionsLoading ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-muted">Loading connections...</p>
            </div>
          ) : connectionsList.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-muted">
                No connections yet. Click &quot;+ Connect App&quot; to get
                started.
              </p>
            </div>
          ) : (
            <>
              {/* Filter dropdown */}
              {availableServices.length > 1 && (
                <div className="mb-4">
                  <label
                    htmlFor="filter-service"
                    className="mr-2 text-sm font-medium text-foreground"
                  >
                    Filter by service:
                  </label>
                  <select
                    id="filter-service"
                    value={filterService}
                    onChange={(e) => setFilterService(e.target.value)}
                    className="rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="all">All services</option>
                    {availableServices.map((s) => {
                      const config = SERVICE_CATALOG[s as ServiceId];
                      return (
                        <option key={s} value={s}>
                          {config?.displayName ?? s}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              {/* Connection cards - Grouped by Service */}
              <div className="space-y-6">
                {getConnectionsByProvider().map(({ service, displayName, icon, connections }) => (
                  <div
                    key={service}
                    className="space-y-3"
                  >
                    {/* Service Header */}
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{icon}</span>
                      <h3 className="text-sm font-semibold text-foreground">{displayName}</h3>
                      <span className="text-xs text-muted">
                        {connections.length} {connections.length === 1 ? "connection" : "connections"}
                      </span>
                      {isSingleton(service) && (
                        <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                          One per workspace
                        </span>
                      )}
                    </div>

                    {/* Connection Cards */}
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {connections
                        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                        .map((conn) => {
                  const serviceConfig = SERVICE_CATALOG[conn.service as ServiceId];
                  const statusConfig = STATUS_CONFIG[conn.status];

                  return (
                    <div
                      key={conn.id}
                      className={`group rounded-lg border border-border bg-white overflow-hidden hover:shadow-lg hover:border-blue-400 transition-all flex flex-col ${
                        conn.status === "healthy"
                          ? "border-t-4 border-t-green-200"
                          : conn.status === "needs_reauth"
                            ? "border-t-4 border-t-yellow-200"
                            : conn.status === "revoked"
                              ? "border-t-4 border-t-red-200"
                              : ""
                      }`}
                    >
                      <div className="p-3 flex-1 flex flex-col">
                        {/* Header: Icon, Name, Status */}
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xl flex-shrink-0">
                            {serviceConfig?.icon ?? conn.service[0]?.toUpperCase()}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1 min-w-0">
                                <h4 className="font-semibold text-sm text-foreground truncate">
                                  {conn.label}
                                </h4>
                                {serviceConfig?.docsPath && (
                                  <HelpTooltip docsPath={serviceConfig.docsPath}>
                                    {serviceConfig.description}
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

                        {/* Agent bindings */}
                        {conn.policies && conn.policies.length > 0 && (
                          <div className="mb-2">
                            <div className="flex flex-wrap gap-1">
                              {conn.policies.map((policy) => (
                                <span
                                  key={policy.id}
                                  className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700"
                                >
                                  <span>🤖</span> {policy.agentName}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Protection Status */}
                        {(() => {
                          const protectionStatus = getConnectionProtectionStatus(conn);
                          return (
                            <div className="mb-2">
                              <div className="mb-1">
                                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
                                  protectionStatus.headline.includes("\u26a0\ufe0f")
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
                          );
                        })()}

                        {/* Test result */}
                        {testResult?.id === conn.id && (
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
                            {new Date(conn.createdAt).toLocaleDateString(
                              undefined,
                              { day: "numeric", month: "short", year: "numeric" },
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => setReauthTarget(conn)}
                              className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors whitespace-nowrap"
                            >
                              Settings
                            </button>
                            {conn.status !== "revoked" && (
                              <button
                                onClick={() => handleTestConnection(conn.id)}
                                disabled={testingConnectionId === conn.id}
                                className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {testingConnectionId === conn.id ? "Testing..." : "Test"}
                              </button>
                            )}
                            {conn.status === "needs_reauth" && (
                              <button
                                onClick={() => setReauthTarget(conn)}
                                className="text-xs font-medium text-yellow-600 hover:text-yellow-700 transition-colors whitespace-nowrap"
                              >
                                Reconnect
                              </button>
                            )}
                            {conn.status !== "revoked" && (
                              <button
                                onClick={() => setRevokeTarget(conn)}
                                className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors whitespace-nowrap"
                              >
                                Revoke
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                      );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Service selection — tabbed by category */}
      {step === "select" && (
        <div className="mt-8">
          <div className="mb-2 flex items-center gap-2">
            <button
              onClick={handleBack}
              className="text-sm text-muted hover:text-foreground"
            >
              &larr; Back
            </button>
            <h2 className="text-lg font-semibold text-foreground">
              Choose a permission to grant
            </h2>
          </div>
          <p className="mb-6 text-sm text-muted">
            Select what you want to allow agents to do. Each permission shows the specific capabilities provided by the connector.
          </p>

          {error && (
            <div className="mb-4 rounded-md bg-red-50 border border-red-200 p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

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
          <div className="space-y-8">
            {getServicesByCategory(activeCategory).map(([serviceId, entry]) => {
              const actions = ACTION_TEMPLATES.filter((a) => a.serviceId === serviceId);
              const hasConnection = hasSingletonConnection(serviceId);

              // Services with no action templates get a direct connect card
              if (actions.length === 0) {
                const oauthOk = isOauthAvailable(serviceId);
                const oauthSrc = getOauthSource(serviceId);
                const connectHandler =
                  entry.credentialType === "bot_token"
                    ? () => handleSelectBotToken(serviceId)
                    : entry.credentialType === "api_key"
                    ? () => handleSelectApiKey(serviceId)
                    : entry.credentialType === "email"
                    ? () => handleSelectEmail(serviceId)
                    : undefined;

                return (
                  <div key={serviceId}>
                    <div className="mb-4 flex items-center gap-2">
                      <span className="text-2xl">{entry.icon}</span>
                      <h3 className="text-lg font-semibold text-foreground">
                        {entry.displayName}
                      </h3>
                      {entry.docsPath && (
                        <HelpTooltip docsPath={entry.docsPath}>{entry.description}</HelpTooltip>
                      )}
                      {oauthSrc === "bya" && (
                        <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600 border border-blue-200">
                          using your app
                        </span>
                      )}
                    </div>
                    {!oauthOk && entry.credentialType === "oauth" && (
                      <div className="mb-3 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                        OAuth app not configured for {entry.provider}.{" "}
                        <Link href="/dashboard/settings/apps" className="font-medium underline hover:text-yellow-900">
                          Set up in Settings → Apps
                        </Link>
                      </div>
                    )}
                    <button
                      onClick={connectHandler}
                      disabled={hasConnection || !connectHandler || !oauthOk}
                      className={`w-full rounded-lg border-2 p-4 text-left transition-all ${
                        hasConnection || !oauthOk
                          ? "border-gray-300 bg-gray-50 cursor-not-allowed opacity-60"
                          : "border-border bg-card hover:border-blue-400 hover:bg-blue-50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-foreground">
                          Connect {entry.displayName}
                        </div>
                        {entry.singleton && (
                          <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 border border-purple-300">
                            One per workspace
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-sm text-muted">
                        {entry.description}
                      </div>
                      {hasConnection && (
                        <div className="mt-2 text-xs text-orange-600 font-medium">
                          Already connected — only one allowed per workspace
                        </div>
                      )}
                    </button>
                  </div>
                );
              }

              // Services with action templates show action cards
              const svcOauthOk = isOauthAvailable(serviceId);
              const svcOauthSrc = getOauthSource(serviceId);
              return (
                <div key={serviceId}>
                  <div className="mb-4 flex items-center gap-2">
                    <span className="text-2xl">{entry.icon}</span>
                    <h3 className="text-lg font-semibold text-foreground">
                      {entry.displayName}
                    </h3>
                    {entry.docsPath && (
                      <HelpTooltip docsPath={entry.docsPath}>{entry.description}</HelpTooltip>
                    )}
                    {svcOauthSrc === "bya" && (
                      <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600 border border-blue-200">
                        using your app
                      </span>
                    )}
                  </div>
                  {!svcOauthOk && entry.credentialType === "oauth" && (
                    <div className="mb-3 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                      OAuth app not configured for {entry.provider}.{" "}
                      <Link href="/dashboard/settings/apps" className="font-medium underline hover:text-yellow-900">
                        Set up in Settings → Apps
                      </Link>
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
                          onClick={() => handleSelectAction(action)}
                          disabled={isDisabled}
                          className={`rounded-lg border-2 p-4 text-left transition-all ${
                            actionHasConn
                              ? "border-gray-300 bg-gray-50 cursor-not-allowed opacity-60"
                              : "border-border bg-card hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <div className="font-medium text-foreground">
                              {action.label}
                            </div>
                            {isSingleton(action.serviceId) && (
                              <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 border border-purple-300">
                                One per workspace
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-sm text-muted">
                            {action.description}
                          </div>
                          {actionHasConn && (
                            <div className="mt-2 text-xs text-orange-600 font-medium">
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

      {/* Custom connection flows (Bot Token, Anthropic) */}
      {step === "flow" && flowService && SERVICE_CATALOG[flowService].credentialType === "bot_token" && (() => {
        const flowEntry = SERVICE_CATALOG[flowService];
        const hints: Record<string, { description: string; placeholder: string; helpText?: string; docsPath?: string }> = {
          telegram: { description: "Enter the bot token from @BotFather to connect your Telegram bot.", placeholder: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ", helpText: "Create a bot with @BotFather on Telegram, then copy the token it gives you.", docsPath: "/connections/telegram" },
          slack: { description: "Enter the Bot User OAuth Token from your Slack App settings.", placeholder: "xoxb-...", helpText: "Go to api.slack.com/apps, select your app, then find the Bot User OAuth Token under OAuth & Permissions.", docsPath: "/connections/slack" },
        };
        const hint = hints[flowEntry.provider] ?? { description: `Enter the bot token for ${flowEntry.displayName}.`, placeholder: "bot-token-here" };
        return (
        <div className="mt-8 max-w-xl">
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={handleBack}
              className="text-sm text-muted hover:text-foreground"
            >
              &larr; Back
            </button>
            <h2 className="text-lg font-semibold text-foreground">
              Connect {flowEntry.displayName}
            </h2>
          </div>
          <div className="rounded-lg border border-border bg-card p-6">
            {!botTokenResult ? (
              <>
                <div className="flex items-start justify-between mb-4">
                  <p className="text-sm text-muted">
                    {hint.description}
                  </p>
                  {(hint.helpText || hint.docsPath) && (
                    <HelpTooltip docsPath={hint.docsPath}>{hint.helpText ?? hint.description}</HelpTooltip>
                  )}
                </div>
                <div className="mb-4">
                  <label
                    htmlFor="bot-token-label"
                    className="block text-sm font-medium text-foreground"
                  >
                    Connection Label
                  </label>
                  <input
                    id="bot-token-label"
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={`e.g., My ${flowEntry.displayName}`}
                  />
                </div>
                <div className="mb-4">
                  <label
                    htmlFor="bot-token"
                    className="block text-sm font-medium text-foreground"
                  >
                    Bot Token
                  </label>
                  <input
                    id="bot-token"
                    type="text"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={hint.placeholder}
                  />
                </div>
                {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
                <button
                  onClick={handleBotTokenValidate}
                  disabled={loading || !botToken.trim()}
                  className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Validating..." : "Validate & Connect"}
                </button>
              </>
            ) : (
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-2xl">
                  {flowEntry.icon}
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  Connected
                </h3>
                <p className="mt-2 text-sm text-muted">
                  {botTokenResult.label}
                </p>
                <p className="mt-4 text-sm text-muted">
                  {botTokenResult.message}
                </p>
                <button
                  onClick={() => {
                    setStep("list");
                    setFlowService(null);
                    setBotToken("");
                    setBotTokenResult(null);
                    fetchConnections();
                  }}
                  className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {step === "flow" && flowService && SERVICE_CATALOG[flowService].credentialType === "api_key" && (() => {
        const flowEntry = SERVICE_CATALOG[flowService];
        const hints: Record<string, { description: string; placeholder: string; keyLabel: string; helpText?: string; docsPath?: string; appKeyPlaceholder?: string; appKeyLabel?: string }> = {
          anthropic: {
            description: "Enter your Anthropic API key or Claude Code setup token to allow agents to use Claude models through AgentHiFive.",
            placeholder: "sk-ant-api... or sk-ant-oat01-...",
            keyLabel: "API Key or Setup Token",
            helpText: "Get an API key from console.anthropic.com, or run claude setup-token in Claude Code to use your Pro/Max subscription.",
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
            description: "Enter your OpenRouter API key to access models from multiple providers.",
            placeholder: "sk-or-v1-...",
            keyLabel: "API Key",
            helpText: "Get an API key from openrouter.ai/settings/keys.",
            docsPath: "/connections/openrouter",
          },
          notion: {
            description: "Enter your Notion internal integration token to allow agents to read and manage your workspace.",
            placeholder: "ntn_...",
            keyLabel: "Integration Token",
            helpText: "Create an integration at notion.so/profile/integrations, then share pages with it.",
            docsPath: "/connections/notion",
          },
          trello: {
            description: "Enter your Trello Power-Up API key and user token to allow agents to read and manage your boards, lists, and cards.",
            placeholder: "ATTA...",
            keyLabel: "User Token",
            helpText: "Create a Power-Up at trello.com/power-ups/admin to get the API key, then generate a user token via the authorize URL. See the docs for step-by-step instructions.",
            docsPath: "/connections/trello",
            appKeyPlaceholder: "32-character API key from Power-Up settings",
            appKeyLabel: "Power-Up API Key",
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
        <div className="mt-8 max-w-xl">
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={handleBack}
              className="text-sm text-muted hover:text-foreground"
            >
              &larr; Back
            </button>
            <h2 className="text-lg font-semibold text-foreground">
              Connect {flowEntry.displayName}
            </h2>
          </div>
          <div className="rounded-lg border border-border bg-card p-6">
            {!apiKeyResult ? (
              <>
                <div className="flex items-start justify-between mb-4">
                  <p className="text-sm text-muted">
                    {hint.description}
                  </p>
                  {(hint.helpText || hint.docsPath) && (
                    <HelpTooltip docsPath={hint.docsPath}>{hint.helpText ?? hint.description}</HelpTooltip>
                  )}
                </div>
                <div className="mb-4">
                  <label
                    htmlFor="apikey-label"
                    className="block text-sm font-medium text-foreground"
                  >
                    Connection Label
                  </label>
                  <input
                    id="apikey-label"
                    type="text"
                    value={apiKeyLabel || flowEntry.displayName}
                    onChange={(e) => setApiKeyLabel(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={`e.g., ${flowEntry.displayName}`}
                  />
                </div>
                {/* App Key field — only shown for providers that need it (Trello, Jira siteUrl) */}
                {hint.appKeyLabel && (
                  <div className="mb-4">
                    <label
                      htmlFor="apikey-appkey"
                      className="block text-sm font-medium text-foreground"
                    >
                      {hint.appKeyLabel}
                    </label>
                    <input
                      id="apikey-appkey"
                      type="text"
                      value={appKeyValue}
                      onChange={(e) => setAppKeyValue(e.target.value)}
                      className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder={hint.appKeyPlaceholder ?? ""}
                    />
                  </div>
                )}
                {/* Email field — only shown for Jira */}
                {flowEntry.provider === "jira" && (
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-foreground">
                      Email Address <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      value={emailValue}
                      onChange={(e) => setEmailValue(e.target.value)}
                      placeholder="you@company.com"
                      className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                )}
                <div className="mb-4">
                  <label
                    htmlFor="apikey-key"
                    className="block text-sm font-medium text-foreground"
                  >
                    {hint.keyLabel}
                  </label>
                  <input
                    id="apikey-key"
                    type="text"
                    value={apiKeyValue}
                    onChange={(e) => setApiKeyValue(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={hint.placeholder}
                  />
                </div>
                {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
                <button
                  onClick={handleApiKeySubmit}
                  disabled={loading || !apiKeyValue.trim() || (!!hint.appKeyLabel && !appKeyValue.trim()) || (flowEntry.provider === "jira" && !emailValue.trim())}
                  className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Connecting..." : "Connect"}
                </button>
              </>
            ) : (
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-2xl">
                  {flowEntry.icon}
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  Connected
                </h3>
                <p className="mt-2 text-sm text-muted">
                  {apiKeyResult.label}
                </p>
                <button
                  onClick={() => {
                    setStep("list");
                    setFlowService(null);
                    setApiKeyValue("");
                    setApiKeyLabel("");
                    setApiKeyResult(null);
                    setAppKeyValue("");
                    setEmailValue("");
                    fetchConnections();
                  }}
                  className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* Email (IMAP/SMTP) flow */}
      {step === "flow" && flowService && SERVICE_CATALOG[flowService].credentialType === "email" && (() => {
        const flowEntry = SERVICE_CATALOG[flowService];

        const EMAIL_PRESETS: { name: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; note?: string }[] = [
          { name: "Fastmail", imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 587 },
          { name: "iCloud", imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587, note: "Requires an app-specific password from appleid.apple.com" },
        ];

        function applyPreset(preset: { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }) {
          setEmailImapHost(preset.imapHost);
          setEmailImapPort(preset.imapPort);
          setEmailSmtpHost(preset.smtpHost);
          setEmailSmtpPort(preset.smtpPort);
          setEmailImapTls(true);
          setEmailSmtpStarttls(true);
        }

        function clearPreset() {
          setEmailImapHost("");
          setEmailImapPort(993);
          setEmailSmtpHost("");
          setEmailSmtpPort(587);
          setEmailImapTls(true);
          setEmailSmtpStarttls(true);
        }

        return (
        <div id="email-connection-form" className="mt-8 max-w-xl">
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={handleBack}
              className="text-sm text-muted hover:text-foreground"
            >
              &larr; Back
            </button>
            <h2 className="text-lg font-semibold text-foreground">
              Connect {flowEntry.displayName}
            </h2>
          </div>
          <div className="rounded-lg border border-border bg-card p-6">
            {!emailResult ? (
              <>
                <p className="text-sm text-muted mb-4">
                  Connect to any email account via IMAP and SMTP. For Gmail and Outlook, use the OAuth connection instead. IMAP is for providers like Fastmail, iCloud, or self-hosted mail servers.
                </p>

                {/* Provider presets */}
                <div className="mb-5">
                  <label className="block text-sm font-medium text-foreground mb-2">
                    Email Provider
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {EMAIL_PRESETS.map((preset) => (
                      <button
                        key={preset.name}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                          emailImapHost === preset.imapHost
                            ? "border-blue-500 bg-blue-50 text-blue-700"
                            : "border-border bg-white text-foreground hover:border-blue-400 hover:bg-blue-50"
                        }`}
                      >
                        {preset.name}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={clearPreset}
                      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                        emailImapHost && !EMAIL_PRESETS.some((p) => p.imapHost === emailImapHost)
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : !emailImapHost
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-border bg-white text-foreground hover:border-blue-400 hover:bg-blue-50"
                      }`}
                    >
                      Custom
                    </button>
                  </div>
                </div>

                {/* Email address */}
                <div className="mb-4">
                  <label htmlFor="email-address" className="block text-sm font-medium text-foreground">
                    Email Address <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="email-address"
                    type="email"
                    value={emailAddress}
                    onChange={(e) => setEmailAddress(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="you@example.com"
                  />
                </div>

                {/* Display name */}
                <div className="mb-4">
                  <label htmlFor="email-display-name" className="block text-sm font-medium text-foreground">
                    Display Name
                  </label>
                  <input
                    id="email-display-name"
                    type="text"
                    value={emailDisplayName}
                    onChange={(e) => setEmailDisplayName(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="Your Name"
                  />
                </div>

                {/* IMAP settings */}
                <fieldset className="mb-4 rounded-md border border-border p-4">
                  <legend className="px-1 text-sm font-medium text-foreground">IMAP (Incoming)</legend>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label htmlFor="email-imap-host" className="block text-xs font-medium text-muted">
                        Host <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="email-imap-host"
                        type="text"
                        value={emailImapHost}
                        onChange={(e) => setEmailImapHost(e.target.value)}
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        placeholder="imap.gmail.com"
                      />
                    </div>
                    <div>
                      <label htmlFor="email-imap-port" className="block text-xs font-medium text-muted">
                        Port
                      </label>
                      <input
                        id="email-imap-port"
                        type="number"
                        value={emailImapPort}
                        onChange={(e) => setEmailImapPort(parseInt(e.target.value, 10) || 993)}
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                  <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={emailImapTls}
                      onChange={(e) => setEmailImapTls(e.target.checked)}
                      className="rounded border-border text-blue-600 focus:ring-blue-500"
                    />
                    Use TLS
                  </label>
                </fieldset>

                {/* SMTP settings */}
                <fieldset className="mb-4 rounded-md border border-border p-4">
                  <legend className="px-1 text-sm font-medium text-foreground">SMTP (Outgoing)</legend>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label htmlFor="email-smtp-host" className="block text-xs font-medium text-muted">
                        Host <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="email-smtp-host"
                        type="text"
                        value={emailSmtpHost}
                        onChange={(e) => setEmailSmtpHost(e.target.value)}
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        placeholder="smtp.gmail.com"
                      />
                    </div>
                    <div>
                      <label htmlFor="email-smtp-port" className="block text-xs font-medium text-muted">
                        Port
                      </label>
                      <input
                        id="email-smtp-port"
                        type="number"
                        value={emailSmtpPort}
                        onChange={(e) => setEmailSmtpPort(parseInt(e.target.value, 10) || 587)}
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                  <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={emailSmtpStarttls}
                      onChange={(e) => setEmailSmtpStarttls(e.target.checked)}
                      className="rounded border-border text-blue-600 focus:ring-blue-500"
                    />
                    Use STARTTLS
                  </label>
                </fieldset>

                {/* Authentication */}
                <div className="mb-4">
                  <label htmlFor="email-username" className="block text-sm font-medium text-foreground">
                    Username
                  </label>
                  <input
                    id="email-username"
                    type="text"
                    value={emailUsername}
                    onChange={(e) => setEmailUsername(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={emailAddress || "Defaults to email address"}
                  />
                  <p className="mt-1 text-xs text-muted">Leave blank to use the email address as username.</p>
                </div>
                <div className="mb-4">
                  <label htmlFor="email-password" className="block text-sm font-medium text-foreground">
                    Password <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="email-password"
                    type="password"
                    value={emailPassword}
                    onChange={(e) => setEmailPassword(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="App password or account password"
                  />
                </div>

                {/* Label */}
                <div className="mb-4">
                  <label htmlFor="email-conn-label" className="block text-sm font-medium text-foreground">
                    Connection Label
                  </label>
                  <input
                    id="email-conn-label"
                    type="text"
                    value={emailLabel}
                    onChange={(e) => setEmailLabel(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={emailAddress ? `Email - ${emailAddress}` : "e.g., Work Email"}
                  />
                </div>

                {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
                <button
                  onClick={handleEmailSubmit}
                  disabled={loading || !emailAddress.trim() || !emailImapHost.trim() || !emailSmtpHost.trim() || !emailPassword.trim()}
                  className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Connecting..." : "Connect"}
                </button>
              </>
            ) : (
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-2xl">
                  {flowEntry.icon}
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  Connected
                </h3>
                <p className="mt-2 text-sm text-muted">
                  {emailResult.label}
                </p>
                <button
                  onClick={() => {
                    setStep("list");
                    setFlowService(null);
                    setEmailAddress("");
                    setEmailDisplayName("");
                    setEmailImapHost("");
                    setEmailImapPort(993);
                    setEmailImapTls(true);
                    setEmailSmtpHost("");
                    setEmailSmtpPort(587);
                    setEmailSmtpStarttls(true);
                    setEmailUsername("");
                    setEmailPassword("");
                    setEmailLabel("");
                    setEmailResult(null);
                    fetchConnections();
                  }}
                  className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* OAuth pre-connection step */}
      {step === "flow" && flowService && SERVICE_CATALOG[flowService].credentialType === "oauth" && (() => {
        const flowEntry = SERVICE_CATALOG[flowService];
        const providerName = flowEntry.group || flowEntry.provider;
        return (
        <div className="mt-8 max-w-xl">
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={handleBack}
              className="text-sm text-muted hover:text-foreground"
            >
              &larr; Back
            </button>
            <h2 className="text-lg font-semibold text-foreground">
              Connect {flowEntry.displayName}
            </h2>
          </div>
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="text-sm text-muted mb-4">
              {selectedAction?.description ?? flowEntry.description}
            </p>
            <div className="mb-4">
              <label
                htmlFor="oauth-label"
                className="block text-sm font-medium text-foreground"
              >
                Connection Label
              </label>
              <input
                id="oauth-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder={`e.g., My ${flowEntry.displayName}`}
              />
            </div>
            {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
            <button
              onClick={() => { if (selectedAction) handleStartConnection(selectedAction); }}
              disabled={loading || !selectedAction}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Redirecting..." : `Connect with ${providerName}`}
            </button>
            <p className="mt-3 text-center text-xs text-muted">
              You&apos;ll be redirected to sign in with {providerName} and authorize access.
            </p>
          </div>
        </div>
        );
      })()}

      {/* Reauth dialog */}
      {reauthTarget && (() => {
        const credType = SERVICE_CATALOG[reauthTarget.service as ServiceId]?.credentialType;
        const isInline = credType === "bot_token" || credType === "api_key" || credType === "email";
        const provider = SERVICE_CATALOG[reauthTarget.service as ServiceId]?.provider;
        const isCredentialUpdate = isInline && reauthTarget.status !== "needs_reauth";

        const placeholders: Record<string, string> = {
          telegram: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ",
          slack: "xoxb-...",
          anthropic: "sk-ant-api...",
          openai: "sk-...",
          gemini: "AIza...",
          trello: "ATTA...",
          jira: "ATATT3xFfGF0...",
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
              <h3 className="text-lg font-semibold text-foreground">
                {isCredentialUpdate ? "Update credential for" : "Reconnect"} {reauthTarget.label}
              </h3>
              <p className="mt-2 text-sm text-muted">
                {isInline
                  ? provider === "trello"
                    ? isCredentialUpdate
                      ? "Enter a replacement Trello Power-Up API key and user token. Existing policies and settings will be preserved."
                      : "Enter your Trello Power-Up API key and user token to restore access. Existing policies and settings will be preserved."
                    : provider === "jira"
                    ? isCredentialUpdate
                      ? "Enter a replacement Jira Cloud site URL, email, and API token. Existing policies and settings will be preserved."
                      : "Enter your Jira Cloud site URL, email, and API token to restore access. Existing policies and settings will be preserved."
                    : isCredentialUpdate
                    ? `Enter a replacement ${credType === "bot_token" ? "bot token" : "API key"}. Existing policies and settings will be preserved.`
                    : `Enter a new ${credType === "bot_token" ? "bot token" : "API key"} to restore access. Existing policies and settings will be preserved.`
                  : "Your connection needs to be reauthorized. Existing policies and settings will be preserved. You will be redirected to sign in again."}
              </p>

              {isInline && reauthTarget.credentialPreview && (
                <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  <div>
                    {reauthTarget.credentialPreview.primaryLabel}: <span className="font-mono">{reauthTarget.credentialPreview.primaryMasked}</span>
                  </div>
                  {reauthTarget.credentialPreview.secondaryLabel && reauthTarget.credentialPreview.secondaryMasked && (
                    <div className="mt-1">
                      {reauthTarget.credentialPreview.secondaryLabel}: <span className="font-mono">{reauthTarget.credentialPreview.secondaryMasked}</span>
                    </div>
                  )}
                  {reauthTarget.credentialPreview.tertiaryLabel && reauthTarget.credentialPreview.tertiaryValue && (
                    <div className="mt-1">
                      {reauthTarget.credentialPreview.tertiaryLabel}: {reauthTarget.credentialPreview.tertiaryValue}
                    </div>
                  )}
                </div>
              )}

              {/* Trello app key field (shown before user token) */}
              {isInline && provider === "trello" && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-foreground">
                    Power-Up API Key
                  </label>
                  <input
                    type="text"
                    value={reauthAppKey}
                    onChange={(e) => setReauthAppKey(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="32-character API key from Power-Up settings"
                  />
                </div>
              )}

              {/* Jira site URL and email fields */}
              {isInline && provider === "jira" && (
                <>
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-foreground">
                      Jira Site URL
                    </label>
                    <input
                      type="text"
                      value={reauthAppKey}
                      onChange={(e) => setReauthAppKey(e.target.value)}
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
                      value={reauthEmail}
                      onChange={(e) => setReauthEmail(e.target.value)}
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
                  <input
                    type="text"
                    value={reauthCredential}
                    onChange={(e) => setReauthCredential(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder={placeholders[provider ?? ""] ?? "Enter credential"}
                  />
                </div>
              )}

              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
              <div className="mt-5 flex justify-end gap-3">
                <button
                  onClick={() => {
                    setReauthTarget(null);
                    setReauthCredential("");
                    setReauthAppKey("");
                    setReauthEmail("");
                    setError(null);
                  }}
                  disabled={reauthLoading}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReauth}
                  disabled={reauthLoading || (isInline && !reauthCredential.trim()) || (provider === "trello" && !reauthAppKey.trim()) || (provider === "jira" && (!reauthAppKey.trim() || !reauthEmail.trim()))}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {reauthLoading ? (isInline ? "Saving..." : "Redirecting...") : isCredentialUpdate ? "Update credential" : "Reconnect"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Revocation confirmation dialog */}
      {revokeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">
              Revoke Permission
            </h3>
            <p className="mt-2 text-sm text-muted">
              Are you sure you want to revoke{" "}
              <span className="font-medium text-foreground">
                {revokeTarget.label}
              </span>
              ?
            </p>
            <div className="mt-3 rounded-md bg-yellow-50 border border-yellow-200 p-3">
              <p className="text-sm text-yellow-800">
                {isRevocationInstant(revokeTarget.service as ServiceId)
                  ? "Agents will immediately and permanently lose access to this service."
                  : "Agents will immediately lose access to this service. Previously issued access tokens (Model A) may remain valid for up to 1 hour."}
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setRevokeTarget(null)}
                disabled={revoking}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {revoking ? "Revoking..." : "Revoke Access"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-creation assignment dialog */}
      {assignConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100">
                <span className="text-green-600 text-sm">&#10003;</span>
              </div>
              <h3 className="text-lg font-semibold text-foreground">
                Connection Created
              </h3>
            </div>
            <p className="mt-2 text-sm text-muted">
              Assign this connection to an agent so it can start using it.
            </p>

            {assignAgents.length === 0 ? (
              <div className="mt-4 rounded-md bg-gray-50 border border-border p-3">
                <p className="text-sm text-muted">
                  No agents found. Create an agent in My Agents first, then assign this connection.
                </p>
              </div>
            ) : (
              <>
                <div className="mt-4">
                  <label htmlFor="assign-agent" className="block text-sm font-medium text-foreground mb-1">
                    Agent
                  </label>
                  <select
                    id="assign-agent"
                    value={assignAgentId}
                    onChange={(e) => setAssignAgentId(e.target.value)}
                    className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Select an agent...</option>
                    {assignAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="mt-4">
                  <label className="block text-sm font-medium text-foreground mb-2">
                    Security Level
                  </label>
                  <div className="space-y-2">
                    {([
                      { value: "strict" as const, label: "Strict", desc: "Read-only access. Sensitive actions require your approval. Personal information is redacted." },
                      { value: "standard" as const, label: "Standard", desc: "Reads allowed. Sensitive writes require your approval. Personal information is redacted." },
                      { value: "minimal" as const, label: "Minimal", desc: "Full access with no restrictions. No privacy filtering." },
                    ]).map((tier) => (
                      <label
                        key={tier.value}
                        className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                          assignPolicyTier === tier.value
                            ? "border-blue-500 bg-blue-50"
                            : "border-border hover:bg-gray-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="policy-tier"
                          value={tier.value}
                          checked={assignPolicyTier === tier.value}
                          onChange={() => setAssignPolicyTier(tier.value)}
                          className="mt-0.5"
                        />
                        <div>
                          <span className="text-sm font-medium text-foreground">{tier.label}</span>
                          <p className="text-xs text-muted">{tier.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={clearAssignDialog}
                disabled={assignLoading}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                Skip
              </button>
              {assignAgents.length > 0 && (
                <button
                  onClick={handleAssignPolicy}
                  disabled={assignLoading || !assignAgentId}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {assignLoading ? "Creating..." : "Assign to Agent"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
