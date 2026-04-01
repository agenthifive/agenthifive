"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";
import { REQUESTS_CHANGED_EVENT } from "@/lib/events";
import { SERVICE_CATALOG, type ServiceId } from "@agenthifive/contracts";
import {
  ACTION_TEMPLATES,
  type ActionTemplate,
  type PendingPermissionRequest,
} from "@/lib/mock-data";
import { toast } from "sonner";
import PolicyWizard from "../my-agents/policy-wizard";
import { HelpTooltip } from "@/components/help-tooltip";

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

interface EmailMetadata {
  to: string[];
  cc: string[];
  from: string;
  subject: string;
  bodyPreview: string;
}

interface TelegramMetadata {
  chatId: string;
  text?: string;
  parseMode?: string;
}

interface TeamsMetadata {
  chatId?: string;
  channelId?: string;
  teamId?: string;
  contentType?: string;
  bodyPreview?: string;
}

interface SlackMetadata {
  channel: string;
  text?: string;
}

interface AttachmentMetadata {
  messageSubject: string;
  messageSender: string;
  attachmentName?: string;
  attachmentSize?: number;
}

interface EmailActionMetadata {
  messageId: string;
  messageSubject: string;
  messageSender: string;
  snippet?: string;
}


interface GuardTriggerMatch {
  patternType: string;
  field: string;
  excerpt: string;
}

interface GuardTrigger {
  type: "prompt_injection" | "pii_bypass";
  ruleLabel: string;
  matches: GuardTriggerMatch[];
}

interface ApprovalRequest {
  id: string;
  policyId: string;
  agentId: string;
  connectionId: string;
  actor: string;
  status: "pending" | "approved" | "denied" | "expired";
  requestDetails: {
    method: string;
    url: string;
    emailMetadata?: EmailMetadata;
    telegramMetadata?: TelegramMetadata;
    teamsMetadata?: TeamsMetadata;
    slackMetadata?: SlackMetadata;
    attachmentMetadata?: AttachmentMetadata;
    emailActionMetadata?: EmailActionMetadata;
    guardTrigger?: GuardTrigger;
    actionSummary?: string;
    contactDisplayName?: string;
    // Rate limit override fields (stored flat at root)
    type?: string;
    limit?: number;
    currentCount?: number;
    modelName?: string;
  };
  reason: string | null;
  expiresAt: string;
  createdAt: string;
  agentName: string;
  connectionLabel: string;
  connectionProvider: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "bg-yellow-100 text-yellow-800" },
  approved: { label: "Approved", color: "bg-green-100 text-green-800" },
  denied: { label: "Denied", color: "bg-red-100 text-red-800" },
  expired: { label: "Expired", color: "bg-gray-100 text-gray-500" },
};

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-100 text-blue-700",
  POST: "bg-green-100 text-green-700",
  PUT: "bg-orange-100 text-orange-700",
  PATCH: "bg-purple-100 text-purple-700",
  DELETE: "bg-red-100 text-red-700",
};

const PROVIDER_ICONS: Record<string, string> = {
  google: "G",
  microsoft: "M",
  telegram: "T",
  slack: "S",
  notion: "N",
  trello: "T",
  jira: "J",
  anthropic: "A",
  openai: "AI",
  gemini: "G",
  openrouter: "OR",
};

