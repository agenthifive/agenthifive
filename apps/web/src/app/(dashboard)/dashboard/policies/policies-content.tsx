"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";
import { getAllowedModelsForService, type ServiceId } from "@agenthifive/contracts";

const TRUSTED_RECIPIENT_PII_REDACT_RULE_LABEL = "Redact PII outside trusted recipient scope";

interface Agent {
  id: string;
  name: string;
}

interface Connection {
  id: string;
  provider: string;
  service: string;
  label: string;
  status: string;
}

interface AllowlistEntry {
  baseUrl: string;
  methods: string[];
  pathPatterns: string[];
}

interface AllowlistTemplate {
  id: string;
  name: string;
  description: string;
  provider: string;
  sensitive: boolean;
  allowlists: AllowlistEntry[];
}

interface RateLimits {
  maxRequestsPerHour: number;
  maxPayloadSizeBytes?: number;
  maxResponseSizeBytes?: number;
}

interface TimeWindow {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  timezone: string;
}

interface BodyCondition {
  path: string;
  op: string;
  value?: string | number | boolean | string[];
}

interface RequestRule {
  label?: string;
  match: {
    methods?: string[];
    urlPattern?: string;
    body?: BodyCondition[];
  };
  action: "allow" | "deny" | "require_approval";
}

interface RedactPattern {
  type: string;
  pattern?: string;
  replacement?: string;
}

interface ResponseRule {
  label?: string;
  match: {
    urlPattern?: string;
    methods?: string[];
  };
  filter: {
    allowFields?: string[];
    denyFields?: string[];
    redact?: RedactPattern[];
  };
}

interface PolicyRules {
  request: RequestRule[];
  response: ResponseRule[];
}

interface RulePreset {
  id: string;
  name: string;
  description: string;
  rules: PolicyRules;
  recommended: {
    defaultMode: string;
    stepUpApproval: string;
  };
  rateLimitLabel?: string;
  features?: string[];
}

interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  provider: string;
  preset: string;
  requestRules: RequestRule[];
  responseRules: ResponseRule[];
}

interface GuardCategoryInfo {
  id: string;
  name: string;
  description: string;
}

interface ResolvedGuard {
  id: string;
  category: string;
  name: string;
  description: string;
  risk: "low" | "medium" | "high";
  presetTier: "standard" | "strict";
  providers: string[];
  requestRules: RequestRule[];
  responseRules: ResponseRule[];
}

interface Policy {
  id: string;
  agentId: string;
  connectionId: string;
  connectionLabel?: string | null;
  connectionProvider?: string | null;
  allowedModels: string[];
  defaultMode: string;
  stepUpApproval: string;
  allowlists: AllowlistEntry[];
  rateLimits: RateLimits | null;
  timeWindows: TimeWindow[];
  rules: PolicyRules;
  providerConstraints: {
    provider: string;
    allowedChatIds?: string[];
    allowedTenantIds?: string[];
    allowedChannelIds?: string[];
    allowedUserIds?: string[];
  } | null;
  createdAt: string;
  updatedAt: string;
}

const MODE_LABELS: Record<string, string> = {
  read_only: "Read Only",
  read_write: "Read & Write",
  custom: "Custom",
};

const APPROVAL_LABELS: Record<string, string> = {
  always: "Always",
  risk_based: "Risk-Based",
  never: "Never",
};

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  allow: { label: "Allow", color: "bg-green-100 text-green-700" },
  deny: { label: "Deny", color: "bg-red-100 text-red-700" },
  require_approval: { label: "Approval", color: "bg-yellow-100 text-yellow-700" },
};

const RISK_COLORS: Record<string, string> = {
  low: "bg-green-100 text-green-700",
  medium: "bg-yellow-100 text-yellow-700",
  high: "bg-red-100 text-red-700",
};

const REDACT_TYPES = ["email", "phone", "ssn", "credit_card", "ip_address", "custom"] as const;
const BODY_OPS = ["eq", "neq", "in", "not_in", "contains", "matches", "exists"] as const;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const LLM_PROVIDERS = new Set(["anthropic", "openai", "gemini", "openrouter"]);

/** Return Telegram preset description adapted for trusted list state */
function adaptTelegramDescription(_description: string, presetId: string, hasTrustedRecipients: boolean): string {
  if (!hasTrustedRecipients) return _description;
  if (presetId === "minimal") {
    return "Only contacts on your trusted list can interact with the agent — everyone else is blocked. No approval required, no privacy filtering.";
  }
  if (presetId === "standard") {
    return "Only contacts on your trusted list can interact with the agent — everyone else is blocked. Sending does not require approval for trusted contacts. Personal information is redacted outside your trusted list.";
  }
  // strict
  return "Only contacts on your trusted list can interact with the agent — everyone else is blocked. Sending text messages does not require approval for trusted contacts. Photos, files, and media are blocked. Forwarding, deleting, and editing are blocked. Personal information is redacted from responses.";
}

/** Return Slack preset description adapted for trusted list state */
function adaptSlackDescription(_description: string, presetId: string, hasTrustedList: boolean): string {
  if (!hasTrustedList) return _description;
  if (presetId === "minimal") {
    return "Only users and channels on your trusted list can interact with the agent — everyone else is blocked. No approval required, no privacy filtering.";
  }
  if (presetId === "standard") {
    return "Only users and channels on your trusted list can interact with the agent — everyone else is blocked. Sending does not require approval for trusted channels. Personal information is redacted outside your trusted list.";
  }
  // strict
  return "Only users and channels on your trusted list can interact with the agent — everyone else is blocked. Sending does not require approval for trusted channels. Message deletion and pin removal are blocked. Personal information is redacted from responses.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getPresetResponseFilterSummary(
  responseRules: Array<{ label?: string }>,
): string {
  const hasTrustedRecipientScopedRedaction = responseRules.some(
    (rule) => rule.label === TRUSTED_RECIPIENT_PII_REDACT_RULE_LABEL,
  );
  if (hasTrustedRecipientScopedRedaction) {
    return "+ Personal information redaction outside trusted list";
  }
  return `+ ${responseRules.length} response ${responseRules.length === 1 ? "filter" : "filters"}`;
}

export default function PoliciesContent() {
  const { data: session } = useSession();
  const [policiesList, setPoliciesList] = useState<Policy[]>([]);
  const [agentsList, setAgentsList] = useState<Agent[]>([]);
  const [connectionsList, setConnectionsList] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create wizard state
  const [showForm, setShowForm] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [formAgentId, setFormAgentId] = useState("");
  const [formConnectionId, setFormConnectionId] = useState("");
  const [formAllowedModels, setFormAllowedModels] = useState<string[]>(["B"]);
  const [formDefaultMode, setFormDefaultMode] = useState("read_only");
  const [formStepUpApproval, setFormStepUpApproval] = useState("risk_based");
  const [formSecurityPreset, setFormSecurityPreset] = useState<"none" | "minimal" | "standard" | "strict">("standard");
  const [formPresets, setFormPresets] = useState<RulePreset[]>([]);
  const [formPresetsLoading, setFormPresetsLoading] = useState(false);
  const [formRequestRules, setFormRequestRules] = useState<RequestRule[]>([]);
  const [formResponseRules, setFormResponseRules] = useState<ResponseRule[]>([]);
  const [formRulesTab, setFormRulesTab] = useState<"request" | "response">("request");
  const [formGuardCategories, setFormGuardCategories] = useState<GuardCategoryInfo[]>([]);
  const [formGuards, setFormGuards] = useState<ResolvedGuard[]>([]);
  const [formGuardsLoading, setFormGuardsLoading] = useState(false);
  const [formEnabledGuards, setFormEnabledGuards] = useState<Set<string>>(new Set());
  const [formShowCustomRules, setFormShowCustomRules] = useState(false);
  const [creating, setCreating] = useState(false);

  // Telegram access control in wizard
  const [formTgAccess, setFormTgAccess] = useState<"anyone" | "specific">("anyone");
  const [formTgIds, setFormTgIds] = useState<{ id: string; label: string }[]>([]);
  const [formTgIdInput, setFormTgIdInput] = useState("");
  const [formTgLabelInput, setFormTgLabelInput] = useState("");
  // Trusted recipients for approval bypass (used when formTgAccess === "anyone")
  const [formTgTrustedIds, setFormTgTrustedIds] = useState<string[]>([]);
  const [formTgTrustedInput, setFormTgTrustedInput] = useState("");

  // Slack access control in wizard
  const [formSlackChannelAccess, setFormSlackChannelAccess] = useState<"anyone" | "specific">("anyone");
  const [formSlackChannelIds, setFormSlackChannelIds] = useState<{ id: string; label: string }[]>([]);
  const [formSlackChannelInput, setFormSlackChannelInput] = useState("");
  const [formSlackChannelManualMode, setFormSlackChannelManualMode] = useState(false);
  const [formSlackChannelsLoading, setFormSlackChannelsLoading] = useState(false);
  const [formSlackChannelsAvailable, setFormSlackChannelsAvailable] = useState<{ id: string; name: string; isPrivate: boolean; memberCount: number }[]>([]);
  const [formSlackChannelSearch, setFormSlackChannelSearch] = useState("");
  const [formSlackUserAccess, setFormSlackUserAccess] = useState<"anyone" | "specific">("anyone");
  const [formSlackUserIds, setFormSlackUserIds] = useState<{ id: string; label: string }[]>([]);
  const [formSlackUserInput, setFormSlackUserInput] = useState("");
  const [formSlackUserManualMode, setFormSlackUserManualMode] = useState(false);
  const [formSlackUsersLoading, setFormSlackUsersLoading] = useState(false);
  const [formSlackUsersAvailable, setFormSlackUsersAvailable] = useState<{ id: string; name: string; displayName: string; isBot: boolean }[]>([]);
  const [formSlackUserSearch, setFormSlackUserSearch] = useState("");

  // Highlight state (for newly created policies from permission requests)
  const searchParams = useSearchParams();
  const highlightPolicyId = searchParams.get("highlight");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightedPolicyRef = useRef<HTMLDivElement>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAllowedModels, setEditAllowedModels] = useState<string[]>([]);
  const [editDefaultMode, setEditDefaultMode] = useState("");
  const [editStepUpApproval, setEditStepUpApproval] = useState("");
  const [saving, setSaving] = useState(false);
  // Slack inline edit state
  const [editSlackChannelAccess, setEditSlackChannelAccess] = useState<"any" | "specific">("any");
  const [editSlackChannelIds, setEditSlackChannelIds] = useState<{ id: string; label?: string }[]>([]);
  const [editSlackUserAccess, setEditSlackUserAccess] = useState<"anyone" | "specific">("anyone");
  const [editSlackUserIds, setEditSlackUserIds] = useState<{ id: string; label?: string }[]>([]);
  const [editSlackChannelInput, setEditSlackChannelInput] = useState("");
  const [editSlackUserInput, setEditSlackUserInput] = useState("");
  const [editSlackChannelsLoading, setEditSlackChannelsLoading] = useState(false);
  const [editSlackChannelsAvailable, setEditSlackChannelsAvailable] = useState<{ id: string; name: string; isPrivate: boolean; memberCount: number }[]>([]);
  const [editSlackChannelSearch, setEditSlackChannelSearch] = useState("");
  const [editSlackChannelManualMode, setEditSlackChannelManualMode] = useState(false);
  const [editSlackUsersLoading, setEditSlackUsersLoading] = useState(false);
  const [editSlackUsersAvailable, setEditSlackUsersAvailable] = useState<{ id: string; name: string; displayName: string; isBot: boolean }[]>([]);
  const [editSlackUserSearch, setEditSlackUserSearch] = useState("");
  const [editSlackUserManualMode, setEditSlackUserManualMode] = useState(false);

  // Model A warning — tracks which setter to call when confirmed
  const [modelAWarning, setModelAWarning] = useState<"create" | "edit" | null>(null);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Allowlist editor state
  const [allowlistEditId, setAllowlistEditId] = useState<string | null>(null);
  const [allowlistEntries, setAllowlistEntries] = useState<AllowlistEntry[]>([]);
  const [savingAllowlists, setSavingAllowlists] = useState(false);

  // Rate limits editor state
  const [rateLimitEditId, setRateLimitEditId] = useState<string | null>(null);
  const [rateLimitValues, setRateLimitValues] = useState<RateLimits | null>(null);
  const [savingRateLimits, setSavingRateLimits] = useState(false);

  // Time windows editor state
  const [timeWindowEditId, setTimeWindowEditId] = useState<string | null>(null);
  const [timeWindowEntries, setTimeWindowEntries] = useState<TimeWindow[]>([]);
  const [savingTimeWindows, setSavingTimeWindows] = useState(false);

  // Allowlist templates state
  const [templates, setTemplates] = useState<AllowlistTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  // Telegram Users editor state
  const [tgUsersEditId, setTgUsersEditId] = useState<string | null>(null);
  const [tgUserEntries, setTgUserEntries] = useState<string[]>([]);
  const [tgUserInput, setTgUserInput] = useState("");
  const [tgUsersSaving, setTgUsersSaving] = useState(false);

  // Slack Channels/Users editor state
  const [slackEditId, setSlackEditId] = useState<string | null>(null);
  const [slackEditConnectionId, setSlackEditConnectionId] = useState<string>("");
  const [slackChannelEntries, setSlackChannelEntries] = useState<string[]>([]);
  const [slackChannelEditInput, setSlackChannelEditInput] = useState("");
  const [slackUserEntries, setSlackUserEntries] = useState<string[]>([]);
  const [slackUserEditInput, setSlackUserEditInput] = useState("");
  const [slackEditSaving, setSlackEditSaving] = useState(false);
  const [slackEditChannelsLoading, setSlackEditChannelsLoading] = useState(false);
  const [slackEditChannelsAvailable, setSlackEditChannelsAvailable] = useState<{ id: string; name: string; isPrivate: boolean; memberCount: number }[]>([]);
  const [slackEditChannelSearch, setSlackEditChannelSearch] = useState("");
  const [slackEditChannelManualMode, setSlackEditChannelManualMode] = useState(false);
  const [slackEditUsersLoading, setSlackEditUsersLoading] = useState(false);
  const [slackEditUsersAvailable, setSlackEditUsersAvailable] = useState<{ id: string; name: string; displayName: string; isBot: boolean }[]>([]);
  const [slackEditUserSearch, setSlackEditUserSearch] = useState("");
  const [slackEditUserManualMode, setSlackEditUserManualMode] = useState(false);

  // Rule builder state
  const [rulesEditId, setRulesEditId] = useState<string | null>(null);
  const [editRequestRules, setEditRequestRules] = useState<RequestRule[]>([]);
  const [editResponseRules, setEditResponseRules] = useState<ResponseRule[]>([]);
  const [rulesActiveTab, setRulesActiveTab] = useState<"request" | "response">("request");
  const [rulePresets, setRulePresets] = useState<RulePreset[]>([]);
  const [ruleTemplates, setRuleTemplates] = useState<RuleTemplate[]>([]);
  const [rulePresetsLoading, setRulePresetsLoading] = useState(false);
  const [showRuleTemplates, setShowRuleTemplates] = useState(false);
  const [savingRules, setSavingRules] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [policiesRes, agentsRes, connectionsRes] = await Promise.all([
        apiFetch("/policies"),
        apiFetch("/agents"),
        apiFetch("/connections"),
      ]);

      if (!policiesRes.ok || !agentsRes.ok || !connectionsRes.ok) {
        throw new Error("Failed to load data");
      }

      const [policiesData, agentsData, connectionsData] = await Promise.all([
        policiesRes.json() as Promise<{ policies: Policy[] }>,
        agentsRes.json() as Promise<{ agents: Agent[] }>,
        connectionsRes.json() as Promise<{ connections: Connection[] }>,
      ]);

      setPoliciesList(policiesData.policies);
      setAgentsList(agentsData.agents);
      setConnectionsList(connectionsData.connections);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) {
      fetchData();
    }
  }, [session, fetchData]);

  // Handle highlighting newly created policies
  useEffect(() => {
    if (highlightPolicyId && policiesList.length > 0) {
      const policyExists = policiesList.some(p => p.id === highlightPolicyId);
      if (policyExists) {
        setHighlightedId(highlightPolicyId);

        // Scroll to the highlighted policy
        setTimeout(() => {
          highlightedPolicyRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center"
          });
        }, 100);

        // Clear highlight after 5 seconds
        const timeout = setTimeout(() => {
          setHighlightedId(null);
        }, 5000);

        return () => clearTimeout(timeout);
      }
    }
  }, [highlightPolicyId, policiesList]);

  function getAgentName(agentId: string): string {
    const agent = agentsList.find((a) => a.id === agentId);
    return agent?.name ?? "Unknown Agent";
  }

  function getConnectionLabel(connectionId: string): string {
    const conn = connectionsList.find((c) => c.id === connectionId);
    if (!conn) return "Unknown Connection";
    return `${conn.label} (${conn.provider})`;
  }

  function getConnection(connectionId: string) {
    return connectionsList.find((c) => c.id === connectionId);
  }

  // Group policies by agent
  function getPoliciesByAgent() {
    const grouped = new Map<string, { agent: Agent; policies: Policy[] }>();

    for (const policy of policiesList) {
      if (!policy?.agentId) continue;
      const agent = agentsList.find((a) => a.id === policy.agentId);
      if (!agent) continue;

      if (!grouped.has(agent.id)) {
        grouped.set(agent.id, { agent, policies: [] });
      }
      grouped.get(agent.id)!.policies.push(policy);
    }

    return Array.from(grouped.values());
  }

  function toggleModel(models: string[], model: string): string[] {
    if (models.includes(model)) {
      return models.filter((m) => m !== model);
    }
    return [...models, model];
  }

  function getRecommendedPresetId(): "minimal" | "standard" | "strict" {
    return "standard";
  }

  function adaptRulesForAllowlist(
    rules: { request: RequestRule[]; response: ResponseRule[] },
    hasAllowlist: boolean,
    trustedIds: string[],
  ): { request: RequestRule[]; response: ResponseRule[] } {
    if (!hasAllowlist && trustedIds.length === 0) return rules;

    if (hasAllowlist) {
      // All recipients are trusted — change require_approval → allow for send rules
      return {
        request: rules.request.map((rule) => {
          if (rule.action !== "require_approval") return rule;
          const isSendRule = rule.match.urlPattern && (
            rule.match.urlPattern.includes("sendMessage") ||
            rule.match.urlPattern.includes("send(Photo") ||
            rule.match.urlPattern.includes("editMessage")
          );
          return isSendRule
            ? { ...rule, action: "allow" as const, label: (rule.label || "") + " (trusted)" }
            : rule;
        }),
        response: rules.response,
      };
    }

    // Open + trusted IDs: inject bypass rules before first require_approval
    const bypassRules: RequestRule[] = [];
    for (const rule of rules.request) {
      if (rule.action === "require_approval" && rule.match.urlPattern) {
        bypassRules.push({
          label: "Allow to trusted recipients",
          match: {
            ...(rule.match.methods ? { methods: rule.match.methods } : {}),
            urlPattern: rule.match.urlPattern,
            body: [{ path: "chat_id", op: "in" as const, value: trustedIds }],
          },
          action: "allow",
        });
      }
    }
    if (bypassRules.length === 0) return rules;

    const idx = rules.request.findIndex((r) => r.action === "require_approval");
    const adapted = [...rules.request];
    adapted.splice(idx, 0, ...bypassRules);
    return { request: adapted, response: rules.response };
  }

  function addTrustedRecipient() {
    const id = formTgTrustedInput.trim();
    if (!id || formTgTrustedIds.includes(id)) return;
    setFormTgTrustedIds((prev) => [...prev, id]);
    setFormTgTrustedInput("");
  }

  function addFormSlackChannelManual() {
    const id = formSlackChannelInput.trim();
    if (!id) return;
    if (formSlackChannelIds.some((e) => e.id === id)) {
      setError("This channel ID is already in the list");
      return;
    }
    setFormSlackChannelIds((prev) => [...prev, { id, label: "" }]);
    setFormSlackChannelInput("");
  }

  function addFormSlackUserManual() {
    const id = formSlackUserInput.trim();
    if (!id) return;
    if (formSlackUserIds.some((e) => e.id === id)) {
      setError("This user ID is already in the list");
      return;
    }
    setFormSlackUserIds((prev) => [...prev, { id, label: "" }]);
    setFormSlackUserInput("");
  }

  async function loadFormSlackChannels(connId: string) {
    setFormSlackChannelsLoading(true);
    try {
      const res = await apiFetch(`/connections/${connId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "channels" }),
      });
      const data = await res.json();
      if (data.items) setFormSlackChannelsAvailable(data.items);
    } catch {
      setError("Failed to load channels from Slack");
    }
    setFormSlackChannelsLoading(false);
  }

  async function loadFormSlackUsers(connId: string) {
    setFormSlackUsersLoading(true);
    try {
      const res = await apiFetch(`/connections/${connId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "users" }),
      });
      const data = await res.json();
      if (data.items) setFormSlackUsersAvailable(data.items);
    } catch {
      setError("Failed to load users from Slack");
    }
    setFormSlackUsersLoading(false);
  }

  function toggleFormSlackChannel(ch: { id: string; name: string }) {
    setFormSlackChannelIds((prev) =>
      prev.some((e) => e.id === ch.id)
        ? prev.filter((e) => e.id !== ch.id)
        : [...prev, { id: ch.id, label: ch.name }],
    );
  }

  function toggleFormSlackUser(u: { id: string; name: string; displayName: string }) {
    setFormSlackUserIds((prev) =>
      prev.some((e) => e.id === u.id)
        ? prev.filter((e) => e.id !== u.id)
        : [...prev, { id: u.id, label: u.displayName || u.name }],
    );
  }

  function adaptRulesForSlackAllowlist(
    rules: { request: RequestRule[]; response: ResponseRule[] },
    hasChannelAllowlist: boolean,
  ): { request: RequestRule[]; response: ResponseRule[] } {
    if (!hasChannelAllowlist) return rules;

    return {
      request: rules.request.map((rule) => {
        if (rule.action !== "require_approval") return rule;
        const isSendRule = rule.match.urlPattern && (
          rule.match.urlPattern.includes("chat\\.postMessage") ||
          rule.match.urlPattern.includes("files\\.uploadV2") ||
          rule.match.urlPattern.includes("chat\\.update")
        );
        return isSendRule
          ? { ...rule, action: "allow" as const, label: (rule.label || "") + " (trusted)" }
          : rule;
      }),
      response: rules.response,
    };
  }

  async function handleSaveSlackConstraints(policyId: string) {
    setSlackEditSaving(true);
    try {
      const hasChannels = slackChannelEntries.length > 0;
      const hasUsers = slackUserEntries.length > 0;
      await apiFetch(`/policies/${policyId}/provider-constraints`, {
        method: "PUT",
        body: JSON.stringify({
          providerConstraints: hasChannels || hasUsers
            ? {
                provider: "slack",
                ...(hasChannels && { allowedChannelIds: slackChannelEntries }),
                ...(hasUsers && { allowedUserIds: slackUserEntries }),
              }
            : null,
        }),
      });
      await fetchData();
      setSlackEditId(null);
    } catch {
      setError("Failed to save Slack access settings");
    } finally {
      setSlackEditSaving(false);
    }
  }

  async function loadSlackEditChannels() {
    if (!slackEditConnectionId) return;
    setSlackEditChannelsLoading(true);
    try {
      const res = await apiFetch(`/connections/${slackEditConnectionId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "channels" }),
      });
      const data = await res.json();
      if (data.items) setSlackEditChannelsAvailable(data.items);
    } catch { /* ignore */ }
    setSlackEditChannelsLoading(false);
  }

  async function loadSlackEditUsers() {
    if (!slackEditConnectionId) return;
    setSlackEditUsersLoading(true);
    try {
      const res = await apiFetch(`/connections/${slackEditConnectionId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "users" }),
      });
      const data = await res.json();
      if (data.items) setSlackEditUsersAvailable(data.items);
    } catch { /* ignore */ }
    setSlackEditUsersLoading(false);
  }

  function toggleSlackEditChannel(ch: { id: string; name: string }) {
    setSlackChannelEntries((prev) =>
      prev.includes(ch.id) ? prev.filter((id) => id !== ch.id) : [...prev, ch.id],
    );
  }

  function toggleSlackEditUser(u: { id: string; name: string }) {
    setSlackUserEntries((prev) =>
      prev.includes(u.id) ? prev.filter((id) => id !== u.id) : [...prev, u.id],
    );
  }

  async function goToStep2() {
    if (!formAgentId || !formConnectionId) return;
    const conn = connectionsList.find((c) => c.id === formConnectionId);
    if (!conn) return;

    // Default to Model B only — user must explicitly opt into Model A with warning
    setFormAllowedModels(["B"]);

    setFormPresetsLoading(true);
    setWizardStep(2);
    try {
      const res = await apiFetch(`/templates/${conn.provider}/rules`);
      if (res.ok) {
        const data = (await res.json()) as { presets: RulePreset[] };
        setFormPresets(data.presets);
        // Apply recommended settings from the default preset
        const preset = data.presets.find((p) => p.id === formSecurityPreset);
        if (preset) {
          setFormDefaultMode(preset.recommended.defaultMode);
          setFormStepUpApproval(preset.recommended.stepUpApproval);
        }
      }
    } catch {
      // Presets are optional
    } finally {
      setFormPresetsLoading(false);
    }
  }

  function handlePresetChange(presetId: "none" | "minimal" | "standard" | "strict") {
    setFormSecurityPreset(presetId);
    if (presetId === "none") return;
    const preset = formPresets.find((p) => p.id === presetId);
    if (preset) {
      setFormDefaultMode(preset.recommended.defaultMode);
      setFormStepUpApproval(preset.recommended.stepUpApproval);
    }
  }

  async function goToStep3(fromPresetId?: string) {
    const presetId = fromPresetId ?? formSecurityPreset;
    setFormRulesTab("request");
    setFormShowCustomRules(false);
    setFormRequestRules([]);
    setFormResponseRules([]);
    setFormSecurityPreset("none"); // Mark as custom since user is customizing
    setWizardStep(3);

    // Fetch contextual guards for the selected provider
    const conn = connectionsList.find((c) => c.id === formConnectionId);
    if (!conn) return;

    setFormGuardsLoading(true);
    try {
      const res = await apiFetch(`/templates/${conn.provider}/guards`);
      if (res.ok) {
        const data = (await res.json()) as { categories: GuardCategoryInfo[]; guards: ResolvedGuard[] };
        setFormGuardCategories(data.categories);
        setFormGuards(data.guards);

        // Pre-select guards based on the chosen preset tier
        const enabled = new Set<string>();
        if (presetId === "strict") {
          for (const g of data.guards) enabled.add(g.id);
        } else if (presetId === "standard") {
          for (const g of data.guards) {
            if (g.presetTier === "standard") enabled.add(g.id);
          }
        } else if (presetId === "minimal") {
          // Minimal: no guards pre-selected
        }
        // "none" = empty
        setFormEnabledGuards(enabled);
      }
    } catch {
      // Guards are optional — raw editor still available
    } finally {
      setFormGuardsLoading(false);
    }
  }

  function toggleGuard(guardId: string) {
    setFormEnabledGuards((prev) => {
      const next = new Set(prev);
      if (next.has(guardId)) {
        next.delete(guardId);
      } else {
        next.add(guardId);
      }
      return next;
    });
  }

  function buildRulesFromGuards(): PolicyRules {
    const requestRules: RequestRule[] = [];
    const responseRules: ResponseRule[] = [];

    // Collect rules from enabled guards
    for (const guard of formGuards) {
      if (!formEnabledGuards.has(guard.id)) continue;
      requestRules.push(...guard.requestRules);
      responseRules.push(...guard.responseRules);
    }

    // Append any custom rules the user added manually
    requestRules.push(...formRequestRules);
    responseRules.push(...formResponseRules);

    return { request: requestRules, response: responseRules };
  }

  function addFormRequestRule() {
    setFormRequestRules((prev) => [
      ...prev,
      { label: "", match: { methods: ["GET"] }, action: "allow" },
    ]);
  }

  function removeFormRequestRule(index: number) {
    setFormRequestRules((prev) => prev.filter((_, i) => i !== index));
  }

  function updateFormRequestRule(index: number, updater: (rule: RequestRule) => RequestRule) {
    setFormRequestRules((prev) =>
      prev.map((r, i) => (i === index ? updater(r) : r)),
    );
  }

  function addFormResponseRule() {
    setFormResponseRules((prev) => [
      ...prev,
      { label: "", match: {}, filter: {} },
    ]);
  }

  function removeFormResponseRule(index: number) {
    setFormResponseRules((prev) => prev.filter((_, i) => i !== index));
  }

  function updateFormResponseRule(index: number, updater: (rule: ResponseRule) => ResponseRule) {
    setFormResponseRules((prev) =>
      prev.map((r, i) => (i === index ? updater(r) : r)),
    );
  }

  function addFormTgUser() {
    const id = formTgIdInput.trim();
    if (!id) return;
    if (!/^\d+$/.test(id)) {
      setError("Telegram user IDs are numeric — message @userinfobot on Telegram to find yours");
      return;
    }
    if (formTgIds.some((e) => e.id === id)) {
      setError("This user ID is already in the list");
      return;
    }
    setFormTgIds((prev) => [...prev, { id, label: formTgLabelInput.trim() }]);
    setFormTgIdInput("");
    setFormTgLabelInput("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (formAllowedModels.length === 0) {
      setError("Select at least one execution model");
      return;
    }
    setCreating(true);

    try {
      const selectedConn = connectionsList.find((c) => c.id === formConnectionId);
      const res = await apiFetch("/policies", {
        method: "POST",
        body: JSON.stringify({
          agentId: formAgentId,
          connectionId: formConnectionId,
          allowedModels: formAllowedModels,
          defaultMode: formDefaultMode,
          stepUpApproval: formStepUpApproval,
          securityPreset: formSecurityPreset !== "none" ? formSecurityPreset : undefined,
          actionTemplateId: selectedConn?.service,
          policyTier: formSecurityPreset !== "none" ? formSecurityPreset : undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { policy: Policy };
      let createdPolicy = data.policy;

      if (!createdPolicy?.id) {
        throw new Error("Server returned an invalid policy");
      }

      // Rules are generated server-side from the securityPreset via
      // generatePolicyFromTemplate(). The dashboard never sends rules
      // directly — the server is the sole authority on rule content.

      // Apply Telegram user restrictions if configured
      const conn = connectionsList.find((c) => c.id === formConnectionId);
      if (formTgAccess === "specific" && formTgIds.length > 0) {
        try {
          const constraintRes = await apiFetch(`/policies/${createdPolicy.id}/provider-constraints`, {
            method: "PUT",
            body: JSON.stringify({
              providerConstraints: {
                provider: "telegram",
                allowedChatIds: formTgIds.map((e) => e.id),
              },
            }),
          });
          if (constraintRes.ok) {
            const constraintData = (await constraintRes.json()) as { policy: Policy };
            if (constraintData.policy?.id) {
              createdPolicy = constraintData.policy;
            }
          }
        } catch {
          // Constraints failed, but policy was created — user can set them later
        }
      }

      // Apply Slack channel/user restrictions if configured
      if (conn?.provider === "slack") {
        const hasChannels = formSlackChannelAccess === "specific" && formSlackChannelIds.length > 0;
        const hasUsers = formSlackUserAccess === "specific" && formSlackUserIds.length > 0;
        if (hasChannels || hasUsers) {
          try {
            const constraintRes = await apiFetch(`/policies/${createdPolicy.id}/provider-constraints`, {
              method: "PUT",
              body: JSON.stringify({
                providerConstraints: {
                  provider: "slack",
                  ...(hasChannels && { allowedChannelIds: formSlackChannelIds.map((e) => e.id) }),
                  ...(hasUsers && { allowedUserIds: formSlackUserIds.map((e) => e.id) }),
                },
              }),
            });
            if (constraintRes.ok) {
              const constraintData = (await constraintRes.json()) as { policy: Policy };
              if (constraintData.policy?.id) {
                createdPolicy = constraintData.policy;
              }
            }
          } catch {
            // Constraints failed, but policy was created — user can set them later
          }
        }
      }

      setPoliciesList((prev) => [...prev, createdPolicy]);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create policy");
    } finally {
      setCreating(false);
    }
  }

  function resetForm() {
    setShowForm(false);
    setWizardStep(1);
    setFormAgentId("");
    setFormConnectionId("");
    setFormAllowedModels(["B"]);
    setFormDefaultMode("read_only");
    setFormStepUpApproval("risk_based");
    setFormSecurityPreset("standard");
    setFormPresets([]);
    setFormRequestRules([]);
    setFormResponseRules([]);
    setFormRulesTab("request");
    setFormGuardCategories([]);
    setFormGuards([]);
    setFormEnabledGuards(new Set());
    setFormShowCustomRules(false);
    setFormTgAccess("anyone");
    setFormTgIds([]);
    setFormTgIdInput("");
    setFormTgLabelInput("");
    setFormTgTrustedIds([]);
    setFormTgTrustedInput("");
  }

  function startEdit(policy: Policy) {
    setEditingId(policy.id);
    setEditAllowedModels([...policy.allowedModels]);
    setEditDefaultMode(policy.defaultMode);
    setEditStepUpApproval(policy.stepUpApproval);
    // Slack channel/user access
    const pc = policy.providerConstraints;
    const chIds = pc?.allowedChannelIds ?? [];
    const uIds = pc?.allowedUserIds ?? [];
    setEditSlackChannelAccess(chIds.length > 0 ? "specific" : "any");
    setEditSlackChannelIds(chIds.map((id) => ({ id })));
    setEditSlackUserAccess(uIds.length > 0 ? "specific" : "anyone");
    setEditSlackUserIds(uIds.map((id) => ({ id })));
    setEditSlackChannelInput("");
    setEditSlackUserInput("");
    setEditSlackChannelsAvailable([]);
    setEditSlackChannelSearch("");
    setEditSlackChannelManualMode(false);
    setEditSlackUsersAvailable([]);
    setEditSlackUserSearch("");
    setEditSlackUserManualMode(false);
  }

  async function loadEditSlackChannels(connId: string) {
    setEditSlackChannelsLoading(true);
    try {
      const res = await apiFetch(`/connections/${connId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "channels" }),
      });
      const data = await res.json();
      if (data.items) setEditSlackChannelsAvailable(data.items);
    } catch { /* ignore */ }
    setEditSlackChannelsLoading(false);
  }

  async function loadEditSlackUsers(connId: string) {
    setEditSlackUsersLoading(true);
    try {
      const res = await apiFetch(`/connections/${connId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "users" }),
      });
      const data = await res.json();
      if (data.items) setEditSlackUsersAvailable(data.items);
    } catch { /* ignore */ }
    setEditSlackUsersLoading(false);
  }

  function toggleEditSlackChannel(ch: { id: string; name: string }) {
    setEditSlackChannelIds((prev) =>
      prev.some((e) => e.id === ch.id)
        ? prev.filter((e) => e.id !== ch.id)
        : [...prev, { id: ch.id, label: ch.name }],
    );
  }

  function toggleEditSlackUser(u: { id: string; name: string; displayName: string }) {
    setEditSlackUserIds((prev) =>
      prev.some((e) => e.id === u.id)
        ? prev.filter((e) => e.id !== u.id)
        : [...prev, { id: u.id, label: u.displayName || u.name }],
    );
  }

  function addEditSlackChannelManual() {
    const id = editSlackChannelInput.trim();
    if (id && !editSlackChannelIds.some((e) => e.id === id)) {
      setEditSlackChannelIds((prev) => [...prev, { id }]);
      setEditSlackChannelInput("");
    }
  }

  function addEditSlackUserManual() {
    const id = editSlackUserInput.trim();
    if (id && !editSlackUserIds.some((e) => e.id === id)) {
      setEditSlackUserIds((prev) => [...prev, { id }]);
      setEditSlackUserInput("");
    }
  }

  async function handleSave(policyId: string) {
    if (editAllowedModels.length === 0) {
      setError("Select at least one execution model");
      return;
    }
    setSaving(true);

    try {
      const res = await apiFetch(`/policies/${policyId}`, {
        method: "PUT",
        body: JSON.stringify({
          allowedModels: editAllowedModels,
          defaultMode: editDefaultMode,
          stepUpApproval: editStepUpApproval,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      // Save Slack provider constraints if editing a Slack policy
      const policy = policiesList.find((p) => p.id === policyId);
      const conn = policy ? getConnection(policy.connectionId) : null;
      if (conn?.provider === "slack") {
        const chIds = editSlackChannelAccess === "specific" ? editSlackChannelIds.map((e) => e.id) : [];
        const uIds = editSlackUserAccess === "specific" ? editSlackUserIds.map((e) => e.id) : [];
        const hasConstraints = chIds.length > 0 || uIds.length > 0;
        await apiFetch(`/policies/${policyId}/provider-constraints`, {
          method: "PUT",
          body: JSON.stringify({
            providerConstraints: hasConstraints
              ? {
                  provider: "slack",
                  ...(chIds.length > 0 && { allowedChannelIds: chIds }),
                  ...(uIds.length > 0 && { allowedUserIds: uIds }),
                }
              : null,
          }),
        });
      }

      await fetchData();
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update policy");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    try {
      const res = await apiFetch(`/policies/${deleteTarget.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      setPoliciesList((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete policy");
    } finally {
      setDeleting(false);
    }
  }

  // Allowlist editor handlers
  async function startAllowlistEdit(policy: Policy) {
    setAllowlistEditId(policy.id);
    setAllowlistEntries(
      policy.allowlists.length > 0
        ? policy.allowlists.map((e) => ({ ...e }))
        : [],
    );
    setShowTemplates(false);

    // Fetch templates for the connection's provider
    const conn = connectionsList.find((c) => c.id === policy.connectionId);
    if (conn) {
      setTemplatesLoading(true);
      try {
        const res = await apiFetch(`/templates/${conn.provider}`);
        if (res.ok) {
          const data = (await res.json()) as { templates: AllowlistTemplate[] };
          setTemplates(data.templates);
        }
      } catch {
        // Templates are optional, silently fail
      } finally {
        setTemplatesLoading(false);
      }
    }
  }

  function applyTemplate(template: AllowlistTemplate) {
    // Merge template allowlists into existing entries (avoid duplicates)
    setAllowlistEntries((prev) => {
      const newEntries = template.allowlists.filter(
        (te) =>
          !prev.some(
            (existing) =>
              existing.baseUrl === te.baseUrl &&
              JSON.stringify(existing.methods.sort()) === JSON.stringify([...te.methods].sort()) &&
              JSON.stringify(existing.pathPatterns.sort()) === JSON.stringify([...te.pathPatterns].sort()),
          ),
      );
      return [...prev, ...newEntries.map((e) => ({ ...e, methods: [...e.methods], pathPatterns: [...e.pathPatterns] }))];
    });
  }

  function applyAllTemplates() {
    for (const template of templates) {
      applyTemplate(template);
    }
    setShowTemplates(false);
  }

  function addAllowlistEntry() {
    setAllowlistEntries((prev) => [
      ...prev,
      { baseUrl: "https://", methods: ["GET"], pathPatterns: ["/*"] },
    ]);
  }

  function removeAllowlistEntry(index: number) {
    setAllowlistEntries((prev) => prev.filter((_, i) => i !== index));
  }

  function updateAllowlistEntry(index: number, field: keyof AllowlistEntry, value: string | string[]) {
    setAllowlistEntries((prev) =>
      prev.map((entry, i) =>
        i === index ? { ...entry, [field]: value } : entry,
      ),
    );
  }

  function toggleAllowlistMethod(index: number, method: string) {
    setAllowlistEntries((prev) =>
      prev.map((entry, i) => {
        if (i !== index) return entry;
        const methods = entry.methods.includes(method)
          ? entry.methods.filter((m) => m !== method)
          : [...entry.methods, method];
        return { ...entry, methods };
      }),
    );
  }

  function addPathPattern(index: number) {
    setAllowlistEntries((prev) =>
      prev.map((entry, i) =>
        i === index
          ? { ...entry, pathPatterns: [...entry.pathPatterns, ""] }
          : entry,
      ),
    );
  }

  function updatePathPattern(entryIndex: number, patternIndex: number, value: string) {
    setAllowlistEntries((prev) =>
      prev.map((entry, i) => {
        if (i !== entryIndex) return entry;
        const pathPatterns = [...entry.pathPatterns];
        pathPatterns[patternIndex] = value;
        return { ...entry, pathPatterns };
      }),
    );
  }

  function removePathPattern(entryIndex: number, patternIndex: number) {
    setAllowlistEntries((prev) =>
      prev.map((entry, i) => {
        if (i !== entryIndex) return entry;
        return {
          ...entry,
          pathPatterns: entry.pathPatterns.filter((_, pi) => pi !== patternIndex),
        };
      }),
    );
  }

  async function handleSaveAllowlists(policyId: string) {
    // Validate entries
    for (const entry of allowlistEntries) {
      if (!entry.baseUrl || entry.methods.length === 0 || entry.pathPatterns.length === 0) {
        setError("Each allowlist entry needs a base URL, at least one method, and at least one path pattern");
        return;
      }
      const filtered = entry.pathPatterns.filter((p) => p.trim().length > 0);
      if (filtered.length === 0) {
        setError("Path patterns cannot be empty");
        return;
      }
    }

    // Clean up empty path patterns before sending
    const cleaned = allowlistEntries.map((entry) => ({
      ...entry,
      pathPatterns: entry.pathPatterns.filter((p) => p.trim().length > 0),
    }));

    setSavingAllowlists(true);
    try {
      const res = await apiFetch(`/policies/${policyId}/allowlists`, {
        method: "PUT",
        body: JSON.stringify({ allowlists: cleaned }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { policy: Policy };
      setPoliciesList((prev) =>
        prev.map((p) => (p.id === policyId ? data.policy : p)),
      );
      setAllowlistEditId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update allowlists");
    } finally {
      setSavingAllowlists(false);
    }
  }

  // Telegram Users editor handlers
  function startTgUsersEdit(policy: Policy) {
    setTgUsersEditId(policy.id);
    setTgUserEntries(policy.providerConstraints?.allowedChatIds ?? []);
    setTgUserInput("");
  }

  function addTgUser() {
    const id = tgUserInput.trim();
    if (!id) return;
    if (!/^\d+$/.test(id)) {
      setError("Telegram user IDs must be numeric");
      return;
    }
    if (tgUserEntries.includes(id)) {
      setError("This user ID is already in the list");
      return;
    }
    setTgUserEntries((prev) => [...prev, id]);
    setTgUserInput("");
  }

  function removeTgUser(index: number) {
    setTgUserEntries((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveTgUsers(policyId: string) {
    setTgUsersSaving(true);
    try {
      const body = tgUserEntries.length > 0
        ? { providerConstraints: { provider: "telegram", allowedChatIds: tgUserEntries } }
        : { providerConstraints: null };

      const res = await apiFetch(`/policies/${policyId}/provider-constraints`, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { policy: Policy };
      setPoliciesList((prev) =>
        prev.map((p) => (p.id === policyId ? data.policy : p)),
      );
      setTgUsersEditId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update Telegram users");
    } finally {
      setTgUsersSaving(false);
    }
  }

  // Rate limits editor handlers
  function startRateLimitEdit(policy: Policy) {
    setRateLimitEditId(policy.id);
    setRateLimitValues(
      policy.rateLimits
        ? { ...policy.rateLimits }
        : { maxRequestsPerHour: 100 },
    );
  }

  async function handleSaveRateLimits(policyId: string) {
    setSavingRateLimits(true);
    try {
      const res = await apiFetch(`/policies/${policyId}/rate-limits`, {
        method: "PUT",
        body: JSON.stringify({ rateLimits: rateLimitValues }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { policy: Policy };
      setPoliciesList((prev) =>
        prev.map((p) => (p.id === policyId ? data.policy : p)),
      );
      setRateLimitEditId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update rate limits");
    } finally {
      setSavingRateLimits(false);
    }
  }

  async function handleClearRateLimits(policyId: string) {
    setSavingRateLimits(true);
    try {
      const res = await apiFetch(`/policies/${policyId}/rate-limits`, {
        method: "PUT",
        body: JSON.stringify({ rateLimits: null }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { policy: Policy };
      setPoliciesList((prev) =>
        prev.map((p) => (p.id === policyId ? data.policy : p)),
      );
      setRateLimitEditId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear rate limits");
    } finally {
      setSavingRateLimits(false);
    }
  }

  // Time windows editor handlers
  function startTimeWindowEdit(policy: Policy) {
    setTimeWindowEditId(policy.id);
    setTimeWindowEntries(
      policy.timeWindows.length > 0
        ? policy.timeWindows.map((tw) => ({ ...tw }))
        : [],
    );
  }

  function addTimeWindowEntry() {
    setTimeWindowEntries((prev) => [
      ...prev,
      { dayOfWeek: 1, startHour: 9, endHour: 17, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    ]);
  }

  function removeTimeWindowEntry(index: number) {
    setTimeWindowEntries((prev) => prev.filter((_, i) => i !== index));
  }

  function updateTimeWindowEntry(index: number, field: keyof TimeWindow, value: number | string) {
    setTimeWindowEntries((prev) =>
      prev.map((entry, i) =>
        i === index ? { ...entry, [field]: value } : entry,
      ),
    );
  }

  async function handleSaveTimeWindows(policyId: string) {
    setSavingTimeWindows(true);
    try {
      const res = await apiFetch(`/policies/${policyId}/time-windows`, {
        method: "PUT",
        body: JSON.stringify({ timeWindows: timeWindowEntries }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { policy: Policy };
      setPoliciesList((prev) =>
        prev.map((p) => (p.id === policyId ? data.policy : p)),
      );
      setTimeWindowEditId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update time windows");
    } finally {
      setSavingTimeWindows(false);
    }
  }

  function formatHour(hour: number): string {
    if (hour === 0) return "12:00 AM";
    if (hour < 12) return `${hour}:00 AM`;
    if (hour === 12) return "12:00 PM";
    return `${hour - 12}:00 PM`;
  }

  // ── Rule builder handlers ────────────────────────────────────────

  async function startRulesEdit(policy: Policy) {
    setRulesEditId(policy.id);
    setEditRequestRules(
      policy.rules?.request?.map((r) => ({ ...r, match: { ...r.match } })) ?? [],
    );
    setEditResponseRules(
      policy.rules?.response?.map((r) => ({ ...r, match: { ...r.match }, filter: { ...r.filter } })) ?? [],
    );
    setRulesActiveTab("request");
    setShowRuleTemplates(false);

    // Fetch rule presets and templates for the connection's provider
    const conn = connectionsList.find((c) => c.id === policy.connectionId);
    if (conn) {
      setRulePresetsLoading(true);
      try {
        const res = await apiFetch(`/templates/${conn.provider}/rules`);
        if (res.ok) {
          const data = (await res.json()) as { presets: RulePreset[]; templates: RuleTemplate[] };
          setRulePresets(data.presets);
          setRuleTemplates(data.templates);
        }
      } catch {
        // Templates are optional
      } finally {
        setRulePresetsLoading(false);
      }
    }
  }

  function applyRulePreset(preset: RulePreset) {
    setEditRequestRules(preset.rules.request.map((r) => ({ ...r, match: { ...r.match } })));
    setEditResponseRules(preset.rules.response.map((r) => ({ ...r, match: { ...r.match }, filter: { ...r.filter } })));
  }

  function applyRuleTemplate(template: RuleTemplate) {
    if (template.requestRules.length > 0) {
      setEditRequestRules((prev) => [
        ...prev,
        ...template.requestRules.map((r) => ({ ...r, match: { ...r.match } })),
      ]);
    }
    if (template.responseRules.length > 0) {
      setEditResponseRules((prev) => [
        ...prev,
        ...template.responseRules.map((r) => ({ ...r, match: { ...r.match }, filter: { ...r.filter } })),
      ]);
    }
  }

  function addRequestRule() {
    setEditRequestRules((prev) => [
      ...prev,
      { label: "", match: { methods: ["GET"] }, action: "allow" },
    ]);
  }

  function removeRequestRule(index: number) {
    setEditRequestRules((prev) => prev.filter((_, i) => i !== index));
  }

  function updateRequestRule(index: number, updater: (rule: RequestRule) => RequestRule) {
    setEditRequestRules((prev) =>
      prev.map((r, i) => (i === index ? updater(r) : r)),
    );
  }

  function addResponseRule() {
    setEditResponseRules((prev) => [
      ...prev,
      { label: "", match: {}, filter: {} },
    ]);
  }

  function removeResponseRule(index: number) {
    setEditResponseRules((prev) => prev.filter((_, i) => i !== index));
  }

  function updateResponseRule(index: number, updater: (rule: ResponseRule) => ResponseRule) {
    setEditResponseRules((prev) =>
      prev.map((r, i) => (i === index ? updater(r) : r)),
    );
  }

  async function handleSaveRules(policyId: string) {
    setSavingRules(true);
    try {
      const rules: PolicyRules = {
        request: editRequestRules.map((r) => {
          const rule: RequestRule = {
            match: {
              ...(r.match.methods?.length ? { methods: r.match.methods } : {}),
              ...(r.match.urlPattern ? { urlPattern: r.match.urlPattern } : {}),
              ...(r.match.body?.length ? { body: r.match.body } : {}),
            },
            action: r.action,
          };
          if (r.label) rule.label = r.label;
          return rule;
        }),
        response: editResponseRules.map((r) => {
          const rule: ResponseRule = {
            match: {
              ...(r.match.urlPattern ? { urlPattern: r.match.urlPattern } : {}),
              ...(r.match.methods?.length ? { methods: r.match.methods } : {}),
            },
            filter: {
              ...(r.filter.allowFields?.length ? { allowFields: r.filter.allowFields } : {}),
              ...(r.filter.denyFields?.length ? { denyFields: r.filter.denyFields } : {}),
              ...(r.filter.redact?.length ? { redact: r.filter.redact } : {}),
            },
          };
          if (r.label) rule.label = r.label;
          return rule;
        }),
      };

      const res = await apiFetch(`/policies/${policyId}/rules`, {
        method: "PUT",
        body: JSON.stringify({ rules }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        throw new Error(data.error);
      }

      const data = (await res.json()) as { policy: Policy };
      setPoliciesList((prev) =>
        prev.map((p) => (p.id === policyId ? data.policy : p)),
      );
      setRulesEditId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update rules");
    } finally {
      setSavingRules(false);
    }
  }

  function getRulesSummary(policy: Policy): string {
    const req = policy.rules?.request?.length ?? 0;
    const res = policy.rules?.response?.length ?? 0;
    if (req === 0 && res === 0) return "No rules configured";
    const parts: string[] = [];
    if (req > 0) parts.push(`${req} request`);
    if (res > 0) parts.push(`${res} response`);
    return parts.join(", ");
  }

  function detectPreset(policy: Policy): string | null {
    if (!policy.rules?.request?.length && !policy.rules?.response?.length) return null;
    for (const preset of rulePresets) {
      if (
        JSON.stringify(preset.rules.request) === JSON.stringify(policy.rules.request) &&
        JSON.stringify(preset.rules.response) === JSON.stringify(policy.rules.response)
      ) {
        return preset.name;
      }
    }
    return "Custom";
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-foreground">Policies</h1>
        <p className="mt-4 text-muted">Loading policies...</p>
      </div>
    );
  }

  const healthyConnections = connectionsList.filter((c) => c.status !== "revoked");

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Policies</h1>
          <p className="mt-2 text-muted">
            Control what agents can do with your connected accounts.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            disabled={agentsList.length === 0 || healthyConnections.length === 0}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              agentsList.length === 0
                ? "Register an agent first"
                : healthyConnections.length === 0
                  ? "Add a connection first"
                  : undefined
            }
          >
            Create Policy
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

      {/* Prerequisite warnings */}
      {agentsList.length === 0 && (
        <div className="mt-4 rounded-md border border-yellow-200 bg-yellow-50 p-3">
          <p className="text-sm text-yellow-700">
            No agents registered. <a href="/dashboard/agents" className="underline font-medium">Register an agent</a> before creating policies.
          </p>
        </div>
      )}
      {agentsList.length > 0 && healthyConnections.length === 0 && (
        <div className="mt-4 rounded-md border border-yellow-200 bg-yellow-50 p-3">
          <p className="text-sm text-yellow-700">
            No active connections. <a href="/dashboard/connections" className="underline font-medium">Add a connection</a> before creating policies.
          </p>
        </div>
      )}

      {/* Create Policy Wizard */}
      {showForm && (
        <div className="mt-6 rounded-lg border border-border bg-card p-6 max-w-2xl">
          {/* Wizard progress */}
          <div className="flex items-center gap-3 mb-6">
            <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
              wizardStep >= 1 ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-500"
            }`}>1</div>
            <div className={`h-0.5 flex-1 ${wizardStep >= 2 ? "bg-blue-600" : "bg-gray-200"}`} />
            <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
              wizardStep >= 2 ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-500"
            }`}>2</div>
          </div>

          {wizardStep === 1 ? (
            /* ── Step 1: Agent + Connection ── */
            <div>
              <h2 className="text-lg font-semibold text-foreground">Select Agent & Connection</h2>
              <p className="mt-1 text-sm text-muted">
                Choose which agent should access which connection.
              </p>
              <div className="mt-4 space-y-4">
                <div>
                  <label htmlFor="policy-agent" className="block text-sm font-medium text-foreground">
                    Agent <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="policy-agent"
                    value={formAgentId}
                    onChange={(e) => setFormAgentId(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Select an agent...</option>
                    {agentsList.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="policy-connection" className="block text-sm font-medium text-foreground">
                    Connection <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="policy-connection"
                    value={formConnectionId}
                    onChange={(e) => setFormConnectionId(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Select a connection...</option>
                    {healthyConnections.map((conn) => (
                      <option key={conn.id} value={conn.id}>{conn.label} ({conn.provider})</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button type="button" onClick={goToStep2} disabled={!formAgentId || !formConnectionId}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    Next: Configure Security
                  </button>
                  <button type="button" onClick={resetForm}
                    className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* ── Step 2: Security Preset + Settings ── */
            <div>
              <h2 className="text-lg font-semibold text-foreground">Configure Security</h2>
              <p className="mt-1 text-sm text-muted">
                Choose a security preset for{" "}
                <strong>{getAgentName(formAgentId)}</strong> on{" "}
                <strong>{getConnectionLabel(formConnectionId)}</strong>.
              </p>

              <form onSubmit={handleCreate} className="mt-4 space-y-5">
                {/* Telegram: Recommendation banner + Who can communicate with this agent? (BEFORE presets) */}
                {connectionsList.find((c) => c.id === formConnectionId)?.provider === "telegram" && (
                  <>
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                      <p className="text-sm font-medium text-amber-800">
                        We recommend restricting this agent to yourself or a small number of trusted recipients.
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        When a trusted list is set, only those contacts can interact with the agent and approval is not required — unlocking a simpler, safer experience.
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">
                        Who can the agent interact with?
                      </label>
                      <p className="text-xs text-muted mb-3">
                        Control which Telegram users can interact with the agent — both sending and receiving. This is enforced by AgentHiFive — Telegram itself has no restrictions.
                      </p>

                      <div className="space-y-2">
                        <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${formTgAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                          <input type="radio" name="tg-access" value="anyone" checked={formTgAccess === "anyone"}
                            onChange={() => setFormTgAccess("anyone")}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                          <div>
                            <span className="text-sm font-medium text-foreground">Anyone</span>
                            <p className="text-xs text-muted mt-0.5">
                              The agent can send and receive messages with any Telegram user.
                            </p>
                          </div>
                        </label>

                        <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${formTgAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                          <input type="radio" name="tg-access" value="specific" checked={formTgAccess === "specific"}
                            onChange={() => setFormTgAccess("specific")}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                          <div>
                            <span className="text-sm font-medium text-foreground">Only specific people</span>
                            <p className="text-xs text-muted mt-0.5">
                              The agent can only interact with the people listed below — all other users are blocked from sending to or receiving from the agent.
                            </p>
                          </div>
                        </label>
                      </div>

                      {/* Trusted recipient input for "Anyone" mode */}
                      {formTgAccess === "anyone" && (
                        <div className="mt-3 rounded-lg border border-border bg-gray-50 p-4 space-y-3">
                          <p className="text-xs text-muted">
                            <strong>Add yourself as a trusted recipient</strong> so the agent can message you without approval. Only users on this list will be able to interact with the agent.
                          </p>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={formTgTrustedInput}
                              onChange={(e) => setFormTgTrustedInput(e.target.value)}
                              placeholder="Your Telegram User ID"
                              className="block flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTrustedRecipient(); } }}
                            />
                            <button type="button" onClick={addTrustedRecipient} disabled={!formTgTrustedInput.trim()}
                              className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                              Add
                            </button>
                          </div>
                          {formTgTrustedIds.length > 0 && (
                            <div className="space-y-1">
                              {formTgTrustedIds.map((id, i) => (
                                <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-1.5">
                                  <span className="text-sm font-mono">{id}</span>
                                  <button type="button" onClick={() => setFormTgTrustedIds((p) => p.filter((_, idx) => idx !== i))}
                                    className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                                </div>
                              ))}
                            </div>
                          )}
                          <p className="text-xs text-blue-600">
                            Message <span className="font-mono">@userinfobot</span> on Telegram to find your numeric user ID.
                          </p>
                        </div>
                      )}

                      {/* Specific users input */}
                      {formTgAccess === "specific" && (
                        <div className="mt-3 rounded-lg border border-border bg-gray-50 p-4 space-y-3">
                          <div className="flex gap-2">
                            <div className="flex-1">
                              <input
                                type="text"
                                value={formTgIdInput}
                                onChange={(e) => setFormTgIdInput(e.target.value)}
                                placeholder="Telegram User ID"
                                className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); addFormTgUser(); }
                                }}
                              />
                            </div>
                            <div className="flex-1">
                              <input
                                type="text"
                                value={formTgLabelInput}
                                onChange={(e) => setFormTgLabelInput(e.target.value)}
                                placeholder='Name (optional, e.g. "Mom")'
                                className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); addFormTgUser(); }
                                }}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={addFormTgUser}
                              disabled={!formTgIdInput.trim()}
                              className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Add
                            </button>
                          </div>

                          {formTgIds.length > 0 ? (
                            <div className="space-y-1">
                              {formTgIds.map((entry, i) => (
                                <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                                      {(entry.label || entry.id).charAt(0).toUpperCase()}
                                    </span>
                                    <div>
                                      {entry.label ? (
                                        <>
                                          <span className="text-sm font-medium text-foreground">{entry.label}</span>
                                          <span className="ml-2 text-xs text-muted font-mono">{entry.id}</span>
                                        </>
                                      ) : (
                                        <span className="text-sm font-mono text-foreground">{entry.id}</span>
                                      )}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setFormTgIds((prev) => prev.filter((_, idx) => idx !== i))}
                                    className="text-red-400 hover:text-red-600 text-sm"
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-muted text-center py-2">
                              No users added yet. Add at least one Telegram user ID.
                            </p>
                          )}

                          <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2">
                            <p className="text-xs text-blue-700">
                              <strong>How to find a Telegram user ID:</strong> Ask each person to message{" "}
                              <span className="font-mono">@userinfobot</span> on Telegram — it will reply with their numeric ID.
                              You can also find your own ID this way.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Slack: Channel + User access control */}
                {connectionsList.find((c) => c.id === formConnectionId)?.provider === "slack" && (
                  <>
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                      <p className="text-sm font-medium text-amber-800">
                        We recommend restricting this agent to specific channels and users.
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        When a trusted list is set, only those channels and users can interact with the agent and approval is not required — unlocking a simpler, safer experience.
                      </p>
                    </div>

                    {/* Channel access */}
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">
                        Which channels can the agent use?
                      </label>
                      <p className="text-xs text-muted mb-3">
                        Control which Slack channels the agent can read from and post to. This is enforced by AgentHiFive.
                      </p>

                      <div className="space-y-2">
                        <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${formSlackChannelAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                          <input type="radio" name="slack-channel-access" value="anyone" checked={formSlackChannelAccess === "anyone"}
                            onChange={() => setFormSlackChannelAccess("anyone")}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                          <div>
                            <span className="text-sm font-medium text-foreground">Any channel</span>
                            <p className="text-xs text-muted mt-0.5">
                              The agent can read and post in any channel it has access to.
                            </p>
                          </div>
                        </label>

                        <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${formSlackChannelAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                          <input type="radio" name="slack-channel-access" value="specific" checked={formSlackChannelAccess === "specific"}
                            onChange={() => setFormSlackChannelAccess("specific")}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                          <div>
                            <span className="text-sm font-medium text-foreground">Only specific channels</span>
                            <p className="text-xs text-muted mt-0.5">
                              The agent can only use the channels listed below — all other channels are blocked.
                            </p>
                          </div>
                        </label>
                      </div>

                      {formSlackChannelAccess === "specific" && (
                        <div className="mt-3 rounded-lg border border-border bg-gray-50 p-4 space-y-3">
                          {/* Load from Slack button */}
                          {formSlackChannelsAvailable.length === 0 && !formSlackChannelManualMode && (
                            <button type="button" onClick={() => loadFormSlackChannels(formConnectionId)} disabled={formSlackChannelsLoading || !formConnectionId}
                              className="w-full rounded-md border border-blue-300 bg-white px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                              {formSlackChannelsLoading ? "Loading channels..." : "Load channels from Slack"}
                            </button>
                          )}

                          {/* Searchable channel picker */}
                          {formSlackChannelsAvailable.length > 0 && (
                            <>
                              <input
                                type="text"
                                value={formSlackChannelSearch}
                                onChange={(e) => setFormSlackChannelSearch(e.target.value)}
                                placeholder="Search channels..."
                                className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                              <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
                                {formSlackChannelsAvailable
                                  .filter((ch) => ch.name.toLowerCase().includes(formSlackChannelSearch.toLowerCase()))
                                  .map((ch) => {
                                    const selected = formSlackChannelIds.some((e) => e.id === ch.id);
                                    return (
                                      <label key={ch.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? "bg-blue-50" : ""}`}>
                                        <input type="checkbox" checked={selected} onChange={() => toggleFormSlackChannel(ch)}
                                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                                        <span className="text-sm text-foreground flex-1">
                                          <span className="font-medium">#{ch.name}</span>
                                          {ch.isPrivate && <span className="ml-1 text-xs text-muted">(private)</span>}
                                        </span>
                                        <span className="text-xs text-muted">{ch.memberCount} members</span>
                                      </label>
                                    );
                                  })}
                              </div>
                            </>
                          )}

                          {/* Manual ID entry fallback */}
                          {formSlackChannelsAvailable.length === 0 && !formSlackChannelManualMode && !formSlackChannelsLoading && (
                            <p className="text-xs text-center">
                              <button type="button" onClick={() => setFormSlackChannelManualMode(true)} className="text-blue-600 hover:text-blue-700 underline">
                                Or enter a channel ID manually
                              </button>
                            </p>
                          )}
                          {formSlackChannelManualMode && (
                            <div className="flex gap-2">
                              <input type="text" value={formSlackChannelInput} onChange={(e) => setFormSlackChannelInput(e.target.value)}
                                placeholder="Channel ID (e.g. C0123456789)"
                                className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFormSlackChannelManual(); } }} />
                              <button type="button" onClick={addFormSlackChannelManual} disabled={!formSlackChannelInput.trim()}
                                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                                Add
                              </button>
                            </div>
                          )}

                          {/* Selected channels (shown when using manual mode) */}
                          {formSlackChannelIds.length > 0 && formSlackChannelsAvailable.length === 0 && (
                            <div className="space-y-1">
                              {formSlackChannelIds.map((entry, i) => (
                                <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">#</span>
                                    <div>
                                      {entry.label ? (
                                        <>
                                          <span className="text-sm font-medium text-foreground">{entry.label}</span>
                                          <span className="ml-2 text-xs text-muted font-mono">{entry.id}</span>
                                        </>
                                      ) : (
                                        <span className="text-sm font-mono text-foreground">{entry.id}</span>
                                      )}
                                    </div>
                                  </div>
                                  <button type="button" onClick={() => setFormSlackChannelIds((prev) => prev.filter((_, idx) => idx !== i))}
                                    className="text-red-400 hover:text-red-600 text-sm">Remove</button>
                                </div>
                              ))}
                            </div>
                          )}

                          {formSlackChannelIds.length === 0 && formSlackChannelsAvailable.length === 0 && !formSlackChannelsLoading && (
                            <p className="text-xs text-muted text-center py-1">
                              No channels selected yet.
                            </p>
                          )}

                          {/* Summary when picker is showing */}
                          {formSlackChannelsAvailable.length > 0 && formSlackChannelIds.length > 0 && (
                            <p className="text-xs text-muted">
                              {formSlackChannelIds.length} channel{formSlackChannelIds.length !== 1 ? "s" : ""} selected
                            </p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* User access */}
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">
                        Who can the agent interact with?
                      </label>
                      <p className="text-xs text-muted mb-3">
                        Control which Slack users can interact with the agent. Messages from other users are filtered out. This is enforced by AgentHiFive.
                      </p>

                      <div className="space-y-2">
                        <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${formSlackUserAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                          <input type="radio" name="slack-user-access" value="anyone" checked={formSlackUserAccess === "anyone"}
                            onChange={() => setFormSlackUserAccess("anyone")}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                          <div>
                            <span className="text-sm font-medium text-foreground">Anyone</span>
                            <p className="text-xs text-muted mt-0.5">
                              The agent can read messages from any user in the allowed channels.
                            </p>
                          </div>
                        </label>

                        <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${formSlackUserAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                          <input type="radio" name="slack-user-access" value="specific" checked={formSlackUserAccess === "specific"}
                            onChange={() => setFormSlackUserAccess("specific")}
                            className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                          <div>
                            <span className="text-sm font-medium text-foreground">Only specific people</span>
                            <p className="text-xs text-muted mt-0.5">
                              The agent can only see messages from the people listed below — messages from all other users are filtered out.
                            </p>
                          </div>
                        </label>
                      </div>

                      {formSlackUserAccess === "specific" && (
                        <div className="mt-3 rounded-lg border border-border bg-gray-50 p-4 space-y-3">
                          {/* Load from Slack button */}
                          {formSlackUsersAvailable.length === 0 && !formSlackUserManualMode && (
                            <button type="button" onClick={() => loadFormSlackUsers(formConnectionId)} disabled={formSlackUsersLoading || !formConnectionId}
                              className="w-full rounded-md border border-blue-300 bg-white px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                              {formSlackUsersLoading ? "Loading users..." : "Load users from Slack"}
                            </button>
                          )}

                          {/* Searchable user picker */}
                          {formSlackUsersAvailable.length > 0 && (
                            <>
                              <input
                                type="text"
                                value={formSlackUserSearch}
                                onChange={(e) => setFormSlackUserSearch(e.target.value)}
                                placeholder="Search users..."
                                className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                              <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
                                {formSlackUsersAvailable
                                  .filter((u) => !u.isBot)
                                  .filter((u) =>
                                    u.displayName.toLowerCase().includes(formSlackUserSearch.toLowerCase()) ||
                                    u.name.toLowerCase().includes(formSlackUserSearch.toLowerCase()),
                                  )
                                  .map((u) => {
                                    const selected = formSlackUserIds.some((e) => e.id === u.id);
                                    return (
                                      <label key={u.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? "bg-blue-50" : ""}`}>
                                        <input type="checkbox" checked={selected} onChange={() => toggleFormSlackUser(u)}
                                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                                        <span className="text-sm text-foreground flex-1">
                                          <span className="font-medium">{u.displayName}</span>
                                          {u.displayName !== u.name && <span className="ml-1 text-xs text-muted">@{u.name}</span>}
                                        </span>
                                      </label>
                                    );
                                  })}
                              </div>
                            </>
                          )}

                          {/* Manual ID entry fallback */}
                          {formSlackUsersAvailable.length === 0 && !formSlackUserManualMode && !formSlackUsersLoading && (
                            <p className="text-xs text-center">
                              <button type="button" onClick={() => setFormSlackUserManualMode(true)} className="text-blue-600 hover:text-blue-700 underline">
                                Or enter a member ID manually
                              </button>
                            </p>
                          )}
                          {formSlackUserManualMode && (
                            <div className="flex gap-2">
                              <input type="text" value={formSlackUserInput} onChange={(e) => setFormSlackUserInput(e.target.value)}
                                placeholder="Member ID (e.g. U0123456789)"
                                className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFormSlackUserManual(); } }} />
                              <button type="button" onClick={addFormSlackUserManual} disabled={!formSlackUserInput.trim()}
                                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                                Add
                              </button>
                            </div>
                          )}

                          {/* Selected users (shown when using manual mode) */}
                          {formSlackUserIds.length > 0 && formSlackUsersAvailable.length === 0 && (
                            <div className="space-y-1">
                              {formSlackUserIds.map((entry, i) => (
                                <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                                      {(entry.label || entry.id).charAt(0).toUpperCase()}
                                    </span>
                                    <div>
                                      {entry.label ? (
                                        <>
                                          <span className="text-sm font-medium text-foreground">{entry.label}</span>
                                          <span className="ml-2 text-xs text-muted font-mono">{entry.id}</span>
                                        </>
                                      ) : (
                                        <span className="text-sm font-mono text-foreground">{entry.id}</span>
                                      )}
                                    </div>
                                  </div>
                                  <button type="button" onClick={() => setFormSlackUserIds((prev) => prev.filter((_, idx) => idx !== i))}
                                    className="text-red-400 hover:text-red-600 text-sm">Remove</button>
                                </div>
                              ))}
                            </div>
                          )}

                          {formSlackUserIds.length === 0 && formSlackUsersAvailable.length === 0 && !formSlackUsersLoading && (
                            <p className="text-xs text-muted text-center py-1">
                              No users selected yet.
                            </p>
                          )}

                          {/* Summary when picker is showing */}
                          {formSlackUsersAvailable.length > 0 && formSlackUserIds.length > 0 && (
                            <p className="text-xs text-muted">
                              {formSlackUserIds.length} user{formSlackUserIds.length !== 1 ? "s" : ""} selected
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Security Preset */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">
                    Security Preset
                  </label>
                  {formPresetsLoading ? (
                    <p className="text-xs text-muted">Loading presets...</p>
                  ) : formPresets.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {formPresets.map((preset) => {
                        const selected = formSecurityPreset === preset.id;
                        return (
                          <div
                            key={preset.id}
                            className={`rounded-lg border-2 px-4 py-3 text-left text-sm transition-all cursor-pointer ${
                              selected
                                ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500"
                                : "border-border hover:border-blue-300 hover:bg-gray-50"
                            }`}
                            onClick={() => handlePresetChange(preset.id as "minimal" | "standard" | "strict")}
                          >
                            <div className="flex items-center justify-between">
                              <span className={`font-semibold ${selected ? "text-blue-700" : "text-foreground"}`}>
                                {preset.name}
                              </span>
                              <div className="flex items-center gap-2">
                                {preset.id === getRecommendedPresetId() && (
                                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                                    Recommended
                                  </span>
                                )}
                              </div>
                            </div>
                            <p className="mt-1 text-xs text-muted">
                              {connectionsList.find((c) => c.id === formConnectionId)?.provider === "telegram"
                                ? adaptTelegramDescription(preset.description, preset.id, (formTgAccess === "anyone" && formTgTrustedIds.length > 0) || (formTgAccess === "specific" && formTgIds.length > 0))
                                : connectionsList.find((c) => c.id === formConnectionId)?.provider === "slack"
                                  ? adaptSlackDescription(preset.description, preset.id, (formSlackChannelAccess === "specific" && formSlackChannelIds.length > 0) || (formSlackUserAccess === "specific" && formSlackUserIds.length > 0))
                                  : preset.description}
                            </p>
                            {preset.rateLimitLabel && (
                              <div className="mt-1 text-xs font-medium text-blue-700 bg-blue-50 rounded px-1.5 py-0.5 inline-block">{preset.rateLimitLabel}</div>
                            )}
                            <div className="mt-2 flex flex-wrap gap-1">
                              {preset.rules.request.slice(0, 3).map((rule, ri) => (
                                <span
                                  key={ri}
                                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${
                                    ACTION_LABELS[rule.action]?.color ?? "bg-gray-100 text-gray-700"
                                  }`}
                                >
                                  {rule.label || rule.action}
                                </span>
                              ))}
                              {preset.rules.request.length > 3 && (
                                <span className="text-xs text-muted">+{preset.rules.request.length - 3} more</span>
                              )}
                              {preset.rules.response.length > 0 && (
                                <span className="text-xs text-muted">{getPresetResponseFilterSummary(preset.rules.response)}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-muted">No presets available for this provider</p>
                  )}
                </div>

                {/* Execution models */}
                {(() => {
                  const conn = connectionsList.find((c) => c.id === formConnectionId);
                  const serviceModels = conn ? getAllowedModelsForService(conn.service as ServiceId) : ["A", "B"];
                  return (
                    <div>
                      <label className="block text-sm font-medium text-foreground">
                        Execution Models <span className="text-red-500">*</span>
                      </label>
                      <p className="mt-0.5 text-xs text-muted">
                        Model A: Token vending (agent gets short-lived access token).
                        Model B: Brokered proxy (agent never sees credentials).
                      </p>
                      <div className="mt-2 flex gap-4">
                        {serviceModels.includes("A") && (
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={formAllowedModels.includes("A")}
                              onChange={() => {
                                if (!formAllowedModels.includes("A")) {
                                  setModelAWarning("create");
                                } else {
                                  setFormAllowedModels(formAllowedModels.filter((m) => m !== "A"));
                                }
                              }}
                              className="h-4 w-4 rounded border-border text-blue-600 focus:ring-blue-500" />
                            <span className="text-sm text-foreground">Model A (Token Vending)</span>
                          </label>
                        )}
                        {serviceModels.includes("B") && (
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={formAllowedModels.includes("B")}
                              onChange={() => setFormAllowedModels(toggleModel(formAllowedModels, "B"))}
                              className="h-4 w-4 rounded border-border text-blue-600 focus:ring-blue-500" />
                            <span className="text-sm text-foreground">Model B (Brokered Proxy)</span>
                          </label>
                        )}
                      </div>
                      {formAllowedModels.includes("A") && (
                        <p className="mt-1 text-xs text-amber-600">
                          Model A lets the agent call the provider directly with a temporary token, bypassing proxy protections.
                        </p>
                      )}
                      {serviceModels.length === 1 && (
                        <p className="mt-1 text-xs text-muted">
                          Only Model {serviceModels[0]} is available for this connection type.
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Advanced: Mode + Approval */}
                <details className="rounded-md border border-border">
                  <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-muted hover:text-foreground">
                    Advanced Settings
                    <span className="ml-2 text-xs">
                      (Mode: {MODE_LABELS[formDefaultMode] ?? formDefaultMode}, Approval: {APPROVAL_LABELS[formStepUpApproval] ?? formStepUpApproval})
                    </span>
                  </summary>
                  <div className="space-y-4 px-4 pb-4 pt-2">
                    <div>
                      <label htmlFor="policy-mode" className="block text-sm font-medium text-foreground">Default Mode</label>
                      <select id="policy-mode" value={formDefaultMode} onChange={(e) => setFormDefaultMode(e.target.value)}
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
                        <option value="read_only">Read Only</option>
                        <option value="read_write">Read & Write</option>
                        <option value="custom">Custom</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="policy-approval" className="block text-sm font-medium text-foreground">Step-Up Approval</label>
                      <p className="mt-0.5 text-xs text-muted">When should write actions require your explicit approval?</p>
                      <select id="policy-approval" value={formStepUpApproval} onChange={(e) => setFormStepUpApproval(e.target.value)}
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
                        <option value="always">Always (approve every write)</option>
                        <option value="risk_based">Risk-Based (approve sensitive writes)</option>
                        <option value="never">Never (auto-approve all)</option>
                      </select>
                    </div>
                  </div>
                </details>

                <div className="flex gap-3 pt-2">
                  <button type="button" onClick={() => setWizardStep(1)}
                    className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100">
                    Back
                  </button>
                  <button type="submit" disabled={creating || formAllowedModels.length === 0}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    {creating ? "Creating..." : "Create Policy"}
                  </button>
                  <button type="button" onClick={resetForm}
                    className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Policies List - Grouped by Agent */}
      <div className="mt-8">
        {policiesList.length === 0 && !showForm ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
            <p className="text-muted">No policies configured yet.</p>
            <p className="mt-1 text-sm text-muted">
              Create a policy to control how agents interact with your connections.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {getPoliciesByAgent().map(({ agent, policies }) => (
              <div
                key={agent.id}
                className="rounded-xl border-2 border-blue-200/50 bg-gradient-to-br from-blue-50 via-purple-50 to-blue-50 p-6 shadow-lg"
              >
                {/* Agent Header */}
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 text-white font-bold text-lg ring-4 ring-blue-300 ring-opacity-50 shadow-md">
                    {agent.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-foreground">{agent.name}</h3>
                    <p className="text-xs text-muted">
                      {policies.length} {policies.length === 1 ? "policy" : "policies"}
                    </p>
                  </div>
                </div>

                {/* Policy Cards */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {policies
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                    .map((policy) => {
                    const connection = getConnection(policy.connectionId);
                    const isEditing = editingId === policy.id;
                    // Use denormalized fields from policy, fall back to connection lookup
                    const connectionLabel = policy.connectionLabel || connection?.label || "Unknown Connection";
                    const connectionProvider = policy.connectionProvider || connection?.provider || "";

                    return isEditing ? (
                      /* Edit mode */
                      <div key={policy.id} className="rounded-lg border border-border bg-white p-4">
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <h3 className="text-sm font-semibold text-foreground">
                                {connectionLabel}
                              </h3>
                              <p className="text-xs text-muted">
                                {connectionProvider}
                              </p>
                            </div>
                            <span className="text-xs text-muted">Editing</span>
                          </div>

                          {/* Edit execution models */}
                          {(() => {
                            const editServiceModels = connection ? getAllowedModelsForService(connection.service as ServiceId) : ["A", "B"];
                            return (
                              <div>
                                <label className="block text-xs font-medium text-muted">Execution Models</label>
                                <div className="mt-1 flex gap-4">
                                  {editServiceModels.includes("A") && (
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={editAllowedModels.includes("A")}
                                        onChange={() => {
                                          if (!editAllowedModels.includes("A")) {
                                            setModelAWarning("edit");
                                          } else {
                                            setEditAllowedModels(editAllowedModels.filter((m) => m !== "A"));
                                          }
                                        }}
                                        className="h-4 w-4 rounded border-border text-blue-600 focus:ring-blue-500"
                                      />
                                      <span className="text-sm text-foreground">Model A (Token Vending)</span>
                                    </label>
                                  )}
                                  {editServiceModels.includes("B") && (
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={editAllowedModels.includes("B")}
                                        onChange={() => setEditAllowedModels(toggleModel(editAllowedModels, "B"))}
                                        className="h-4 w-4 rounded border-border text-blue-600 focus:ring-blue-500"
                                      />
                                      <span className="text-sm text-foreground">Model B (Brokered Proxy)</span>
                                    </label>
                                  )}
                                </div>
                                {editAllowedModels.includes("A") && (
                                  <p className="mt-1 text-xs text-amber-600">
                                    Model A lets the agent call the provider directly, bypassing proxy protections.
                                  </p>
                                )}
                                {editServiceModels.length === 1 && (
                                  <p className="mt-1 text-xs text-muted">
                                    Only Model {editServiceModels[0]} is available for this connection type.
                                  </p>
                                )}
                              </div>
                            );
                          })()}

                          {/* Edit default mode */}
                          <div>
                            <label className="block text-xs font-medium text-muted">Default Mode</label>
                            <select
                              value={editDefaultMode}
                              onChange={(e) => setEditDefaultMode(e.target.value)}
                              className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            >
                              <option value="read_only">Read Only</option>
                              <option value="read_write">Read & Write</option>
                              <option value="custom">Custom</option>
                            </select>
                          </div>

                          {/* Edit step-up approval */}
                          <div>
                            <label className="block text-xs font-medium text-muted">Step-Up Approval</label>
                            <select
                              value={editStepUpApproval}
                              onChange={(e) => setEditStepUpApproval(e.target.value)}
                              className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            >
                              <option value="always">Always</option>
                              <option value="risk_based">Risk-Based</option>
                              <option value="never">Never</option>
                            </select>
                          </div>

                          {/* Slack channel/user access (only for Slack connections) */}
                          {connectionProvider === "slack" && (
                            <>
                              {/* Channel access */}
                              <div>
                                <label className="block text-xs font-medium text-muted mb-1">Channel Access</label>
                                <div className="space-y-2">
                                  <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${editSlackChannelAccess === "any" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                                    <input type="radio" name="edit-slack-channel" value="any" checked={editSlackChannelAccess === "any"}
                                      onChange={() => setEditSlackChannelAccess("any")}
                                      className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                                    <div>
                                      <span className="text-sm font-medium text-foreground">Any channel</span>
                                      <p className="text-xs text-muted mt-0.5">Open to all channels.</p>
                                    </div>
                                  </label>
                                  <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${editSlackChannelAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                                    <input type="radio" name="edit-slack-channel" value="specific" checked={editSlackChannelAccess === "specific"}
                                      onChange={() => setEditSlackChannelAccess("specific")}
                                      className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                                    <div>
                                      <span className="text-sm font-medium text-foreground">Only specific channels</span>
                                      <p className="text-xs text-muted mt-0.5">All other channels are blocked.</p>
                                    </div>
                                  </label>
                                </div>

                                {editSlackChannelAccess === "specific" && (
                                  <div className="mt-2 rounded-lg border border-border bg-gray-50 p-3 space-y-2">
                                    {/* Load from Slack button */}
                                    {editSlackChannelsAvailable.length === 0 && !editSlackChannelManualMode && (
                                      <button type="button" onClick={() => loadEditSlackChannels(policy.connectionId)} disabled={editSlackChannelsLoading}
                                        className="w-full rounded-md border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                                        {editSlackChannelsLoading ? "Loading channels..." : "Load channels from Slack"}
                                      </button>
                                    )}

                                    {/* Searchable channel picker */}
                                    {editSlackChannelsAvailable.length > 0 && (
                                      <>
                                        <input type="text" value={editSlackChannelSearch} onChange={(e) => setEditSlackChannelSearch(e.target.value)}
                                          placeholder="Search channels..."
                                          className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                                        <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
                                          {editSlackChannelsAvailable
                                            .filter((ch) => ch.name.toLowerCase().includes(editSlackChannelSearch.toLowerCase()))
                                            .map((ch) => {
                                              const selected = editSlackChannelIds.some((e) => e.id === ch.id);
                                              return (
                                                <label key={ch.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? "bg-blue-50" : ""}`}>
                                                  <input type="checkbox" checked={selected} onChange={() => toggleEditSlackChannel(ch)}
                                                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                                                  <span className="text-sm text-foreground flex-1">
                                                    <span className="font-medium">#{ch.name}</span>
                                                    {ch.isPrivate && <span className="ml-1 text-xs text-muted">(private)</span>}
                                                  </span>
                                                  <span className="text-xs text-muted">{ch.memberCount} members</span>
                                                </label>
                                              );
                                            })}
                                        </div>
                                      </>
                                    )}

                                    {/* Manual fallback */}
                                    {editSlackChannelsAvailable.length === 0 && !editSlackChannelManualMode && !editSlackChannelsLoading && (
                                      <p className="text-xs text-center">
                                        <button type="button" onClick={() => setEditSlackChannelManualMode(true)} className="text-blue-600 hover:text-blue-700 underline">
                                          Or enter a channel ID manually
                                        </button>
                                      </p>
                                    )}
                                    {editSlackChannelManualMode && (
                                      <div className="flex gap-2">
                                        <input type="text" value={editSlackChannelInput} onChange={(e) => setEditSlackChannelInput(e.target.value)}
                                          placeholder="Channel ID (e.g. C0123456789)"
                                          className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEditSlackChannelManual(); } }} />
                                        <button type="button" onClick={addEditSlackChannelManual} disabled={!editSlackChannelInput.trim()}
                                          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                                          Add
                                        </button>
                                      </div>
                                    )}

                                    {/* Selected channels (manual mode) */}
                                    {editSlackChannelIds.length > 0 && editSlackChannelsAvailable.length === 0 && (
                                      <div className="space-y-1">
                                        {editSlackChannelIds.map((entry, i) => (
                                          <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-2">
                                            <div className="flex items-center gap-2">
                                              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">#</span>
                                              <span className="text-sm font-mono text-foreground">{entry.label || entry.id}</span>
                                            </div>
                                            <button type="button" onClick={() => setEditSlackChannelIds((prev) => prev.filter((_, idx) => idx !== i))}
                                              className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {editSlackChannelIds.length === 0 && editSlackChannelsAvailable.length === 0 && !editSlackChannelsLoading && (
                                      <p className="text-xs text-muted text-center py-1">No channels selected yet.</p>
                                    )}

                                    {editSlackChannelsAvailable.length > 0 && editSlackChannelIds.length > 0 && (
                                      <p className="text-xs text-muted">{editSlackChannelIds.length} channel{editSlackChannelIds.length !== 1 ? "s" : ""} selected</p>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* User access */}
                              <div>
                                <label className="block text-xs font-medium text-muted mb-1">User Access</label>
                                <div className="space-y-2">
                                  <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${editSlackUserAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                                    <input type="radio" name="edit-slack-user" value="anyone" checked={editSlackUserAccess === "anyone"}
                                      onChange={() => setEditSlackUserAccess("anyone")}
                                      className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                                    <div>
                                      <span className="text-sm font-medium text-foreground">Anyone</span>
                                      <p className="text-xs text-muted mt-0.5">Messages from any user visible.</p>
                                    </div>
                                  </label>
                                  <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${editSlackUserAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                                    <input type="radio" name="edit-slack-user" value="specific" checked={editSlackUserAccess === "specific"}
                                      onChange={() => setEditSlackUserAccess("specific")}
                                      className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                                    <div>
                                      <span className="text-sm font-medium text-foreground">Only specific people</span>
                                      <p className="text-xs text-muted mt-0.5">Messages from all other users are filtered out.</p>
                                    </div>
                                  </label>
                                </div>

                                {editSlackUserAccess === "specific" && (
                                  <div className="mt-2 rounded-lg border border-border bg-gray-50 p-3 space-y-2">
                                    {/* Load from Slack button */}
                                    {editSlackUsersAvailable.length === 0 && !editSlackUserManualMode && (
                                      <button type="button" onClick={() => loadEditSlackUsers(policy.connectionId)} disabled={editSlackUsersLoading}
                                        className="w-full rounded-md border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                                        {editSlackUsersLoading ? "Loading users..." : "Load users from Slack"}
                                      </button>
                                    )}

                                    {/* Searchable user picker */}
                                    {editSlackUsersAvailable.length > 0 && (
                                      <>
                                        <input type="text" value={editSlackUserSearch} onChange={(e) => setEditSlackUserSearch(e.target.value)}
                                          placeholder="Search users..."
                                          className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                                        <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
                                          {editSlackUsersAvailable
                                            .filter((u) => !u.isBot)
                                            .filter((u) =>
                                              u.displayName.toLowerCase().includes(editSlackUserSearch.toLowerCase()) ||
                                              u.name.toLowerCase().includes(editSlackUserSearch.toLowerCase()),
                                            )
                                            .map((u) => {
                                              const selected = editSlackUserIds.some((e) => e.id === u.id);
                                              return (
                                                <label key={u.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? "bg-blue-50" : ""}`}>
                                                  <input type="checkbox" checked={selected} onChange={() => toggleEditSlackUser(u)}
                                                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                                                  <span className="text-sm text-foreground flex-1">
                                                    <span className="font-medium">{u.displayName}</span>
                                                    {u.displayName !== u.name && <span className="ml-1 text-xs text-muted">@{u.name}</span>}
                                                  </span>
                                                </label>
                                              );
                                            })}
                                        </div>
                                      </>
                                    )}

                                    {/* Manual fallback */}
                                    {editSlackUsersAvailable.length === 0 && !editSlackUserManualMode && !editSlackUsersLoading && (
                                      <p className="text-xs text-center">
                                        <button type="button" onClick={() => setEditSlackUserManualMode(true)} className="text-blue-600 hover:text-blue-700 underline">
                                          Or enter a member ID manually
                                        </button>
                                      </p>
                                    )}
                                    {editSlackUserManualMode && (
                                      <div className="flex gap-2">
                                        <input type="text" value={editSlackUserInput} onChange={(e) => setEditSlackUserInput(e.target.value)}
                                          placeholder="Member ID (e.g. U0123456789)"
                                          className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEditSlackUserManual(); } }} />
                                        <button type="button" onClick={addEditSlackUserManual} disabled={!editSlackUserInput.trim()}
                                          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                                          Add
                                        </button>
                                      </div>
                                    )}

                                    {/* Selected users (manual mode) */}
                                    {editSlackUserIds.length > 0 && editSlackUsersAvailable.length === 0 && (
                                      <div className="space-y-1">
                                        {editSlackUserIds.map((entry, i) => (
                                          <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-2">
                                            <div className="flex items-center gap-2">
                                              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                                                {(entry.label || entry.id).charAt(0).toUpperCase()}
                                              </span>
                                              <span className="text-sm font-mono text-foreground">{entry.label || entry.id}</span>
                                            </div>
                                            <button type="button" onClick={() => setEditSlackUserIds((prev) => prev.filter((_, idx) => idx !== i))}
                                              className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {editSlackUserIds.length === 0 && editSlackUsersAvailable.length === 0 && !editSlackUsersLoading && (
                                      <p className="text-xs text-muted text-center py-1">No users selected yet.</p>
                                    )}

                                    {editSlackUsersAvailable.length > 0 && editSlackUserIds.length > 0 && (
                                      <p className="text-xs text-muted">{editSlackUserIds.length} user{editSlackUserIds.length !== 1 ? "s" : ""} selected</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            </>
                          )}

                          <div className="flex gap-3">
                            <button
                              onClick={() => handleSave(policy.id)}
                              disabled={saving || editAllowedModels.length === 0}
                              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {saving ? "Saving..." : "Save"}
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* View mode - AgentHiFive design */
                      <div
                        key={policy.id}
                        ref={policy.id === highlightedId ? highlightedPolicyRef : null}
                        className={`rounded-lg border ${
                          policy.id === highlightedId
                            ? 'border-green-500 border-2 shadow-lg ring-2 ring-green-200'
                            : 'border-border'
                        } bg-white overflow-hidden hover:shadow-md hover:border-blue-400 transition-all`}
                      >
                        {/* Header with gradient background */}
                        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-4 pt-4 pb-3 -mb-1">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span className="text-2xl flex-shrink-0">🔐</span>
                              <div className="flex-1 min-w-0">
                                {(() => {
                                  const fullLabel = connectionLabel.replace(/\s*\([^)]*\)\s*$/, '');
                                  const parts = fullLabel.split(' - ');
                                  const serviceName = parts[0];
                                  const description = parts.slice(1).join(' - ');

                                  return (
                                    <>
                                      <div className="font-semibold text-sm text-foreground truncate">
                                        {serviceName}
                                      </div>
                                      {description && (
                                        <div className="text-xs text-gray-600 font-normal truncate">
                                          {description}
                                        </div>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            </div>
                            <div className="flex gap-1 flex-shrink-0 ml-2">
                              <button
                                onClick={() => startEdit(policy)}
                                className="rounded border border-border bg-white px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-gray-50"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => setDeleteTarget(policy)}
                                className="rounded border border-red-200 bg-white px-2 py-0.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
                              >
                                Del
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Card body */}
                        <div className="px-4 pb-4 pt-3">
                          {/* Key badges */}
                          <div className="mb-3 flex flex-wrap gap-1.5">
                            {/* Model badges */}
                            {policy.allowedModels.map((model, idx) => {
                              const modelLabel = model === "A" ? "Temp Access" : "Protected";
                              const modelTooltip = model === "A"
                                ? "Agent receives temporary access tokens for direct API calls"
                                : "All API calls routed through AgentHiFive proxy, agent never sees credentials";
                              return (
                                <span
                                  key={`model-${idx}`}
                                  className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 cursor-help"
                                  title={modelTooltip}
                                >
                                  {modelLabel}
                                </span>
                              );
                            })}
                            {/* Access mode badge */}
                            <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                              policy.defaultMode === "read_only"
                                ? "bg-green-100 text-green-700"
                                : policy.defaultMode === "read_write" || policy.defaultMode === "write_allowed"
                                ? "bg-yellow-100 text-yellow-700"
                                : "bg-red-100 text-red-700"
                            }`}>
                              {MODE_LABELS[policy.defaultMode] ?? policy.defaultMode}
                            </span>
                            {/* Approval badge */}
                            <span
                              className="inline-flex items-center rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 cursor-help"
                              title={
                                policy.stepUpApproval === "always"
                                  ? "Every write operation requires your explicit approval"
                                  : policy.stepUpApproval === "risk_based"
                                  ? "Sensitive write operations require approval, routine writes auto-approved"
                                  : "All write operations are automatically approved"
                              }
                            >
                              {policy.stepUpApproval === "always" ? "Approval: Always" :
                               policy.stepUpApproval === "risk_based" ? "Approval: Risk-Based" : "Approval: Auto"}
                            </span>
                          </div>

                          {/* Access Controls section */}
                          <div className="mb-3 border-t border-border pt-3">
                            <h5 className="text-xs font-semibold text-foreground mb-2">Access Controls</h5>
                            <div className="space-y-2">
                            {/* Allowlists */}
                            <div>
                              <div className="flex items-center justify-between">
                                <h5 className="text-xs font-medium text-foreground">
                                  Allowlists ({policy.allowlists.length} {policy.allowlists.length === 1 ? "rule" : "rules"})
                                </h5>
                                <button
                                  onClick={() => startAllowlistEdit(policy)}
                                  className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                                  title={policy.allowlists.length > 0 ? "Edit allowlists" : "Configure allowlists"}
                                >
                                  {policy.allowlists.length > 0 ? (
                                    "Edit"
                                  ) : (
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                              {policy.allowlists.length > 0 ? (
                                <div className="mt-1 space-y-1">
                                  {policy.allowlists.slice(0, 2).map((entry, idx) => (
                                    <div key={idx} className="rounded bg-gray-50 px-2 py-1 text-xs text-muted font-mono truncate">
                                      <span className="text-foreground">{entry.methods.join(", ")}</span> {entry.pathPatterns.join(", ")} @ {entry.baseUrl}
                                    </div>
                                  ))}
                                  {policy.allowlists.length > 2 && (
                                    <div className="text-xs text-muted">
                                      +{policy.allowlists.length - 2} more
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="mt-1 text-xs text-muted">No allowlists configured</p>
                              )}
                            </div>

                            {/* Rate limits */}
                            <div>
                              <div className="flex items-center justify-between">
                                <h5 className="text-xs font-medium text-foreground">Rate Limits</h5>
                                <button
                                  onClick={() => startRateLimitEdit(policy)}
                                  className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                                  title={policy.rateLimits ? "Edit rate limits" : "Configure rate limits"}
                                >
                                  {policy.rateLimits ? (
                                    "Edit"
                                  ) : (
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                              {policy.rateLimits ? (
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                  <span className="inline-flex items-center rounded bg-orange-50 px-2 py-0.5 text-xs text-orange-700">
                                    {policy.rateLimits.maxRequestsPerHour} req/hour
                                  </span>
                                  {policy.rateLimits.maxPayloadSizeBytes && (
                                    <span className="inline-flex items-center rounded bg-orange-50 px-2 py-0.5 text-xs text-orange-700">
                                      Payload: {formatBytes(policy.rateLimits.maxPayloadSizeBytes)}
                                    </span>
                                  )}
                                  {policy.rateLimits.maxResponseSizeBytes && (
                                    <span className="inline-flex items-center rounded bg-orange-50 px-2 py-0.5 text-xs text-orange-700">
                                      Response: {formatBytes(policy.rateLimits.maxResponseSizeBytes)}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <p className="mt-1 text-xs text-muted">No rate limits configured</p>
                              )}
                            </div>

                            {/* Time windows (hidden for Telegram and LLM providers) */}
                            {connectionProvider !== "telegram" && !LLM_PROVIDERS.has(connectionProvider) && (
                            <div>
                              <div className="flex items-center justify-between">
                                <h5 className="text-xs font-medium text-foreground">
                                  Time Windows ({policy.timeWindows.length} {policy.timeWindows.length === 1 ? "window" : "windows"})
                                </h5>
                                <button
                                  onClick={() => startTimeWindowEdit(policy)}
                                  className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                                  title={policy.timeWindows.length > 0 ? "Edit time windows" : "Configure time windows"}
                                >
                                  {policy.timeWindows.length > 0 ? (
                                    "Edit"
                                  ) : (
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                              {policy.timeWindows.length > 0 ? (
                                <div className="mt-1 space-y-1">
                                  {policy.timeWindows.slice(0, 2).map((tw, idx) => (
                                    <div key={idx} className="rounded bg-gray-50 px-2 py-1 text-xs text-muted">
                                      <span className="text-foreground font-medium">{DAY_SHORT[tw.dayOfWeek]}</span> {tw.startHour.toString().padStart(2, "0")}:00 - {tw.endHour.toString().padStart(2, "0")}:00 {tw.timezone}
                                    </div>
                                  ))}
                                  {policy.timeWindows.length > 2 && (
                                    <div className="text-xs text-muted">
                                      +{policy.timeWindows.length - 2} more
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="mt-1 text-xs text-muted">No time windows configured</p>
                              )}
                            </div>
                            )}
                            {/* Telegram Recipients (only for Telegram connections) */}
                            {connection?.provider === "telegram" && (
                            <div>
                              <div className="flex items-center justify-between">
                                <h5 className="text-xs font-medium text-foreground">
                                  Telegram Recipients{policy.providerConstraints?.allowedChatIds?.length ? ` (${policy.providerConstraints.allowedChatIds.length})` : ""}
                                </h5>
                                <button
                                  onClick={() => startTgUsersEdit(policy)}
                                  className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                                  title={policy.providerConstraints?.allowedChatIds?.length ? "Edit trusted recipients" : "Add trusted recipients"}
                                >
                                  {policy.providerConstraints?.allowedChatIds?.length ? (
                                    "Edit"
                                  ) : (
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                              {policy.providerConstraints?.allowedChatIds?.length ? (
                                <div className="mt-1 space-y-1">
                                  {policy.providerConstraints.allowedChatIds.slice(0, 3).map((chatId, idx) => (
                                    <div key={idx} className="rounded bg-gray-50 px-2 py-1 text-xs text-muted font-mono">
                                      {chatId}
                                    </div>
                                  ))}
                                  {policy.providerConstraints.allowedChatIds.length > 3 && (
                                    <div className="text-xs text-muted">
                                      +{policy.providerConstraints.allowedChatIds.length - 3} more
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="mt-1 text-xs text-muted">All users can message this agent</p>
                              )}
                            </div>
                            )}
                            {/* Slack Channels/Users (only for Slack connections) */}
                            {connection?.provider === "slack" && (
                            <div>
                              <div className="flex items-center justify-between">
                                <h5 className="text-xs font-medium text-foreground">
                                  Slack Access{(policy.providerConstraints?.allowedChannelIds?.length || policy.providerConstraints?.allowedUserIds?.length) ? ` (${(policy.providerConstraints.allowedChannelIds?.length || 0) + (policy.providerConstraints.allowedUserIds?.length || 0)})` : ""}
                                </h5>
                                <button
                                  onClick={() => {
                                    setSlackEditId(policy.id);
                                    setSlackEditConnectionId(policy.connectionId);
                                    setSlackChannelEntries(policy.providerConstraints?.allowedChannelIds ?? []);
                                    setSlackUserEntries(policy.providerConstraints?.allowedUserIds ?? []);
                                    setSlackChannelEditInput("");
                                    setSlackUserEditInput("");
                                    setSlackEditChannelsAvailable([]);
                                    setSlackEditChannelSearch("");
                                    setSlackEditChannelManualMode(false);
                                    setSlackEditUsersAvailable([]);
                                    setSlackEditUserSearch("");
                                    setSlackEditUserManualMode(false);
                                  }}
                                  className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                                  title={(policy.providerConstraints?.allowedChannelIds?.length || policy.providerConstraints?.allowedUserIds?.length) ? "Edit Slack access" : "Add Slack access restrictions"}
                                >
                                  {(policy.providerConstraints?.allowedChannelIds?.length || policy.providerConstraints?.allowedUserIds?.length) ? (
                                    "Edit"
                                  ) : (
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                              {(policy.providerConstraints?.allowedChannelIds?.length || policy.providerConstraints?.allowedUserIds?.length) ? (
                                <div className="mt-1 space-y-1">
                                  {policy.providerConstraints!.allowedChannelIds?.slice(0, 2).map((id, idx) => (
                                    <div key={`ch-${idx}`} className="rounded bg-gray-50 px-2 py-1 text-xs text-muted font-mono">
                                      # {id}
                                    </div>
                                  ))}
                                  {policy.providerConstraints!.allowedUserIds?.slice(0, 2).map((id, idx) => (
                                    <div key={`u-${idx}`} className="rounded bg-gray-50 px-2 py-1 text-xs text-muted font-mono">
                                      @ {id}
                                    </div>
                                  ))}
                                  {((policy.providerConstraints!.allowedChannelIds?.length || 0) + (policy.providerConstraints!.allowedUserIds?.length || 0)) > 4 && (
                                    <div className="text-xs text-muted">
                                      +{(policy.providerConstraints!.allowedChannelIds?.length || 0) + (policy.providerConstraints!.allowedUserIds?.length || 0) - 4} more
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="mt-1 text-xs text-muted">All channels and users allowed</p>
                              )}
                            </div>
                            )}
                            </div>
                          </div>

                          {/* Security Rules section */}
                          <div className="mb-3 border-t border-border pt-3">
                            <div className="flex items-center justify-between">
                              <h5 className="text-xs font-semibold text-foreground">Security Rules</h5>
                              <button
                                onClick={() => startRulesEdit(policy)}
                                className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                                title={(policy.rules?.request?.length || policy.rules?.response?.length) ? "Edit rules" : "Configure rules"}
                              >
                                {(policy.rules?.request?.length || policy.rules?.response?.length) ? (
                                  "Edit"
                                ) : (
                                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                                  </svg>
                                )}
                              </button>
                            </div>
                            {(policy.rules?.request?.length || policy.rules?.response?.length) ? (
                              <div className="mt-1 space-y-1">
                                {/* Request rules summary */}
                                {policy.rules.request.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {policy.rules.request.slice(0, 3).map((rule, idx) => (
                                      <span
                                        key={idx}
                                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${ACTION_LABELS[rule.action]?.color ?? "bg-gray-100 text-gray-700"}`}
                                        title={rule.label || `${rule.action}: ${rule.match.methods?.join(",")} ${rule.match.urlPattern || "*"}`}
                                      >
                                        {rule.label || rule.action}
                                      </span>
                                    ))}
                                    {policy.rules.request.length > 3 && (
                                      <span className="text-xs text-muted">+{policy.rules.request.length - 3} more</span>
                                    )}
                                  </div>
                                )}
                                {/* Response rules summary */}
                                {policy.rules.response.length > 0 && (
                                  <div className="text-xs text-muted">
                                    {policy.rules.response.length} response {policy.rules.response.length === 1 ? "filter" : "filters"}
                                    {policy.rules.response.some((r) => r.filter.redact?.length) && " (personal information redaction)"}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="mt-1 text-xs text-muted">No rules configured</p>
                            )}
                          </div>

                          {/* Metadata */}
                          <div className="text-xs text-muted border-t border-border pt-3">
                            <div>
                              Created {new Date(policy.createdAt).toLocaleString(undefined, {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </div>
                            <div className="font-mono text-xs mt-1">ID: {policy.id}</div>
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
      </div>

      {/* Allowlist Editor Dialog */}
      {allowlistEditId && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12">
          <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Edit Allowlists</h3>
            <p className="mt-1 text-sm text-muted">
              Define which API endpoints this agent can access through Model B. Requests not matching any allowlist rule are denied.
            </p>

            {/* Template loader */}
            {templates.length > 0 && (
              <div className="mt-4">
                <button
                  onClick={() => setShowTemplates(!showTemplates)}
                  className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  {showTemplates ? "Hide Templates" : "Load from Templates"}
                  <span className="text-xs text-muted">({templates.length} available)</span>
                </button>
                {showTemplates && (
                  <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-medium text-foreground">Available Templates</h4>
                      <button
                        onClick={applyAllTemplates}
                        className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                      >
                        Apply All
                      </button>
                    </div>
                    <div className="space-y-2">
                      {templates.map((template) => (
                        <div
                          key={template.id}
                          className="flex items-center justify-between rounded-md border border-blue-100 bg-white p-3"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {template.name}
                              </span>
                              {template.sensitive && (
                                <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
                                  Sensitive
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-xs text-muted">
                              {template.description}
                            </p>
                            <div className="mt-1 text-xs text-muted font-mono">
                              {template.allowlists.map((a, i) => (
                                <span key={i}>
                                  {a.methods.join(", ")} {a.pathPatterns.join(", ")}
                                  {i < template.allowlists.length - 1 ? " | " : ""}
                                </span>
                              ))}
                            </div>
                          </div>
                          <button
                            onClick={() => applyTemplate(template)}
                            className="ml-3 shrink-0 rounded-md border border-blue-300 px-3 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100"
                          >
                            Apply
                          </button>
                        </div>
                      ))}
                    </div>
                    {templates.some((t) => t.sensitive) && (
                      <p className="mt-3 text-xs text-yellow-700">
                        Templates marked as &quot;Sensitive&quot; involve write operations. Consider using &quot;Risk-Based&quot; or &quot;Always&quot; step-up approval for policies with these templates.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
            {templatesLoading && (
              <p className="mt-4 text-xs text-muted">Loading templates...</p>
            )}

            <div className="mt-4 space-y-4">
              {allowlistEntries.map((entry, idx) => (
                <div key={idx} className="rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-foreground">Rule {idx + 1}</h4>
                    <button
                      onClick={() => removeAllowlistEntry(idx)}
                      className="text-xs text-red-600 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </div>

                  {/* Base URL */}
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-muted">
                      Base URL (HTTPS required)
                    </label>
                    <input
                      type="url"
                      value={entry.baseUrl}
                      onChange={(e) => updateAllowlistEntry(idx, "baseUrl", e.target.value)}
                      placeholder="https://www.googleapis.com"
                      className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    />
                  </div>

                  {/* HTTP Methods */}
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-muted">HTTP Methods</label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {HTTP_METHODS.map((method) => (
                        <label key={method} className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={entry.methods.includes(method)}
                            onChange={() => toggleAllowlistMethod(idx, method)}
                            className="h-3.5 w-3.5 rounded border-border text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-xs text-foreground font-mono">{method}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Path Patterns */}
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-muted">
                      Path Patterns (use * for wildcards)
                    </label>
                    <div className="mt-1 space-y-2">
                      {entry.pathPatterns.map((pattern, pi) => (
                        <div key={pi} className="flex gap-2">
                          <input
                            type="text"
                            value={pattern}
                            onChange={(e) => updatePathPattern(idx, pi, e.target.value)}
                            placeholder="/users/me/messages/*"
                            className="block flex-1 rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                          />
                          {entry.pathPatterns.length > 1 && (
                            <button
                              onClick={() => removePathPattern(idx, pi)}
                              className="px-2 text-xs text-red-600 hover:text-red-700"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={() => addPathPattern(idx)}
                        className="text-xs font-medium text-blue-600 hover:text-blue-700"
                      >
                        + Add path pattern
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              <button
                onClick={addAllowlistEntry}
                className="w-full rounded-md border border-dashed border-border py-2 text-sm font-medium text-muted transition-colors hover:border-blue-500 hover:text-blue-600"
              >
                + Add Allowlist Rule
              </button>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setAllowlistEditId(null)}
                disabled={savingAllowlists}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveAllowlists(allowlistEditId)}
                disabled={savingAllowlists}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {savingAllowlists ? "Saving..." : "Save Allowlists"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rate Limits Editor Dialog */}
      {rateLimitEditId && rateLimitValues && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Edit Rate Limits</h3>
            <p className="mt-1 text-sm text-muted">
              Configure request rate limits and payload size constraints for this policy.
            </p>

            <div className="mt-4 space-y-4">
              {/* Max requests per hour */}
              <div>
                <label className="block text-sm font-medium text-foreground">
                  Max Requests Per Hour <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={rateLimitValues.maxRequestsPerHour}
                  onChange={(e) =>
                    setRateLimitValues((prev) =>
                      prev ? { ...prev, maxRequestsPerHour: parseInt(e.target.value) || 1 } : prev,
                    )
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* Max payload size */}
              <div>
                <label className="block text-sm font-medium text-foreground">
                  Max Payload Size (bytes)
                </label>
                <p className="text-xs text-muted">Maximum request body size. Leave empty for default (10 MB).</p>
                <input
                  type="number"
                  min="1"
                  value={rateLimitValues.maxPayloadSizeBytes ?? ""}
                  onChange={(e) => {
                    const val = e.target.value ? parseInt(e.target.value) : null;
                    setRateLimitValues((prev) => {
                      if (!prev) return prev;
                      const next = { ...prev };
                      if (val) {
                        next.maxPayloadSizeBytes = val;
                      } else {
                        delete next.maxPayloadSizeBytes;
                      }
                      return next;
                    });
                  }}
                  placeholder="10485760"
                  className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {rateLimitValues.maxPayloadSizeBytes && (
                  <p className="mt-1 text-xs text-muted">{formatBytes(rateLimitValues.maxPayloadSizeBytes)}</p>
                )}
              </div>

              {/* Max response size */}
              <div>
                <label className="block text-sm font-medium text-foreground">
                  Max Response Size (bytes)
                </label>
                <p className="text-xs text-muted">Maximum response body size. Leave empty for default (10 MB).</p>
                <input
                  type="number"
                  min="1"
                  value={rateLimitValues.maxResponseSizeBytes ?? ""}
                  onChange={(e) => {
                    const val = e.target.value ? parseInt(e.target.value) : null;
                    setRateLimitValues((prev) => {
                      if (!prev) return prev;
                      const next = { ...prev };
                      if (val) {
                        next.maxResponseSizeBytes = val;
                      } else {
                        delete next.maxResponseSizeBytes;
                      }
                      return next;
                    });
                  }}
                  placeholder="10485760"
                  className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {rateLimitValues.maxResponseSizeBytes && (
                  <p className="mt-1 text-xs text-muted">{formatBytes(rateLimitValues.maxResponseSizeBytes)}</p>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-between">
              <button
                onClick={() => handleClearRateLimits(rateLimitEditId)}
                disabled={savingRateLimits}
                className="rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
              >
                Remove Limits
              </button>
              <div className="flex gap-3">
                <button
                  onClick={() => setRateLimitEditId(null)}
                  disabled={savingRateLimits}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleSaveRateLimits(rateLimitEditId)}
                  disabled={savingRateLimits || !rateLimitValues.maxRequestsPerHour}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingRateLimits ? "Saving..." : "Save Limits"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Time Windows Editor Dialog */}
      {timeWindowEditId && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12">
          <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Edit Time Windows</h3>
            <p className="mt-1 text-sm text-muted">
              Define when the agent is allowed to access this connection. Execution outside these windows will be blocked.
              Leave empty to allow access at any time.
            </p>

            <div className="mt-4 space-y-4">
              {timeWindowEntries.map((entry, idx) => (
                <div key={idx} className="rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-foreground">Window {idx + 1}</h4>
                    <button
                      onClick={() => removeTimeWindowEntry(idx)}
                      className="text-xs text-red-600 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </div>

                  {/* Day of week */}
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-muted">Day of Week</label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {DAY_NAMES.map((day, dayIdx) => (
                        <label key={day} className="flex items-center gap-1.5">
                          <input
                            type="radio"
                            name={`tw-day-${idx}`}
                            checked={entry.dayOfWeek === dayIdx}
                            onChange={() => updateTimeWindowEntry(idx, "dayOfWeek", dayIdx)}
                            className="h-3.5 w-3.5 border-border text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-xs text-foreground">{DAY_SHORT[dayIdx]}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Hour range */}
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-muted">Start Hour</label>
                      <select
                        value={entry.startHour}
                        onChange={(e) => updateTimeWindowEntry(idx, "startHour", parseInt(e.target.value))}
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h}>
                            {formatHour(h)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted">End Hour</label>
                      <select
                        value={entry.endHour}
                        onChange={(e) => updateTimeWindowEntry(idx, "endHour", parseInt(e.target.value))}
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h}>
                            {formatHour(h)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Timezone */}
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-muted">Timezone</label>
                    <input
                      type="text"
                      value={entry.timezone}
                      onChange={(e) => updateTimeWindowEntry(idx, "timezone", e.target.value)}
                      placeholder="America/New_York"
                      className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    />
                    <p className="mt-0.5 text-xs text-muted">
                      IANA timezone (e.g., America/New_York, Europe/London, Asia/Tokyo)
                    </p>
                  </div>

                  {/* Summary */}
                  <div className="mt-3 rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">
                    {DAY_NAMES[entry.dayOfWeek]} {formatHour(entry.startHour)} - {formatHour(entry.endHour)} ({entry.timezone})
                  </div>
                </div>
              ))}

              <button
                onClick={addTimeWindowEntry}
                className="w-full rounded-md border border-dashed border-border py-2 text-sm font-medium text-muted transition-colors hover:border-blue-500 hover:text-blue-600"
              >
                + Add Time Window
              </button>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setTimeWindowEditId(null)}
                disabled={savingTimeWindows}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveTimeWindows(timeWindowEditId)}
                disabled={savingTimeWindows}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {savingTimeWindows ? "Saving..." : "Save Time Windows"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full-Screen Rule Builder Modal */}
      {rulesEditId && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          {/* Modal header */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Security Rules</h2>
              <p className="text-sm text-muted">
                Configure request and response rules for this policy. Rules are evaluated top-to-bottom (first match wins).
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setRulesEditId(null)}
                disabled={savingRules}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveRules(rulesEditId)}
                disabled={savingRules}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {savingRules ? "Saving..." : "Save Rules"}
              </button>
            </div>
          </div>

          {/* Preset selector + template picker */}
          <div className="border-b border-border px-6 py-3">
            <div className="flex items-center gap-4">
              {/* Presets */}
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">Presets:</span>
                {rulePresetsLoading ? (
                  <span className="text-xs text-muted">Loading...</span>
                ) : (
                  <div className="flex gap-1.5">
                    {rulePresets.map((preset) => (
                      <button
                        key={preset.id}
                        onClick={() => applyRulePreset(preset)}
                        className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-blue-50 hover:border-blue-300"
                        title={preset.description}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="h-5 w-px bg-border" />

              {/* Template picker toggle */}
              <button
                onClick={() => setShowRuleTemplates(!showRuleTemplates)}
                className="flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                {showRuleTemplates ? "Hide Templates" : "Add from Templates"}
                {ruleTemplates.length > 0 && (
                  <span className="text-xs text-muted">({ruleTemplates.length})</span>
                )}
              </button>
            </div>

            {/* Template picker (collapsible) */}
            {showRuleTemplates && ruleTemplates.length > 0 && (
              <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-4">
                <h4 className="text-sm font-medium text-foreground mb-2">Rule Templates</h4>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {ruleTemplates.map((template) => (
                    <div
                      key={template.id}
                      className="flex items-center justify-between rounded-md border border-blue-100 bg-white p-3"
                    >
                      <div className="flex-1 min-w-0 mr-2">
                        <div className="text-sm font-medium text-foreground truncate">
                          {template.name}
                        </div>
                        <p className="text-xs text-muted truncate">{template.description}</p>
                        <div className="mt-1 flex gap-1">
                          {template.requestRules.length > 0 && (
                            <span className="text-xs text-muted">{template.requestRules.length} req</span>
                          )}
                          {template.responseRules.length > 0 && (
                            <span className="text-xs text-muted">{template.responseRules.length} res</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => applyRuleTemplate(template)}
                        className="shrink-0 rounded-md border border-blue-300 px-2 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100"
                      >
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="border-b border-border px-6">
            <div className="flex gap-4">
              <button
                onClick={() => setRulesActiveTab("request")}
                className={`border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                  rulesActiveTab === "request"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                Request Rules ({editRequestRules.length})
              </button>
              <button
                onClick={() => setRulesActiveTab("response")}
                className={`border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
                  rulesActiveTab === "response"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                Response Rules ({editResponseRules.length})
              </button>
            </div>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {rulesActiveTab === "request" ? (
              /* ── Request Rules Tab ── */
              <div className="space-y-4 max-w-4xl">
                <p className="text-sm text-muted">
                  Request rules control which API requests the agent can make. Rules are evaluated top-to-bottom — the first matching rule decides the action. Unmatched requests fall back to the policy&apos;s step-up approval setting.
                </p>

                {editRequestRules.map((rule, idx) => (
                  <div key={idx} className="rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted">#{idx + 1}</span>
                        <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${ACTION_LABELS[rule.action]?.color ?? "bg-gray-100 text-gray-700"}`}>
                          {ACTION_LABELS[rule.action]?.label ?? rule.action}
                        </span>
                      </div>
                      <button
                        onClick={() => removeRequestRule(idx)}
                        className="text-xs text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </div>

                    {/* Label */}
                    <div className="mb-3">
                      <label className="block text-xs font-medium text-muted">Label</label>
                      <input
                        type="text"
                        value={rule.label ?? ""}
                        onChange={(e) =>
                          updateRequestRule(idx, (r) => ({ ...r, label: e.target.value }))
                        }
                        placeholder="e.g., Allow reading emails"
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      {/* Methods */}
                      <div>
                        <label className="block text-xs font-medium text-muted">HTTP Methods</label>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {HTTP_METHODS.map((method) => (
                            <label key={method} className="flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                checked={rule.match.methods?.includes(method) ?? false}
                                onChange={() =>
                                  updateRequestRule(idx, (r) => {
                                    const methods = r.match.methods ?? [];
                                    const next = methods.includes(method)
                                      ? methods.filter((m) => m !== method)
                                      : [...methods, method];
                                    return { ...r, match: { ...r.match, methods: next } };
                                  })
                                }
                                className="h-3.5 w-3.5 rounded border-border text-blue-600 focus:ring-blue-500"
                              />
                              <span className="text-xs text-foreground font-mono">{method}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      {/* Action */}
                      <div>
                        <label className="block text-xs font-medium text-muted">Action</label>
                        <select
                          value={rule.action}
                          onChange={(e) =>
                            updateRequestRule(idx, (r) => ({
                              ...r,
                              action: e.target.value as RequestRule["action"],
                            }))
                          }
                          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="allow">Allow</option>
                          <option value="deny">Deny</option>
                          <option value="require_approval">Require Approval</option>
                        </select>
                      </div>
                    </div>

                    {/* URL Pattern */}
                    <div className="mt-3">
                      <label className="block text-xs font-medium text-muted">
                        URL Pattern (regex, optional)
                      </label>
                      <input
                        type="text"
                        value={rule.match.urlPattern ?? ""}
                        onChange={(e) =>
                          updateRequestRule(idx, (r) => ({
                            ...r,
                            match: { ...r.match, urlPattern: e.target.value },
                          }))
                        }
                        placeholder="e.g., ^/gmail/v1/users/me/messages"
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                      />
                    </div>

                    {/* Body conditions */}
                    <div className="mt-3">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-medium text-muted">Body Conditions</label>
                        <button
                          onClick={() =>
                            updateRequestRule(idx, (r) => ({
                              ...r,
                              match: {
                                ...r.match,
                                body: [...(r.match.body ?? []), { path: "", op: "eq", value: "" }],
                              },
                            }))
                          }
                          className="text-xs font-medium text-blue-600 hover:text-blue-700"
                        >
                          + Add
                        </button>
                      </div>
                      {rule.match.body?.map((cond, ci) => (
                        <div key={ci} className="mt-1 flex gap-2 items-center">
                          <input
                            type="text"
                            value={cond.path}
                            onChange={(e) =>
                              updateRequestRule(idx, (r) => {
                                const body = [...(r.match.body ?? [])];
                                const cur = body[ci]!;
                                const next: BodyCondition = { path: e.target.value, op: cur.op };
                                if (cur.value !== undefined) next.value = cur.value;
                                body[ci] = next;
                                return { ...r, match: { ...r.match, body } };
                              })
                            }
                            placeholder="path"
                            className="w-28 rounded-md border border-border bg-white px-2 py-1 text-xs text-foreground font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <select
                            value={cond.op}
                            onChange={(e) =>
                              updateRequestRule(idx, (r) => {
                                const body = [...(r.match.body ?? [])];
                                const cur = body[ci]!;
                                const next: BodyCondition = { path: cur.path, op: e.target.value };
                                if (cur.value !== undefined) next.value = cur.value;
                                body[ci] = next;
                                return { ...r, match: { ...r.match, body } };
                              })
                            }
                            className="w-24 rounded-md border border-border bg-white px-2 py-1 text-xs text-foreground focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          >
                            {BODY_OPS.map((op) => (
                              <option key={op} value={op}>{op}</option>
                            ))}
                          </select>
                          {cond.op !== "exists" && (
                            <input
                              type="text"
                              value={String(cond.value ?? "")}
                              onChange={(e) =>
                                updateRequestRule(idx, (r) => {
                                  const body = [...(r.match.body ?? [])];
                                  const cur = body[ci]!;
                                  body[ci] = { path: cur.path, op: cur.op, value: e.target.value };
                                  return { ...r, match: { ...r.match, body } };
                                })
                              }
                              placeholder="value"
                              className="flex-1 rounded-md border border-border bg-white px-2 py-1 text-xs text-foreground font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          )}
                          <button
                            onClick={() =>
                              updateRequestRule(idx, (r) => {
                                const filtered = r.match.body?.filter((_, j) => j !== ci) ?? [];
                                const match = { ...r.match };
                                if (filtered.length > 0) {
                                  match.body = filtered;
                                } else {
                                  delete match.body;
                                }
                                return { ...r, match };
                              })
                            }
                            className="text-xs text-red-600 hover:text-red-700"
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                <button
                  onClick={addRequestRule}
                  className="w-full rounded-md border border-dashed border-border py-3 text-sm font-medium text-muted transition-colors hover:border-blue-500 hover:text-blue-600"
                >
                  + Add Request Rule
                </button>
              </div>
            ) : (
              /* ── Response Rules Tab ── */
              <div className="space-y-4 max-w-4xl">
                <p className="text-sm text-muted">
                  Response rules filter API responses before returning them to the agent. Use field filtering to strip sensitive data and PII redaction to mask personal information.
                </p>

                {editResponseRules.map((rule, idx) => (
                  <div key={idx} className="rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-mono text-muted">#{idx + 1}</span>
                      <button
                        onClick={() => removeResponseRule(idx)}
                        className="text-xs text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </div>

                    {/* Label */}
                    <div className="mb-3">
                      <label className="block text-xs font-medium text-muted">Label</label>
                      <input
                        type="text"
                        value={rule.label ?? ""}
                        onChange={(e) =>
                          updateResponseRule(idx, (r) => ({ ...r, label: e.target.value }))
                        }
                        placeholder="e.g., Redact PII from responses"
                        className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>

                    {/* Match */}
                    <div className="grid grid-cols-2 gap-4 mb-3">
                      <div>
                        <label className="block text-xs font-medium text-muted">
                          URL Pattern (regex, optional)
                        </label>
                        <input
                          type="text"
                          value={rule.match.urlPattern ?? ""}
                          onChange={(e) =>
                            updateResponseRule(idx, (r) => ({
                              ...r,
                              match: { ...r.match, urlPattern: e.target.value },
                            }))
                          }
                          placeholder="e.g., /v1\\.0/users"
                          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted">HTTP Methods (optional)</label>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {HTTP_METHODS.map((method) => (
                            <label key={method} className="flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                checked={rule.match.methods?.includes(method) ?? false}
                                onChange={() =>
                                  updateResponseRule(idx, (r) => {
                                    const methods = r.match.methods ?? [];
                                    const next = methods.includes(method)
                                      ? methods.filter((m) => m !== method)
                                      : [...methods, method];
                                    return { ...r, match: { ...r.match, methods: next } };
                                  })
                                }
                                className="h-3.5 w-3.5 rounded border-border text-blue-600 focus:ring-blue-500"
                              />
                              <span className="text-xs text-foreground font-mono">{method}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Filter: Allow/Deny Fields */}
                    <div className="grid grid-cols-2 gap-4 mb-3">
                      <div>
                        <label className="block text-xs font-medium text-muted">
                          Allow Fields (whitelist, comma-separated)
                        </label>
                        <input
                          type="text"
                          value={rule.filter.allowFields?.join(", ") ?? ""}
                          onChange={(e) => {
                            const fields = e.target.value
                              .split(",")
                              .map((f) => f.trim())
                              .filter((f) => f.length > 0);
                            updateResponseRule(idx, (r) => {
                              const filter = { ...r.filter };
                              if (fields.length > 0) {
                                filter.allowFields = fields;
                              } else {
                                delete filter.allowFields;
                              }
                              return { ...r, filter };
                            });
                          }}
                          placeholder="id, name, email"
                          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted">
                          Deny Fields (blacklist, comma-separated)
                        </label>
                        <input
                          type="text"
                          value={rule.filter.denyFields?.join(", ") ?? ""}
                          onChange={(e) => {
                            const fields = e.target.value
                              .split(",")
                              .map((f) => f.trim())
                              .filter((f) => f.length > 0);
                            updateResponseRule(idx, (r) => {
                              const filter = { ...r.filter };
                              if (fields.length > 0) {
                                filter.denyFields = fields;
                              } else {
                                delete filter.denyFields;
                              }
                              return { ...r, filter };
                            });
                          }}
                          placeholder="phoneNumbers, addresses"
                          className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                        />
                      </div>
                    </div>

                    {/* PII Redaction */}
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-medium text-muted">PII Redaction Patterns</label>
                        <button
                          onClick={() =>
                            updateResponseRule(idx, (r) => ({
                              ...r,
                              filter: {
                                ...r.filter,
                                redact: [...(r.filter.redact ?? []), { type: "email" }],
                              },
                            }))
                          }
                          className="text-xs font-medium text-blue-600 hover:text-blue-700"
                        >
                          + Add
                        </button>
                      </div>
                      {rule.filter.redact?.map((pattern, pi) => (
                        <div key={pi} className="mt-1 flex gap-2 items-center">
                          <select
                            value={pattern.type}
                            onChange={(e) =>
                              updateResponseRule(idx, (r) => {
                                const redact = [...(r.filter.redact ?? [])];
                                const cur = redact[pi]!;
                                const next: RedactPattern = { type: e.target.value };
                                if (cur.pattern) next.pattern = cur.pattern;
                                redact[pi] = next;
                                return { ...r, filter: { ...r.filter, redact } };
                              })
                            }
                            className="w-32 rounded-md border border-border bg-white px-2 py-1 text-xs text-foreground focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          >
                            {REDACT_TYPES.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                          {pattern.type === "custom" && (
                            <input
                              type="text"
                              value={pattern.pattern ?? ""}
                              onChange={(e) =>
                                updateResponseRule(idx, (r) => {
                                  const redact = [...(r.filter.redact ?? [])];
                                  redact[pi] = { type: redact[pi]!.type, pattern: e.target.value };
                                  return { ...r, filter: { ...r.filter, redact } };
                                })
                              }
                              placeholder="regex pattern"
                              className="flex-1 rounded-md border border-border bg-white px-2 py-1 text-xs text-foreground font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          )}
                          <button
                            onClick={() =>
                              updateResponseRule(idx, (r) => {
                                const filtered = r.filter.redact?.filter((_, j) => j !== pi) ?? [];
                                const filter = { ...r.filter };
                                if (filtered.length > 0) {
                                  filter.redact = filtered;
                                } else {
                                  delete filter.redact;
                                }
                                return { ...r, filter };
                              })
                            }
                            className="text-xs text-red-600 hover:text-red-700"
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                <button
                  onClick={addResponseRule}
                  className="w-full rounded-md border border-dashed border-border py-3 text-sm font-medium text-muted transition-colors hover:border-blue-500 hover:text-blue-600"
                >
                  + Add Response Rule
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Telegram Users Editor Dialog */}
      {tgUsersEditId && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12">
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Manage Telegram Recipients</h3>
            <p className="mt-1 text-sm text-muted">
              Control which Telegram users can interact with this agent — both sending and receiving. When no users are listed, anyone can message the agent. Add user IDs to restrict access.
            </p>

            {/* Add user input */}
            <div className="mt-4 flex gap-2">
              <input
                type="text"
                value={tgUserInput}
                onChange={(e) => setTgUserInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addTgUser(); }}
                placeholder="Telegram user ID (numeric)"
                className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              />
              <button
                onClick={addTgUser}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              >
                Add
              </button>
            </div>

            {/* User list */}
            {tgUserEntries.length > 0 ? (
              <div className="mt-4 space-y-2">
                {tgUserEntries.map((userId, idx) => (
                  <div key={idx} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <span className="text-sm text-foreground font-mono">{userId}</span>
                    <button
                      onClick={() => removeTgUser(idx)}
                      className="text-xs text-red-600 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3">
                <p className="text-sm text-blue-700">
                  No restrictions — any Telegram user can interact with this agent. This is the recommended setting when user access is managed by the connecting application.
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setTgUsersEditId(null)}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveTgUsers(tgUsersEditId)}
                disabled={tgUsersSaving}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {tgUsersSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slack Channels/Users Editor Dialog */}
      {slackEditId && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12">
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Manage Slack Access</h3>
            <p className="mt-1 text-sm text-muted">
              Control which Slack channels and users can interact with this agent. When no restrictions are listed, the agent has access to all channels and users.
            </p>

            {/* Channels section */}
            <h4 className="mt-4 text-sm font-medium text-foreground">Allowed Channels</h4>
            <div className="mt-2 space-y-2">
              {/* Load from Slack button */}
              {slackEditChannelsAvailable.length === 0 && !slackEditChannelManualMode && (
                <button type="button" onClick={loadSlackEditChannels} disabled={slackEditChannelsLoading}
                  className="w-full rounded-md border border-blue-300 bg-white px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                  {slackEditChannelsLoading ? "Loading channels..." : "Load channels from Slack"}
                </button>
              )}

              {/* Searchable channel picker */}
              {slackEditChannelsAvailable.length > 0 && (
                <>
                  <input
                    type="text"
                    value={slackEditChannelSearch}
                    onChange={(e) => setSlackEditChannelSearch(e.target.value)}
                    placeholder="Search channels..."
                    className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
                    {slackEditChannelsAvailable
                      .filter((ch) => ch.name.toLowerCase().includes(slackEditChannelSearch.toLowerCase()))
                      .map((ch) => {
                        const selected = slackChannelEntries.includes(ch.id);
                        return (
                          <label key={ch.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? "bg-blue-50" : ""}`}>
                            <input type="checkbox" checked={selected} onChange={() => toggleSlackEditChannel(ch)}
                              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                            <span className="text-sm text-foreground flex-1">
                              <span className="font-medium">#{ch.name}</span>
                              {ch.isPrivate && <span className="ml-1 text-xs text-muted">(private)</span>}
                            </span>
                            <span className="text-xs text-muted">{ch.memberCount} members</span>
                          </label>
                        );
                      })}
                  </div>
                </>
              )}

              {/* Manual ID entry fallback */}
              {slackEditChannelsAvailable.length === 0 && !slackEditChannelManualMode && !slackEditChannelsLoading && (
                <p className="text-xs text-center">
                  <button type="button" onClick={() => setSlackEditChannelManualMode(true)} className="text-blue-600 hover:text-blue-700 underline">
                    Or enter a channel ID manually
                  </button>
                </p>
              )}
              {slackEditChannelManualMode && (
                <div className="flex gap-2">
                  <input type="text" value={slackChannelEditInput} onChange={(e) => setSlackChannelEditInput(e.target.value)}
                    placeholder="Channel ID (e.g. C0123456789)"
                    className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const id = slackChannelEditInput.trim();
                        if (id && !slackChannelEntries.includes(id)) {
                          setSlackChannelEntries((prev) => [...prev, id]);
                          setSlackChannelEditInput("");
                        }
                      }
                    }} />
                  <button type="button" onClick={() => {
                    const id = slackChannelEditInput.trim();
                    if (id && !slackChannelEntries.includes(id)) {
                      setSlackChannelEntries((prev) => [...prev, id]);
                      setSlackChannelEditInput("");
                    }
                  }}
                    className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
                    Add
                  </button>
                </div>
              )}

              {/* Selected channels (shown when using manual mode) */}
              {slackChannelEntries.length > 0 && slackEditChannelsAvailable.length === 0 && (
                <div className="space-y-1">
                  {slackChannelEntries.map((id, idx) => (
                    <div key={idx} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                      <span className="text-sm text-foreground font-mono"># {id}</span>
                      <button onClick={() => setSlackChannelEntries((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-xs text-red-600 hover:text-red-700">Remove</button>
                    </div>
                  ))}
                </div>
              )}

              {slackChannelEntries.length === 0 && slackEditChannelsAvailable.length === 0 && !slackEditChannelsLoading && (
                <p className="text-xs text-muted">No channel restrictions — all channels allowed.</p>
              )}

              {/* Summary when picker is showing */}
              {slackEditChannelsAvailable.length > 0 && (
                <p className="text-xs text-muted">
                  {slackChannelEntries.length} channel{slackChannelEntries.length !== 1 ? "s" : ""} selected
                  {slackChannelEntries.length === 0 && " — all channels allowed"}
                </p>
              )}
            </div>

            {/* Users section */}
            <h4 className="mt-4 text-sm font-medium text-foreground">Allowed Users</h4>
            <div className="mt-2 space-y-2">
              {/* Load from Slack button */}
              {slackEditUsersAvailable.length === 0 && !slackEditUserManualMode && (
                <button type="button" onClick={loadSlackEditUsers} disabled={slackEditUsersLoading}
                  className="w-full rounded-md border border-blue-300 bg-white px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                  {slackEditUsersLoading ? "Loading users..." : "Load users from Slack"}
                </button>
              )}

              {/* Searchable user picker */}
              {slackEditUsersAvailable.length > 0 && (
                <>
                  <input
                    type="text"
                    value={slackEditUserSearch}
                    onChange={(e) => setSlackEditUserSearch(e.target.value)}
                    placeholder="Search users..."
                    className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
                    {slackEditUsersAvailable
                      .filter((u) => !u.isBot)
                      .filter((u) =>
                        u.displayName.toLowerCase().includes(slackEditUserSearch.toLowerCase()) ||
                        u.name.toLowerCase().includes(slackEditUserSearch.toLowerCase()),
                      )
                      .map((u) => {
                        const selected = slackUserEntries.includes(u.id);
                        return (
                          <label key={u.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? "bg-blue-50" : ""}`}>
                            <input type="checkbox" checked={selected} onChange={() => toggleSlackEditUser(u)}
                              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                            <span className="text-sm text-foreground flex-1">
                              <span className="font-medium">{u.displayName}</span>
                              {u.displayName !== u.name && <span className="ml-1 text-xs text-muted">@{u.name}</span>}
                            </span>
                          </label>
                        );
                      })}
                  </div>
                </>
              )}

              {/* Manual ID entry fallback */}
              {slackEditUsersAvailable.length === 0 && !slackEditUserManualMode && !slackEditUsersLoading && (
                <p className="text-xs text-center">
                  <button type="button" onClick={() => setSlackEditUserManualMode(true)} className="text-blue-600 hover:text-blue-700 underline">
                    Or enter a member ID manually
                  </button>
                </p>
              )}
              {slackEditUserManualMode && (
                <div className="flex gap-2">
                  <input type="text" value={slackUserEditInput} onChange={(e) => setSlackUserEditInput(e.target.value)}
                    placeholder="Member ID (e.g. U0123456789)"
                    className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const id = slackUserEditInput.trim();
                        if (id && !slackUserEntries.includes(id)) {
                          setSlackUserEntries((prev) => [...prev, id]);
                          setSlackUserEditInput("");
                        }
                      }
                    }} />
                  <button type="button" onClick={() => {
                    const id = slackUserEditInput.trim();
                    if (id && !slackUserEntries.includes(id)) {
                      setSlackUserEntries((prev) => [...prev, id]);
                      setSlackUserEditInput("");
                    }
                  }}
                    className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
                    Add
                  </button>
                </div>
              )}

              {/* Selected users (shown when using manual mode) */}
              {slackUserEntries.length > 0 && slackEditUsersAvailable.length === 0 && (
                <div className="space-y-1">
                  {slackUserEntries.map((id, idx) => (
                    <div key={idx} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                      <span className="text-sm text-foreground font-mono">@ {id}</span>
                      <button onClick={() => setSlackUserEntries((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-xs text-red-600 hover:text-red-700">Remove</button>
                    </div>
                  ))}
                </div>
              )}

              {slackUserEntries.length === 0 && slackEditUsersAvailable.length === 0 && !slackEditUsersLoading && (
                <p className="text-xs text-muted">No user restrictions — messages from all users visible.</p>
              )}

              {/* Summary when picker is showing */}
              {slackEditUsersAvailable.length > 0 && (
                <p className="text-xs text-muted">
                  {slackUserEntries.length} user{slackUserEntries.length !== 1 ? "s" : ""} selected
                  {slackUserEntries.length === 0 && " — all users allowed"}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setSlackEditId(null)}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveSlackConstraints(slackEditId)}
                disabled={slackEditSaving}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {slackEditSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Model A Warning Dialog */}
      {modelAWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Enable Model A (Token Vending)?</h3>
            <p className="mt-2 text-sm text-muted">
              Model A gives the agent a <span className="font-medium text-foreground">temporary access token</span> to
              call the provider API directly, <span className="font-medium text-foreground">bypassing the AgentHiFive proxy</span>.
            </p>
            <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3">
              <p className="text-sm text-amber-800">
                This means proxy-level protections (request/response rules, PII redaction, rate limiting,
                and real-time audit logging) will <strong>not apply</strong> to Model A requests. The agent
                can make any API call the token&apos;s scopes allow.
              </p>
            </div>
            <p className="mt-3 text-sm text-muted">
              Only enable this if the agent genuinely needs direct provider access (e.g., streaming responses
              or high-throughput batch operations).
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setModelAWarning(null)}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (modelAWarning === "create") {
                    setFormAllowedModels([...formAllowedModels, "A"]);
                  } else {
                    setEditAllowedModels([...editAllowedModels, "A"]);
                  }
                  setModelAWarning(null);
                }}
                className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
              >
                Yes, Enable Model A
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Delete Policy</h3>
            <p className="mt-2 text-sm text-muted">
              Are you sure you want to delete the policy for{" "}
              <strong>{getAgentName(deleteTarget.agentId)}</strong> on{" "}
              <strong>{getConnectionLabel(deleteTarget.connectionId)}</strong>?
            </p>
            <p className="mt-2 text-sm text-muted">
              The agent will lose all access to this connection. This action cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete Policy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