function describeAction(method: string, url: string): string {
  const u = url.toLowerCase();

  // ── Gmail ──
  if (u.includes("gmail.googleapis.com")) {
    if (u.includes("/messages/send")) return "Send email via Gmail";
    if (u.includes("/drafts") && method === "POST") return "Create draft via Gmail";
    if (u.includes("/drafts") && method === "DELETE") return "Delete draft via Gmail";
    if (u.includes("/messages") && method === "DELETE") return "Delete email via Gmail";
    if (u.includes("/attachments") && method === "GET") return "Download attachment via Gmail";
    if (u.includes("/messages") && method === "GET") return "Read emails via Gmail";
    if (u.includes("/threads") && method === "GET") return "Read email threads via Gmail";
    if (u.includes("/labels") && method === "POST") return "Create Gmail label";
    return `${method} Gmail API`;
  }

  // ── Google Calendar ──
  if (u.includes("calendar") && u.includes("googleapis.com")) {
    if (u.includes("/events") && method === "POST") return "Create calendar event";
    if (u.includes("/events") && method === "GET") return "Read calendar events";
    if (u.includes("/events") && method === "PATCH") return "Update calendar event";
    if (u.includes("/events") && method === "PUT") return "Update calendar event";
    if (u.includes("/events") && method === "DELETE") return "Delete calendar event";
    return `${method} Google Calendar API`;
  }

  // ── Google Drive ──
  if (u.includes("drive") && u.includes("googleapis.com")) {
    if (u.includes("/permissions") && method === "POST") return "Share Drive file";
    if (u.includes("/upload/") && method === "POST") return "Upload file to Drive";
    if (u.includes("/files") && method === "GET") return "Read Drive files";
    if (u.includes("/files") && method === "POST") return "Create Drive file";
    if (u.includes("/files") && method === "PATCH") return "Update Drive file";
    if (u.includes("/files") && method === "DELETE") return "Delete Drive file";
    return `${method} Google Drive API`;
  }

  // ── Google Docs ──
  if (u.includes("docs.googleapis.com")) {
    if (method === "POST" && u.includes("/documents")) return "Create Google Doc";
    if (method === "GET") return "Read Google Doc";
    if (method === "POST" && u.includes(":batchupdate")) return "Update Google Doc";
    return `${method} Google Docs API`;
  }

  // ── Google Sheets ──
  if (u.includes("sheets.googleapis.com")) {
    if (method === "POST" && u.includes("/spreadsheets")) return "Create Google Sheet";
    if (method === "GET") return "Read Google Sheet";
    if (method === "PUT" || method === "POST") return "Update Google Sheet";
    return `${method} Google Sheets API`;
  }

  // ── Google Contacts (People API) ──
  if (u.includes("people.googleapis.com")) {
    if (u.includes(":updatecontact") || method === "PATCH") return "Update Google Contact";
    if (u.includes(":createcontact") || method === "POST") return "Create Google Contact";
    if (u.includes(":deletecontact") || method === "DELETE") return "Delete Google Contact";
    if (method === "GET") return "Read Google Contacts";
    return `${method} Google Contacts API`;
  }

  // ── Microsoft Graph (must disambiguate Outlook Mail vs Calendar vs Contacts vs Teams vs OneDrive) ──
  if (u.includes("graph.microsoft.com")) {
    // Outlook Mail
    if (u.includes("/sendmail")) return "Send email via Outlook";
    if (u.includes("/me/messages") || u.includes("/me/mailfolders")) {
      if (u.includes("/attachments") && method === "GET") return "Download attachment via Outlook";
      if (method === "POST") return "Send email via Outlook";
      if (method === "DELETE") return "Delete email via Outlook";
      if (method === "PATCH") return "Update email via Outlook";
      return "Read emails via Outlook";
    }

    // Outlook Calendar
    if (u.includes("/events") || u.includes("/calendar")) {
      if (method === "POST") return "Create Outlook calendar event";
      if (method === "DELETE") return "Delete Outlook calendar event";
      if (method === "PATCH") return "Update Outlook calendar event";
      return "Read Outlook calendar events";
    }

    // Outlook Contacts
    if (u.includes("/contacts")) {
      if (method === "POST") return "Create Outlook contact";
      if (method === "DELETE") return "Delete Outlook contact";
      if (method === "PATCH") return "Update Outlook contact";
      return "Read Outlook contacts";
    }

    // OneDrive
    if (u.includes("/drive")) {
      if (u.includes("/permissions") && method === "POST") return "Share OneDrive file";
      if (method === "PUT" || (method === "POST" && u.includes("/upload"))) return "Upload to OneDrive";
      if (method === "DELETE") return "Delete OneDrive file";
      if (method === "PATCH") return "Update OneDrive file";
      return "Read OneDrive files";
    }

    // Teams — chats and channel messages
    if (u.includes("/chats") || u.includes("/teams")) {
      if (u.includes("/messages") && method === "POST") return "Send Teams message";
      if (u.includes("/messages") && method === "GET") return "Read Teams messages";
      if (u.includes("/chats") && method === "GET") return "Read Teams chats";
      return `${method} Teams API`;
    }

    return `${method} Microsoft Graph API`;
  }

  // ── Telegram Bot API ──
  if (u.includes("api.telegram.org")) {
    if (u.includes("/sendmessage")) return "Send Telegram message";
    if (u.includes("/editmessagetext")) return "Edit Telegram message";
    if (u.includes("/deletemessage")) return "Delete Telegram message";
    if (u.includes("/sendphoto")) return "Send Telegram photo";
    if (u.includes("/senddocument")) return "Send Telegram document";
    if (u.includes("/getupdates")) return "Get Telegram updates";
    return `${method} Telegram Bot API`;
  }

  // ── Slack API ──
  if (u.includes("slack.com/api")) {
    if (u.includes("chat.postmessage")) return "Send Slack message";
    if (u.includes("chat.update")) return "Update Slack message";
    if (u.includes("chat.delete")) return "Delete Slack message";
    if (u.includes("files.upload")) return "Upload Slack file";
    if (u.includes("reactions.add")) return "Add Slack reaction";
    if (u.includes("conversations.history")) return "Read Slack messages";
    if (u.includes("conversations.list")) return "List Slack channels";
    return `${method} Slack API`;
  }

  // ── Notion API ──
  if (u.includes("api.notion.com")) {
    if (u.includes("/pages") && method === "POST") return "Create Notion page";
    if (u.includes("/pages") && method === "PATCH") return "Update Notion page";
    if (u.includes("/databases") && method === "POST") return "Query Notion database";
    if (u.includes("/blocks")) return `${method === "DELETE" ? "Delete" : method === "PATCH" ? "Update" : "Read"} Notion block`;
    if (u.includes("/search")) return "Search Notion";
    return `${method} Notion API`;
  }

  // ── Trello API ──
  if (u.includes("api.trello.com")) {
    if (u.includes("/cards") && method === "POST") return "Create Trello card";
    if (u.includes("/cards") && method === "PUT") return "Update Trello card";
    if (u.includes("/cards") && method === "DELETE") return "Delete Trello card";
    if (u.includes("/lists")) return `${method === "POST" ? "Create" : "Read"} Trello list`;
    return `${method} Trello API`;
  }

  // ── Jira API ──
  if (u.includes("atlassian.net") || (u.includes("jira") && u.includes("/rest/api"))) {
    if (u.includes("/issue") && method === "POST") return "Create Jira issue";
    if (u.includes("/issue") && method === "PUT") return "Update Jira issue";
    if (u.includes("/issue") && method === "DELETE") return "Delete Jira issue";
    if (u.includes("/comment") && method === "POST") return "Add Jira comment";
    if (u.includes("/search")) return "Search Jira issues";
    return `${method} Jira API`;
  }

  // ── LLM APIs ──
  if (u.includes("api.anthropic.com") || u.includes("/v1/messages")) {
    return "Anthropic Claude API";
  }
  if (u.includes("api.openai.com") || (u.includes("/v1/chat/completions") && !u.includes("openrouter"))) {
    return "OpenAI Chat API";
  }
  if (u.includes("generativelanguage.googleapis.com") || u.includes(":generatecontent")) {
    return "Google Gemini API";
  }
  if (u.includes("openrouter.ai")) {
    return "OpenRouter API";
  }

  // Generic fallback
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.hostname}${parsed.pathname}`;
  } catch {
    return `${method} ${url}`;
  }
}

const GUARD_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  prompt_injection: { label: "Prompt Injection Detected", color: "bg-red-50 border-red-200 text-red-800" },
  pii_bypass: { label: "Personal Information Detected", color: "bg-amber-50 border-amber-200 text-amber-800" },
};

function GuardTriggerCard({ trigger }: { trigger: GuardTrigger }) {
  const config = GUARD_TYPE_CONFIG[trigger.type] ?? { label: trigger.type, color: "bg-gray-50 border-gray-200 text-gray-800" };
  return (
    <div className={`mb-2 rounded-md border p-2 text-xs ${config.color}`}>
      <div className="font-semibold mb-1">{config.label}</div>
      <div className="text-xs opacity-80 mb-1">Rule: {trigger.ruleLabel}</div>
      {trigger.matches.map((m, i) => (
        <div key={i} className="mt-1 rounded bg-white/50 px-2 py-1 font-mono text-[11px]">
          <span className="font-medium">{m.patternType}</span> in <span className="italic">{m.field}</span>
          {m.excerpt && (
            <div className="mt-0.5 text-muted truncate" title={m.excerpt}>
              &ldquo;{m.excerpt}&rdquo;
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function expiresIn(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface Agent {
  id: string;
  name: string;
}

export default function ApprovalsPage() {
  const { data: session } = useSession();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Agents state
  const [agents, setAgents] = useState<Agent[]>([]);

  // Agent permission requests state
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [permissionRequestLoading, setPermissionRequestLoading] = useState(false);

  // Notification banner state
  const [showNotifBanner, setShowNotifBanner] = useState(false);

  // Approval modal state
  const [approvingRequest, setApprovingRequest] = useState<PendingPermissionRequest | null>(null);
  const [approvalStep, setApprovalStep] = useState<"credentials" | "policy">("credentials");
  const [approvalConnectionId, setApprovalConnectionId] = useState<string | null>(null);
  const [approvalServiceId, setApprovalServiceId] = useState<ServiceId | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalPolicyCreated, setApprovalPolicyCreated] = useState(false);
  // Bot token credential form (Telegram, Slack, etc.)
  const [approvalBotToken, setApprovalBotToken] = useState("");
  const [approvalBotLabel, setApprovalBotLabel] = useState("");
  // API key credential form (Anthropic, OpenAI, Gemini, Notion, Trello, etc.)
  const [approvalApiKey, setApprovalApiKey] = useState("");
  const [approvalApiKeyLabel, setApprovalApiKeyLabel] = useState("");
  const [approvalAppKey, setApprovalAppKey] = useState("");
  // Jira requires site URL and email in addition to API token
  const [approvalSiteUrl, setApprovalSiteUrl] = useState("");
  const [approvalEmail, setApprovalEmail] = useState("");

  const fetchAgentsAndSetupRequests = useCallback(async () => {
    try {
      // Fetch agents
      const agentsRes = await apiFetch("/agents");
      if (!agentsRes.ok) {
        throw new Error("Failed to fetch agents");
      }
      const agentsData = (await agentsRes.json()) as { agents: Agent[] };
      setAgents(agentsData.agents);

      // Fetch permission requests from database
      const requestsRes = await apiFetch("/agent-permission-requests");
      if (!requestsRes.ok) {
        throw new Error("Failed to fetch permission requests");
      }
      const requestsData = (await requestsRes.json()) as { requests: PendingPermissionRequest[] };
      setPendingPermissionRequests(requestsData.requests);
    } catch (err) {
      toast.error("Failed to load permission requests");
      setPendingPermissionRequests([]);
    }
  }, []);

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await apiFetch("/approvals");
      if (!res.ok) {
        throw new Error("Failed to fetch approvals");
      }
      const data = (await res.json()) as { approvals: ApprovalRequest[] };
      setApprovals(data.approvals);
      // Don't clear error here — polling would swallow user-facing action errors.
      // Errors are cleared explicitly when the user dismisses them or starts a new action.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch approvals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    fetchAgentsAndSetupRequests();
    fetchApprovals();

    // Check if notification banner should be shown
    const dismissed = localStorage.getItem("ah5:notif-banner-dismissed");
    if (!dismissed) {
      apiFetch("/notification-channels")
        .then(async (res) => {
          if (res.ok) {
            const data = (await res.json()) as { channels: unknown[] };
            if (data.channels.length === 0) setShowNotifBanner(true);
          }
        })
        .catch(() => { /* notification banner check is non-critical */ });
    }

    // Poll every 5 seconds for new approvals
    const interval = setInterval(fetchApprovals, 5000);
    return () => clearInterval(interval);
  }, [session, fetchApprovals, fetchAgentsAndSetupRequests]);

  // Update "expires in" display every second
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // Listen for OAuth popup completion messages
  useEffect(() => {
    function onPopupMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;

      if (event.data?.type === "connection-oauth-complete") {
        const { policyId, connectionId } = event.data;

        // If we're in the approval flow (no policyTier sent), show PolicyWizard
        if (approvingRequest && connectionId && !policyId) {
          setApprovalConnectionId(connectionId);
          setApprovalStep("policy");
          return;
        }

        // Legacy flow: policy was auto-created
        fetchAgentsAndSetupRequests();
        if (policyId) {
          window.location.href = `/dashboard/policies?highlight=${policyId}`;
        }
      } else if (event.data?.type === "connection-oauth-error") {
        toast.error("Connection failed", {
          description: event.data.error ?? "OAuth connection failed",
          duration: 8000,
        });
      }
    }

    window.addEventListener("message", onPopupMessage);
    return () => window.removeEventListener("message", onPopupMessage);
  }, [fetchAgentsAndSetupRequests, approvingRequest]);

  async function handleApprove(id: string) {
    setActionLoading(id);
    setSuccessMessage(null);
    try {
      const res = await apiFetch(`/approvals/${id}/approve`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        setError(data.error);
        return;
      }
      const data = (await res.json()) as { auditId: string };
      setApprovals((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "approved" as const } : a)),
      );
      window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED_EVENT));
      setSuccessMessage(`Approved and executed. Audit ID: ${data.auditId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDeny(id: string) {
    setActionLoading(id);
    setSuccessMessage(null);
    try {
      const res = await apiFetch(`/approvals/${id}/deny`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        setError(data.error);
        return;
      }
      setApprovals((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "denied" as const } : a)),
      );
      window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED_EVENT));
      setSuccessMessage("Request denied.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deny");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApprovePermissionRequest(request: PendingPermissionRequest) {
    const action = ACTION_TEMPLATES.find((a) => a.id === request.actionTemplateId);
    if (!action) return;

    const serviceConfig = SERVICE_CATALOG[action.serviceId];
    const credType = serviceConfig.credentialType;

    // Store the request being approved
    setApprovingRequest(request);
    setApprovalServiceId(action.serviceId);
    setApprovalError(null);
    setApprovalPolicyCreated(false);

    if (credType !== "oauth") {
      // Non-OAuth (bot_token, api_key): show credential form in modal
      setApprovalStep("credentials");
      return;
    }

    // OAuth: call approve endpoint to get auth URL, then open popup
    setPermissionRequestLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`/agent-permission-requests/${request.id}/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as {
        credentialType?: string;
        pendingConnectionId?: string;
        authorizationUrl?: string;
        service?: string;
      };

      const popup = openCenteredPopup(data.authorizationUrl!, "oauth-connection");
      if (!popup) {
        window.location.href = data.authorizationUrl!;
        return;
      }

      // Stay on page — popup listener will set approvalConnectionId when done
      setApprovalStep("credentials"); // Shows "Waiting for OAuth..." message
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve request");
      setApprovingRequest(null);
    } finally {
      setPermissionRequestLoading(false);
    }
  }

  // Telegram credential submission in approval modal
  async function handleApprovalBotTokenValidate() {
    if (!approvalBotToken.trim() || !approvalServiceId) return;

    setApprovalLoading(true);
    setApprovalError(null);

    try {
      const res = await apiFetch("/connections/bot-token", {
        method: "POST",
        body: JSON.stringify({
          service: approvalServiceId,
          botToken: approvalBotToken.trim(),
          label: approvalBotLabel || undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { connection: { id: string } };
      setApprovalConnectionId(data.connection.id);
      setApprovalStep("policy");
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : "Failed to validate bot token");
    } finally {
      setApprovalLoading(false);
    }
  }

  // API key credential submission in approval modal (Anthropic, OpenAI, Notion, Trello, etc.)
  async function handleApprovalApiKeySubmit() {
    if (!approvalApiKey.trim() || !approvalServiceId) return;

    const svcEntry = SERVICE_CATALOG[approvalServiceId];

    // Trello requires both fields
    if (svcEntry.provider === "trello" && !approvalAppKey.trim()) {
      setApprovalError("Both the Power-Up API Key and User Token are required for Trello.");
      return;
    }

    // Jira requires site URL, email, and API token
    if (svcEntry.provider === "jira" && (!approvalAppKey.trim() || !approvalEmail.trim())) {
      setApprovalError("Site URL, email address, and API token are all required for Jira.");
      return;
    }

    setApprovalLoading(true);
    setApprovalError(null);

    try {
      const payload: Record<string, string> = {
        provider: svcEntry.provider,
        service: approvalServiceId,
        apiKey: approvalApiKey.trim(),
        label: approvalApiKeyLabel.trim() || svcEntry.displayName,
      };
      if (svcEntry.provider === "trello") {
        payload.appKey = approvalAppKey.trim();
      }
      if (svcEntry.provider === "jira") {
        payload.siteUrl = approvalAppKey.trim();
        payload.email = approvalEmail.trim();
      }

      const res = await apiFetch("/connections/api-key", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { connection: { id: string } };
      setApprovalConnectionId(data.connection.id);
      setApprovalStep("policy");
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : "Failed to create connection");
    } finally {
      setApprovalLoading(false);
    }
  }

  // Policy created via PolicyWizard in approval modal
  async function handleApprovalPolicyCreated() {
    setApprovalPolicyCreated(true);

    // Mark permission request as approved
    if (approvingRequest && approvalConnectionId) {
      try {
        await apiFetch(`/agent-permission-requests/${approvingRequest.id}/approve-complete`, {
          method: "PATCH",
          body: JSON.stringify({ connectionId: approvalConnectionId }),
        });
      } catch {
        toast.error("Failed to update approval status", { description: "The policy was created but the permission request was not marked as approved." });
      }
    }

    // Remove from list and close modal
    if (approvingRequest) {
      setPendingPermissionRequests((prev) => prev.filter((r) => r.id !== approvingRequest.id));
    }
    window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED_EVENT));
    resetApprovalModal();
    fetchAgentsAndSetupRequests();
    setSuccessMessage("Connection created and policy applied.");
  }

  // Close/cancel approval modal — delete orphaned connection if needed
  async function handleApprovalClose() {
    if (approvalConnectionId && !approvalPolicyCreated) {
      try {
        await apiFetch(`/connections/${approvalConnectionId}`, { method: "DELETE" });
      } catch {
        toast.error("Failed to clean up connection", { description: "An unused connection may remain. You can revoke it from the connections page." });
      }
    }
    resetApprovalModal();
  }

  function resetApprovalModal() {
    setApprovingRequest(null);
    setApprovalStep("credentials");
    setApprovalConnectionId(null);
    setApprovalServiceId(null);
    setApprovalLoading(false);
    setApprovalError(null);
    setApprovalPolicyCreated(false);
    setApprovalBotToken("");
    setApprovalBotLabel("");
    setApprovalApiKey("");
    setApprovalApiKeyLabel("");
    setApprovalAppKey("");
    setApprovalSiteUrl("");
    setApprovalEmail("");
  }

  async function handleDenyPermissionRequest(requestId: string) {
    try {
      // Delete the permission request from the database
      const res = await apiFetch(`/agent-permission-requests/${requestId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        setError(data.error);
        return;
      }

      // Remove from UI
      setPendingPermissionRequests((prev) => prev.filter((r) => r.id !== requestId));
      window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deny request");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted">Loading approvals...</div>
      </div>
    );
  }

  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const resolvedApprovals = approvals.filter((a) => a.status !== "pending");

  // Group permission requests by agent
  const groupedPermissionRequests = pendingPermissionRequests.reduce((acc, request) => {
    const agentName = request.agentName;
    if (!acc[agentName]) {
      acc[agentName] = [];
    }
    acc[agentName].push(request);
    return acc;
  }, {} as Record<string, PendingPermissionRequest[]>);

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-foreground">Agent Data Access Requests</h1>
          {pendingPermissionRequests.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
              {pendingPermissionRequests.length}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">
          Review and approve data access requested by AI agents.
        </p>
      </div>

      {/* Discovery banner — shown when no notification channels are configured */}
      {showNotifBanner && (
        <div className="mb-6 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <p className="text-sm text-blue-800">
            Get notified on Telegram or Slack when agents need approval.{" "}
            <a href="/dashboard/settings/notifications" className="font-medium underline hover:text-blue-900">
              Configure in Settings
            </a>
          </p>
          <button
            onClick={() => {
              setShowNotifBanner(false);
              localStorage.setItem("ah5:notif-banner-dismissed", "1");
            }}
            className="ml-4 text-blue-400 hover:text-blue-600"
            aria-label="Dismiss"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 font-medium underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {successMessage && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {successMessage}
          <button
            onClick={() => setSuccessMessage(null)}
            className="ml-2 font-medium underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Agent Data Access Requests (Grouped by Agent) */}
      {pendingPermissionRequests.length > 0 && (
        <div className="mb-8">
          {Object.entries(groupedPermissionRequests).map(([agentName, requests]) => (
            <div key={agentName} className="mb-6 last:mb-0">
              {/* Agent Header */}
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 text-2xl">
                  🤖
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-bold text-foreground">{agentName}</h2>
                  <p className="text-sm text-muted">
                    {requests.length} data access {requests.length === 1 ? "request" : "requests"}
                  </p>
                </div>
              </div>

              {/* Agent's Requests */}
              <div className="ml-15 space-y-3">
                {requests.map((request) => {
                  const action = ACTION_TEMPLATES.find((a) => a.id === request.actionTemplateId);
                  if (!action) return null;

                  const serviceConfig = SERVICE_CATALOG[action.serviceId];

                  return (
                    <div
                      key={request.id}
                      className="rounded-lg border-2 border-blue-200 bg-blue-50 p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3 flex-1">
                          <div className="flex-1 min-w-0">
                            <div className="mb-2">
                              <div className="inline-flex items-center gap-2 rounded-md bg-white px-3 py-1.5 border border-blue-200">
                                <span className="text-lg">{serviceConfig.icon}</span>
                                <span className="text-sm font-medium text-foreground">
                                  {action.label}
                                </span>
                              </div>
                              <p className="text-xs text-muted mt-1">{action.description}</p>
                            </div>
                            <p className="text-sm text-muted italic">
                              &quot;{request.reason}&quot;
                            </p>
                            <p className="mt-2 text-xs text-muted">
                              Requested {new Date(request.requestedAt).toLocaleString()}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => handleApprovePermissionRequest(request)}
                            disabled={permissionRequestLoading}
                            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                          >
                            {permissionRequestLoading ? "Connecting..." : "Approve"}
                          </button>
                          <button
                            onClick={() => handleDenyPermissionRequest(request.id)}
                            disabled={permissionRequestLoading}
                            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-50 disabled:opacity-50"
                          >
                            Deny
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pending step-up approvals */}
      {pendingApprovals.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-lg font-semibold text-foreground">
              Pending Approvals
            </h2>
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
              {pendingApprovals.length}
            </span>
          </div>
          <div className="space-y-3">
            {pendingApprovals.map((approval) => {
              const methodColor = METHOD_COLORS[approval.requestDetails.method] ?? "bg-gray-100 text-gray-700";
              const isLoading = actionLoading === approval.id;

              return (
                <div
                  key={approval.id}
                  className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-200 text-xs font-bold text-amber-700">
                          {PROVIDER_ICONS[approval.connectionProvider] ?? "?"}
                        </span>
                        <span className="font-medium text-foreground text-sm">{approval.agentName}</span>
                        <span className="text-muted text-xs">via</span>
                        <span className="text-xs text-foreground">{approval.connectionLabel}</span>
                      </div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${methodColor}`}>
                          {approval.requestDetails.method}
                        </span>
                        <span className="text-sm text-foreground">
                          {describeAction(approval.requestDetails.method, approval.requestDetails.url)}
                        </span>
                      </div>
                      {approval.reason && (
                        <div className="mb-1 flex items-center gap-1.5 text-xs text-amber-700">
                          <span className="font-medium">Reason:</span> {approval.reason}
                        </div>
                      )}
                      {approval.requestDetails.emailMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">To:</span>{" "}
                          {approval.requestDetails.emailMetadata.to.join(", ") || "(unknown)"}{" "}
                          &middot; <span className="font-medium">Subject:</span>{" "}
                          {approval.requestDetails.emailMetadata.subject}
                        </div>
                      )}
                      {approval.requestDetails.telegramMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">Chat:</span>{" "}
                          {approval.requestDetails.telegramMetadata.chatId}
                          {approval.requestDetails.telegramMetadata.text && (
                            <>
                              {" "}&middot; <span className="font-medium">Message:</span>{" "}
                              {approval.requestDetails.telegramMetadata.text.length > 80
                                ? approval.requestDetails.telegramMetadata.text.slice(0, 80) + "..."
                                : approval.requestDetails.telegramMetadata.text}
                            </>
                          )}
                        </div>
                      )}
                      {approval.requestDetails.teamsMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          {approval.requestDetails.teamsMetadata.chatId && (
                            <>
                              <span className="font-medium">Chat:</span>{" "}
                              {approval.requestDetails.teamsMetadata.chatId}
                            </>
                          )}
                          {approval.requestDetails.teamsMetadata.channelId && (
                            <>
                              <span className="font-medium">Channel:</span>{" "}
                              {approval.requestDetails.teamsMetadata.channelId}
                            </>
                          )}
                          {approval.requestDetails.teamsMetadata.bodyPreview && (
                            <>
                              {" "}&middot; <span className="font-medium">Message:</span>{" "}
                              {approval.requestDetails.teamsMetadata.bodyPreview.length > 80
                                ? approval.requestDetails.teamsMetadata.bodyPreview.slice(0, 80) + "..."
                                : approval.requestDetails.teamsMetadata.bodyPreview}
                            </>
                          )}
                        </div>
                      )}
                      {approval.requestDetails.slackMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">Channel:</span>{" "}
                          {approval.requestDetails.slackMetadata.channel}
                          {approval.requestDetails.slackMetadata.text && (
                            <>
                              {" "}&middot; <span className="font-medium">Message:</span>{" "}
                              {approval.requestDetails.slackMetadata.text.length > 80
                                ? approval.requestDetails.slackMetadata.text.slice(0, 80) + "..."
                                : approval.requestDetails.slackMetadata.text}
                            </>
                          )}
                        </div>
                      )}
                      {approval.requestDetails.attachmentMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          {approval.requestDetails.attachmentMetadata.attachmentName && (
                            <>
                              <span className="font-medium">File:</span>{" "}
                              {approval.requestDetails.attachmentMetadata.attachmentName}
                              {approval.requestDetails.attachmentMetadata.attachmentSize != null && (
                                <> ({formatFileSize(approval.requestDetails.attachmentMetadata.attachmentSize)})</>
                              )}
                              {" "}&middot;{" "}
                            </>
                          )}
                          <span className="font-medium">From:</span>{" "}
                          {approval.requestDetails.attachmentMetadata.messageSender}
                          {" "}&middot; <span className="font-medium">Subject:</span>{" "}
                          {approval.requestDetails.attachmentMetadata.messageSubject}
                        </div>
                      )}
                      {approval.requestDetails.emailActionMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">From:</span>{" "}
                          {approval.requestDetails.emailActionMetadata.messageSender}
                          {" "}&middot; <span className="font-medium">Subject:</span>{" "}
                          {approval.requestDetails.emailActionMetadata.messageSubject}
                          {" "}&middot; <span className="font-medium">ID:</span>{" "}
                          <span className="font-mono">{approval.requestDetails.emailActionMetadata.messageId}</span>
                          {approval.requestDetails.emailActionMetadata.snippet && (
                            <>
                              {" "}&middot; <span className="font-medium">Snippet:</span>{" "}
                              {approval.requestDetails.emailActionMetadata.snippet.length > 80
                                ? approval.requestDetails.emailActionMetadata.snippet.slice(0, 80) + "..."
                                : approval.requestDetails.emailActionMetadata.snippet}
                            </>
                          )}
                        </div>
                      )}
                      {(approval.requestDetails.actionSummary || approval.requestDetails.contactDisplayName) && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">{approval.requestDetails.contactDisplayName ? "Contact" : "Action"}:</span>{" "}
                          {approval.requestDetails.contactDisplayName ?? approval.requestDetails.actionSummary}
                        </div>
                      )}
                      {approval.requestDetails.type === "rate_limit_override" && (
                        <div className="mb-1 rounded-md border border-orange-200 bg-orange-50 p-2 text-xs text-orange-800">
                          <span className="font-semibold">Rate Limit Budget Override</span>
                          {approval.requestDetails.currentCount != null && approval.requestDetails.limit != null && (
                            <> &mdash; {approval.requestDetails.currentCount}/{approval.requestDetails.limit} requests/hour used</>
                          )}
                          {approval.requestDetails.modelName && (
                            <> &middot; <span className="font-medium">Model:</span> {approval.requestDetails.modelName}</>
                          )}
                        </div>
                      )}
                      {approval.requestDetails.guardTrigger && (
                        <GuardTriggerCard trigger={approval.requestDetails.guardTrigger} />
                      )}
                      <div className="flex items-center gap-3 text-xs text-muted mt-1">
                        <span>{timeAgo(approval.createdAt)}</span>
                        <span className="text-amber-600 font-medium">
                          Expires in {expiresIn(approval.expiresAt)}
                        </span>
                        <span className="font-mono text-muted" title={approval.id}>
                          {approval.id.slice(0, 8)}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => handleApprove(approval.id)}
                        disabled={isLoading}
                        className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                      >
                        {isLoading ? "..." : "Approve"}
                      </button>
                      <button
                        onClick={() => handleDeny(approval.id)}
                        disabled={isLoading}
                        className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-50 disabled:opacity-50"
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Resolved approvals section */}
      {resolvedApprovals.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-foreground">
            History ({resolvedApprovals.length})
          </h2>
          <div className="space-y-3">
            {resolvedApprovals.map((approval) => {
              const statusCfg = STATUS_CONFIG[approval.status];
              const methodColor = METHOD_COLORS[approval.requestDetails.method] ?? "bg-gray-100 text-gray-700";

              return (
                <div
                  key={approval.id}
                  className="rounded-lg border border-border bg-card p-4 opacity-75"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-600">
                          {PROVIDER_ICONS[approval.connectionProvider] ?? "?"}
                        </span>
                        <span className="font-medium text-foreground text-sm">{approval.agentName}</span>
                        <span className="text-muted text-xs">via</span>
                        <span className="text-xs text-foreground">
                          {approval.connectionLabel}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${methodColor}`}>
                          {approval.requestDetails.method}
                        </span>
                        <span className="text-xs text-muted">
                          {describeAction(approval.requestDetails.method, approval.requestDetails.url)}
                        </span>
                      </div>
                      {approval.reason && (
                        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                          <span className="font-medium">Reason:</span> {approval.reason}
                        </div>
                      )}
                      {approval.requestDetails.emailMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">To:</span>{" "}
                          {approval.requestDetails.emailMetadata.to.join(", ") || "(unknown)"}{" "}
                          &middot; <span className="font-medium">Subject:</span>{" "}
                          {approval.requestDetails.emailMetadata.subject}
                        </div>
                      )}
                      {approval.requestDetails.telegramMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">Chat:</span>{" "}
                          {approval.requestDetails.telegramMetadata.chatId}
                          {approval.requestDetails.telegramMetadata.text && (
                            <>
                              {" "}&middot; <span className="font-medium">Message:</span>{" "}
                              {approval.requestDetails.telegramMetadata.text.length > 80
                                ? approval.requestDetails.telegramMetadata.text.slice(0, 80) + "..."
                                : approval.requestDetails.telegramMetadata.text}
                            </>
                          )}
                        </div>
                      )}
                      {approval.requestDetails.teamsMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          {approval.requestDetails.teamsMetadata.chatId && (
                            <>
                              <span className="font-medium">Chat:</span>{" "}
                              {approval.requestDetails.teamsMetadata.chatId}
                            </>
                          )}
                          {approval.requestDetails.teamsMetadata.channelId && (
                            <>
                              <span className="font-medium">Channel:</span>{" "}
                              {approval.requestDetails.teamsMetadata.channelId}
                            </>
                          )}
                          {approval.requestDetails.teamsMetadata.bodyPreview && (
                            <>
                              {" "}&middot; <span className="font-medium">Message:</span>{" "}
                              {approval.requestDetails.teamsMetadata.bodyPreview.length > 80
                                ? approval.requestDetails.teamsMetadata.bodyPreview.slice(0, 80) + "..."
                                : approval.requestDetails.teamsMetadata.bodyPreview}
                            </>
                          )}
                        </div>
                      )}
                      {approval.requestDetails.slackMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">Channel:</span>{" "}
                          {approval.requestDetails.slackMetadata.channel}
                          {approval.requestDetails.slackMetadata.text && (
                            <>
                              {" "}&middot; <span className="font-medium">Message:</span>{" "}
                              {approval.requestDetails.slackMetadata.text.length > 80
                                ? approval.requestDetails.slackMetadata.text.slice(0, 80) + "..."
                                : approval.requestDetails.slackMetadata.text}
                            </>
                          )}
                        </div>
                      )}
                      {approval.requestDetails.attachmentMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          {approval.requestDetails.attachmentMetadata.attachmentName && (
                            <>
                              <span className="font-medium">File:</span>{" "}
                              {approval.requestDetails.attachmentMetadata.attachmentName}
                              {approval.requestDetails.attachmentMetadata.attachmentSize != null && (
                                <> ({formatFileSize(approval.requestDetails.attachmentMetadata.attachmentSize)})</>
                              )}
                              {" "}&middot;{" "}
                            </>
                          )}
                          <span className="font-medium">From:</span>{" "}
                          {approval.requestDetails.attachmentMetadata.messageSender}
                          {" "}&middot; <span className="font-medium">Subject:</span>{" "}
                          {approval.requestDetails.attachmentMetadata.messageSubject}
                        </div>
                      )}
                      {approval.requestDetails.emailActionMetadata && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">From:</span>{" "}
                          {approval.requestDetails.emailActionMetadata.messageSender}
                          {" "}&middot; <span className="font-medium">Subject:</span>{" "}
                          {approval.requestDetails.emailActionMetadata.messageSubject}
                          {" "}&middot; <span className="font-medium">ID:</span>{" "}
                          <span className="font-mono">{approval.requestDetails.emailActionMetadata.messageId}</span>
                          {approval.requestDetails.emailActionMetadata.snippet && (
                            <>
                              {" "}&middot; <span className="font-medium">Snippet:</span>{" "}
                              {approval.requestDetails.emailActionMetadata.snippet.length > 80
                                ? approval.requestDetails.emailActionMetadata.snippet.slice(0, 80) + "..."
                                : approval.requestDetails.emailActionMetadata.snippet}
                            </>
                          )}
                        </div>
                      )}
                      {(approval.requestDetails.actionSummary || approval.requestDetails.contactDisplayName) && (
                        <div className="mb-1 text-xs text-muted">
                          <span className="font-medium">{approval.requestDetails.contactDisplayName ? "Contact" : "Action"}:</span>{" "}
                          {approval.requestDetails.contactDisplayName ?? approval.requestDetails.actionSummary}
                        </div>
                      )}
                      {approval.requestDetails.type === "rate_limit_override" && (
                        <div className="mb-1 rounded-md border border-orange-200 bg-orange-50 p-2 text-xs text-orange-800">
                          <span className="font-semibold">Rate Limit Budget Override</span>
                          {approval.requestDetails.currentCount != null && approval.requestDetails.limit != null && (
                            <> &mdash; {approval.requestDetails.currentCount}/{approval.requestDetails.limit} requests/hour used</>
                          )}
                          {approval.requestDetails.modelName && (
                            <> &middot; <span className="font-medium">Model:</span> {approval.requestDetails.modelName}</>
                          )}
                        </div>
                      )}
                      {approval.requestDetails.guardTrigger && (
                        <GuardTriggerCard trigger={approval.requestDetails.guardTrigger} />
                      )}
                      <div className="flex items-center gap-3 text-xs text-muted">
                        <span>{timeAgo(approval.createdAt)}</span>
                        <span className="font-mono" title={approval.id}>
                          {approval.id.slice(0, 8)}
                        </span>
                      </div>
                    </div>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusCfg?.color ?? ""}`}>
                      {statusCfg?.label ?? approval.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Approval Modal (credentials + PolicyWizard) */}
      {approvingRequest && (() => {
        const action = ACTION_TEMPLATES.find((a) => a.id === approvingRequest.actionTemplateId);
        if (!action) return null;
        const svcConfig = SERVICE_CATALOG[action.serviceId];
        const credType = svcConfig.credentialType;

        return (
          <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
            onClick={handleApprovalClose}
          >
            <div
              className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto bg-white rounded-lg shadow-xl m-4"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
                <div className="min-w-0">
                  <h2 className="text-lg font-bold text-foreground">
                    {approvalStep === "policy" ? `Configure Policy \u2014 ${action.label}` : `Connect ${svcConfig.displayName}`}
                  </h2>
                  <p className="text-xs text-muted">
                    Agent: {approvingRequest.agentName} &middot; {svcConfig.displayName}
                  </p>
                </div>
                <button
                  onClick={handleApprovalClose}
                  className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                >
                  <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="px-6 py-5">
                {approvalError && (
                  <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3">
                    <p className="text-sm text-red-600">{approvalError}</p>
                    <button onClick={() => setApprovalError(null)} className="mt-1 text-xs text-red-500 underline">
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Credentials step */}
                {approvalStep === "credentials" && credType === "bot_token" && (() => {
                  const hints: Record<string, { description: string; placeholder: string; defaultLabel: string; helpText?: string; docsPath?: string }> = {
                    telegram: { description: "Enter the bot token from @BotFather to connect your Telegram bot.", placeholder: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ", defaultLabel: "Telegram Bot", helpText: "Create a bot with @BotFather on Telegram, then copy the token it gives you.", docsPath: "/connections/telegram" },
                    slack: { description: "Enter the Bot User OAuth Token from your Slack App settings.", placeholder: "xoxb-...", defaultLabel: "Slack Bot", helpText: "Go to api.slack.com/apps, select your app, then find the Bot User OAuth Token under OAuth & Permissions.", docsPath: "/connections/slack" },
                  };
                  const hint = hints[svcConfig.provider] ?? { description: `Enter the bot token for ${svcConfig.displayName}.`, placeholder: "bot-token-here", defaultLabel: svcConfig.displayName };
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
                        <label htmlFor="approval-bot-label" className="block text-sm font-medium text-foreground">
                          Connection Label
                        </label>
                        <input
                          id="approval-bot-label"
                          type="text"
                          value={approvalBotLabel || hint.defaultLabel}
                          onChange={(e) => setApprovalBotLabel(e.target.value)}
                          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          placeholder={`e.g., My ${svcConfig.displayName}`}
                        />
                      </div>
                      <div className="mb-4">
                        <label htmlFor="approval-bot-token" className="block text-sm font-medium text-foreground">
                          Bot Token
                        </label>
                        <input
                          id="approval-bot-token"
                          type="text"
                          value={approvalBotToken}
                          onChange={(e) => setApprovalBotToken(e.target.value)}
                          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          placeholder={hint.placeholder}
                        />
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={handleApprovalClose}
                          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleApprovalBotTokenValidate}
                          disabled={approvalLoading || !approvalBotToken.trim()}
                          className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {approvalLoading ? "Validating..." : "Validate & Connect"}
                        </button>
                      </div>
                    </div>
                  </div>
                  );
                })()}

                {/* API key credentials step (Anthropic, OpenAI, Gemini, Notion, Trello, etc.) */}
                {approvalStep === "credentials" && credType === "api_key" && (() => {
                  const apiKeyHints: Record<string, { description: string; placeholder: string; keyLabel: string; defaultLabel: string; helpText?: string; docsPath?: string; appKeyLabel?: string; appKeyPlaceholder?: string }> = {
                    anthropic: { description: "Enter your Anthropic API key or Claude Code setup token.", placeholder: "sk-ant-api...", keyLabel: "API Key or Setup Token", defaultLabel: "Anthropic", helpText: "Get an API key from console.anthropic.com, or run claude setup-token in Claude Code to use your Pro/Max subscription.", docsPath: "/connections/anthropic" },
                    openai: { description: "Enter your OpenAI API key.", placeholder: "sk-...", keyLabel: "API Key", defaultLabel: "OpenAI", helpText: "Get an API key from platform.openai.com under API Keys.", docsPath: "/connections/openai" },
                    gemini: { description: "Enter your Google AI API key.", placeholder: "AIza...", keyLabel: "API Key", defaultLabel: "Gemini", helpText: "Get an API key from aistudio.google.com/apikey.", docsPath: "/connections/gemini" },
                    openrouter: { description: "Enter your OpenRouter API key.", placeholder: "sk-or-v1-...", keyLabel: "API Key", defaultLabel: "OpenRouter", helpText: "Get an API key from openrouter.ai/settings/keys.", docsPath: "/connections/openrouter" },
                    notion: { description: "Enter your Notion internal integration token.", placeholder: "ntn_...", keyLabel: "Integration Token", defaultLabel: "Notion", helpText: "Create an integration at notion.so/profile/integrations, then share pages with it.", docsPath: "/connections/notion" },
                    trello: { description: "Enter your Trello Power-Up API key and user token.", placeholder: "ATTA...", keyLabel: "User Token", defaultLabel: "Trello", helpText: "Create a Power-Up at trello.com/power-ups/admin to get the API key, then generate a user token via the authorize URL.", docsPath: "/connections/trello", appKeyLabel: "Power-Up API Key", appKeyPlaceholder: "32-character API key from Power-Up settings" },
                    jira: { description: "Enter your Jira Cloud credentials.", placeholder: "ATATT3xFfGF0...", keyLabel: "API Token", defaultLabel: "Jira Cloud", helpText: "Create an API token at id.atlassian.com/manage/api-tokens.", docsPath: "/connections/jira", appKeyLabel: "Jira Site URL", appKeyPlaceholder: "mycompany.atlassian.net" },
                  };
                  const akHint = apiKeyHints[svcConfig.provider] ?? { description: `Enter your ${svcConfig.displayName} API key.`, placeholder: "api-key-here", keyLabel: "API Key", defaultLabel: svcConfig.displayName };
                  return (
                  <div className="max-w-xl mx-auto">
                    <div className="rounded-lg border border-border bg-card p-6">
                      <div className="flex items-start justify-between mb-4">
                        <p className="text-sm text-muted">
                          {akHint.description}
                        </p>
                        {(akHint.helpText || akHint.docsPath) && (
                          <HelpTooltip docsPath={akHint.docsPath}>{akHint.helpText ?? akHint.description}</HelpTooltip>
                        )}
                      </div>
                      <div className="mb-4">
                        <label htmlFor="approval-apikey-label" className="block text-sm font-medium text-foreground">
                          Connection Label
                        </label>
                        <input
                          id="approval-apikey-label"
                          type="text"
                          value={approvalApiKeyLabel || akHint.defaultLabel}
                          onChange={(e) => setApprovalApiKeyLabel(e.target.value)}
                          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          placeholder={`e.g., My ${svcConfig.displayName}`}
                        />
                      </div>
                      {akHint.appKeyLabel && (
                        <div className="mb-4">
                          <label htmlFor="approval-appkey" className="block text-sm font-medium text-foreground">
                            {akHint.appKeyLabel}
                          </label>
                          <input
                            id="approval-appkey"
                            type="text"
                            value={approvalAppKey}
                            onChange={(e) => setApprovalAppKey(e.target.value)}
                            className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            placeholder={akHint.appKeyPlaceholder ?? ""}
                          />
                        </div>
                      )}
                      {svcConfig.provider === "jira" && (
                        <div className="mb-4">
                          <label className="block text-sm font-medium text-foreground">
                            Email Address <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="email"
                            value={approvalEmail}
                            onChange={(e) => setApprovalEmail(e.target.value)}
                            placeholder="you@company.com"
                            className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                      )}
                      <div className="mb-4">
                        <label htmlFor="approval-apikey" className="block text-sm font-medium text-foreground">
                          {akHint.keyLabel}
                        </label>
                        <input
                          id="approval-apikey"
                          type="text"
                          value={approvalApiKey}
                          onChange={(e) => setApprovalApiKey(e.target.value)}
                          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-mono text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          placeholder={akHint.placeholder}
                        />
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={handleApprovalClose}
                          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleApprovalApiKeySubmit}
                          disabled={approvalLoading || !approvalApiKey.trim() || (!!akHint.appKeyLabel && !approvalAppKey.trim()) || (svcConfig.provider === "jira" && !approvalEmail.trim())}
                          className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {approvalLoading ? "Connecting..." : "Connect"}
                        </button>
                      </div>
                    </div>
                  </div>
                  );
                })()}

                {/* OAuth waiting message */}
                {approvalStep === "credentials" && credType === "oauth" && (
                  <div className="text-center py-8">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-3xl">
                      {svcConfig.icon}
                    </div>
                    <h3 className="text-lg font-semibold text-foreground">
                      Complete authorization
                    </h3>
                    <p className="mt-2 text-sm text-muted">
                      Complete the sign-in in the popup window. This modal will update automatically.
                    </p>
                  </div>
                )}

                {/* Policy step — PolicyWizard */}
                {approvalStep === "policy" && approvalConnectionId && approvalServiceId && (
                  <div>
                    <div className="text-center mb-4">
                      <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-xl">
                        {svcConfig.icon}
                      </div>
                      <h3 className="text-base font-semibold text-foreground">
                        Connection Created
                      </h3>
                      <p className="mt-1 text-sm text-muted">
                        Now configure the policy for {approvingRequest.agentName}.
                      </p>
                    </div>

                    <PolicyWizard
                      agentId={approvingRequest.agentId}
                      agentName={approvingRequest.agentName}
                      connectionId={approvalConnectionId}
                      connectionLabel={svcConfig.displayName}
                      connectionProvider={svcConfig.provider}
                      connectionService={approvalServiceId}
                      onCreated={handleApprovalPolicyCreated}
                      onCancel={handleApprovalClose}
                    />
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-3 flex justify-end">
                <button
                  onClick={handleApprovalClose}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-foreground hover:bg-white transition-colors"
                >
                  {approvalStep === "policy" && !approvalPolicyCreated
                    ? "Cancel \u2014 remove connection"
                    : "Cancel"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}
