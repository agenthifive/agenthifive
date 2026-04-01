"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api-client";
import { getAllowedModelsForService, SERVICE_CATALOG, type ServiceId } from "@agenthifive/contracts";
import { HelpTooltip } from "@/components/help-tooltip";
import PresetCard, { ACTION_LABELS, adaptTelegramDescription, adaptSlackDescription } from "./preset-card";

// ── Types ──────────────────────────────────────────────────────────

interface PolicyWizardProps {
  agentId: string;
  agentName: string;
  connectionId: string;
  connectionLabel: string;
  connectionProvider: string;
  connectionService: string;
  /** Specific action template ID (e.g., "trello-read"). Falls back to connectionService if not provided. */
  actionTemplateId?: string;
  onCreated: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  /** When set, wizard operates in edit mode (PUT instead of POST) */
  editPolicyId?: string;
  editInitialValues?: {
    allowedModels: string[];
    defaultMode: string;
    stepUpApproval: string;
    providerConstraints?: {
      provider: string;
      allowedChatIds?: string[];
      allowedChannelIds?: string[];
      allowedUserIds?: string[];
    } | null;
  };
}

interface RequestRule {
  label?: string;
  match: {
    methods?: string[];
    urlPattern?: string;
    body?: { path: string; op: string; value?: string | number | boolean | string[] }[];
  };
  action: "allow" | "deny" | "require_approval";
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
    redact?: { type: string; pattern?: string; replacement?: string }[];
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

const RISK_COLORS: Record<string, string> = {
  low: "bg-green-100 text-green-700",
  medium: "bg-yellow-100 text-yellow-700",
  high: "bg-red-100 text-red-700",
};

// ── Component ──────────────────────────────────────────────────────

export default function PolicyWizard({
  agentId,
  agentName,
  connectionId,
  connectionLabel,
  connectionProvider,
  connectionService,
  actionTemplateId: actionTemplateIdProp,
  onCreated,
  onCancel,
  onDelete,
  editPolicyId,
  editInitialValues,
}: PolicyWizardProps) {
  const isEditMode = !!editPolicyId;

  // Wizard step: 1 = security preset config, 2 = customize guards
  const [wizardStep, setWizardStep] = useState(1);

  // Security settings — pre-populated from editInitialValues in edit mode
  const [allowedModels, setAllowedModels] = useState<string[]>(
    editInitialValues?.allowedModels ?? ["B"],
  );
  const [defaultMode, setDefaultMode] = useState(
    editInitialValues?.defaultMode ?? "read_only",
  );
  const [stepUpApproval, setStepUpApproval] = useState(
    editInitialValues?.stepUpApproval ?? "risk_based",
  );
  const [securityPreset, setSecurityPreset] = useState<"none" | "minimal" | "standard" | "strict">(
    isEditMode ? "none" : "standard",
  );

  // Track whether user has changed rules (presets/guards) — edit mode skips rules PUT if unchanged
  const [rulesChanged, setRulesChanged] = useState(false);

  // Presets from API
  const [presets, setPresets] = useState<RulePreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetsError, setPresetsError] = useState<string | null>(null);

  // Guards (step 2)
  const [guardCategories, setGuardCategories] = useState<GuardCategoryInfo[]>([]);
  const [guards, setGuards] = useState<ResolvedGuard[]>([]);
  const [guardsLoading, setGuardsLoading] = useState(false);
  const [enabledGuards, setEnabledGuards] = useState<Set<string>>(new Set());

  // Custom rules (step 2 expandable)
  const [customRequestRules, setCustomRequestRules] = useState<RequestRule[]>([]);
  const [customResponseRules, setCustomResponseRules] = useState<ResponseRule[]>([]);
  const [showCustomRules, setShowCustomRules] = useState(false);
  const [rulesTab, setRulesTab] = useState<"request" | "response">("request");

  // Telegram access control — pre-populate from providerConstraints in edit mode
  const editConstraints = editInitialValues?.providerConstraints;
  const editChatIds = editConstraints?.provider === "telegram" ? editConstraints.allowedChatIds : undefined;
  const [tgAccess, setTgAccess] = useState<"anyone" | "specific">(
    editChatIds && editChatIds.length > 0 ? "specific" : "anyone",
  );
  const [tgIds, setTgIds] = useState<{ id: string; label: string }[]>(
    editChatIds?.map((id) => ({ id, label: "" })) ?? [],
  );
  const [tgIdInput, setTgIdInput] = useState("");
  const [tgLabelInput, setTgLabelInput] = useState("");
  const [tgTrustedIds, setTgTrustedIds] = useState<string[]>([]);
  const [tgTrustedInput, setTgTrustedInput] = useState("");

  // Slack access control — pre-populate from providerConstraints in edit mode
  const editSlackConstraints = editConstraints?.provider === "slack" ? editConstraints : undefined;
  const [slackChannelAccess, setSlackChannelAccess] = useState<"anyone" | "specific">(
    editSlackConstraints?.allowedChannelIds?.length ? "specific" : "anyone",
  );
  const [slackChannelIds, setSlackChannelIds] = useState<{ id: string; label: string }[]>(
    editSlackConstraints?.allowedChannelIds?.map((id: string) => ({ id, label: "" })) ?? [],
  );
  const [slackChannelInput, setSlackChannelInput] = useState("");
  const [slackChannelManualMode, setSlackChannelManualMode] = useState(false);
  const [slackChannelsLoading, setSlackChannelsLoading] = useState(false);
  const [slackChannelsAvailable, setSlackChannelsAvailable] = useState<{ id: string; name: string; isPrivate: boolean; memberCount: number }[]>([]);
  const [slackChannelSearch, setSlackChannelSearch] = useState("");
  const [slackUserAccess, setSlackUserAccess] = useState<"anyone" | "specific">(
    editSlackConstraints?.allowedUserIds?.length ? "specific" : "anyone",
  );
  const [slackUserIds, setSlackUserIds] = useState<{ id: string; label: string }[]>(
    editSlackConstraints?.allowedUserIds?.map((id: string) => ({ id, label: "" })) ?? [],
  );
  const [slackUserInput, setSlackUserInput] = useState("");
  const [slackUserManualMode, setSlackUserManualMode] = useState(false);
  const [slackUsersLoading, setSlackUsersLoading] = useState(false);
  const [slackUsersAvailable, setSlackUsersAvailable] = useState<{ id: string; name: string; displayName: string; isBot: boolean }[]>([]);
  const [slackUserSearch, setSlackUserSearch] = useState("");

  // Model A warning
  const [showModelAWarning, setShowModelAWarning] = useState(false);

  // Loading + error
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // View preset details modal
  const [viewingPreset, setViewingPreset] = useState<RulePreset | null>(null);

  const serviceModels = getAllowedModelsForService(connectionService as ServiceId);
  const serviceEntry = SERVICE_CATALOG[connectionService as keyof typeof SERVICE_CATALOG];
  const docsPath = serviceEntry?.docsPath;

  // Test connection state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail?: string; error?: string; hint?: string } | null>(null);

  // ── Load presets on mount ────────────────────────────────────────

  useEffect(() => {
    setPresetsLoading(true);
    setPresetsError(null);
    // Use service ID for service-specific rules (e.g., "google-gmail" instead of "google")
    // Pass connectionId for scope-aware presets (e.g., read-only vs read-write Gmail scopes)
    const templateParams = new URLSearchParams({ connectionId });
    if (actionTemplateIdProp) templateParams.set("actionTemplateId", actionTemplateIdProp);
    apiFetch(`/templates/${connectionService}/rules?${templateParams}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          setPresetsError(`Failed to load presets (${res.status}): ${body}`);
          return;
        }
        const data = (await res.json()) as { presets: RulePreset[] };
        setPresets(data.presets);
        if (isEditMode && editInitialValues) {
          // Edit mode: infer which preset matches the current policy settings
          const match = data.presets.find(
            (p) =>
              p.recommended.defaultMode === editInitialValues.defaultMode &&
              p.recommended.stepUpApproval === editInitialValues.stepUpApproval,
          );
          if (match) {
            setSecurityPreset(match.id as "minimal" | "standard" | "strict");
          }
        } else if (!isEditMode) {
          // Create mode: apply recommended settings from the default preset
          const preset = data.presets.find((p) => p.id === "standard");
          if (preset) {
            setDefaultMode(preset.recommended.defaultMode);
            setStepUpApproval(preset.recommended.stepUpApproval);
          }
        }
      })
      .catch((err) => {
        setPresetsError(`Network error loading presets: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setPresetsLoading(false));
  }, [connectionService, connectionId, isEditMode]);

  // ── Helpers ──────────────────────────────────────────────────────

  function getRecommendedPresetId(): "minimal" | "standard" | "strict" {
    return "standard";
  }

  function handlePresetChange(presetId: "none" | "minimal" | "standard" | "strict") {
    setSecurityPreset(presetId);
    setRulesChanged(true);
    if (presetId === "none") return;
    const preset = presets.find((p) => p.id === presetId);
    if (preset) {
      setDefaultMode(preset.recommended.defaultMode);
      setStepUpApproval(preset.recommended.stepUpApproval);
    }
  }

  async function goToGuardsStep(fromPresetId?: string) {
    const presetId = fromPresetId ?? securityPreset;
    setRulesTab("request");
    setShowCustomRules(false);
    setCustomRequestRules([]);
    setCustomResponseRules([]);
    setSecurityPreset("none");
    setRulesChanged(true);
    setWizardStep(2);

    setGuardsLoading(true);
    try {
      const res = await apiFetch(`/templates/${connectionProvider}/guards`);
      if (res.ok) {
        const data = (await res.json()) as { categories: GuardCategoryInfo[]; guards: ResolvedGuard[] };
        setGuardCategories(data.categories);
        setGuards(data.guards);

        // Pre-select guards based on the chosen preset tier
        const enabled = new Set<string>();
        if (presetId === "strict") {
          for (const g of data.guards) enabled.add(g.id);
        } else if (presetId === "standard") {
          for (const g of data.guards) {
            if (g.presetTier === "standard") enabled.add(g.id);
          }
        }
        setEnabledGuards(enabled);
      }
    } catch {
      // Guards are optional
    } finally {
      setGuardsLoading(false);
    }
  }

  function toggleGuard(guardId: string) {
    setEnabledGuards((prev) => {
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

    for (const guard of guards) {
      if (!enabledGuards.has(guard.id)) continue;
      requestRules.push(...guard.requestRules);
      responseRules.push(...guard.responseRules);
    }

    requestRules.push(...customRequestRules);
    responseRules.push(...customResponseRules);

    return { request: requestRules, response: responseRules };
  }

  function adaptRulesForAllowlist(
    rules: PolicyRules,
    hasAllowlist: boolean,
    trustedIds: string[],
  ): PolicyRules {
    if (!hasAllowlist && trustedIds.length === 0) return rules;

    if (hasAllowlist) {
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

  function addTgUser() {
    const id = tgIdInput.trim();
    if (!id) return;
    if (!/^\d+$/.test(id)) {
      setError("Telegram user IDs are numeric — message @userinfobot on Telegram to find yours");
      return;
    }
    if (tgIds.some((e) => e.id === id)) {
      setError("This user ID is already in the list");
      return;
    }
    setTgIds((prev) => [...prev, { id, label: tgLabelInput.trim() }]);
    setTgIdInput("");
    setTgLabelInput("");
  }

  function addTrustedRecipient() {
    const id = tgTrustedInput.trim();
    if (!id || tgTrustedIds.includes(id)) return;
    setTgTrustedIds((prev) => [...prev, id]);
    setTgTrustedInput("");
  }

  function addSlackChannelManual() {
    const id = slackChannelInput.trim();
    if (!id) return;
    if (slackChannelIds.some((e) => e.id === id)) {
      setError("This channel ID is already in the list");
      return;
    }
    setSlackChannelIds((prev) => [...prev, { id, label: "" }]);
    setSlackChannelInput("");
  }

  function addSlackUserManual() {
    const id = slackUserInput.trim();
    if (!id) return;
    if (slackUserIds.some((e) => e.id === id)) {
      setError("This user ID is already in the list");
      return;
    }
    setSlackUserIds((prev) => [...prev, { id, label: "" }]);
    setSlackUserInput("");
  }

  async function loadSlackChannels() {
    setSlackChannelsLoading(true);
    try {
      const res = await apiFetch(`/connections/${connectionId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "channels" }),
      });
      const data = await res.json();
      if (data.items) setSlackChannelsAvailable(data.items);
    } catch {
      setError("Failed to load channels from Slack");
    }
    setSlackChannelsLoading(false);
  }

  async function loadSlackUsers() {
    setSlackUsersLoading(true);
    try {
      const res = await apiFetch(`/connections/${connectionId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "users" }),
      });
      const data = await res.json();
      if (data.items) setSlackUsersAvailable(data.items);
    } catch {
      setError("Failed to load users from Slack");
    }
    setSlackUsersLoading(false);
  }

  function toggleSlackChannel(ch: { id: string; name: string }) {
    setSlackChannelIds((prev) =>
      prev.some((e) => e.id === ch.id)
        ? prev.filter((e) => e.id !== ch.id)
        : [...prev, { id: ch.id, label: ch.name }],
    );
  }

  function toggleSlackUser(u: { id: string; name: string; displayName: string }) {
    setSlackUserIds((prev) =>
      prev.some((e) => e.id === u.id)
        ? prev.filter((e) => e.id !== u.id)
        : [...prev, { id: u.id, label: u.displayName || u.name }],
    );
  }

  function adaptRulesForSlackAllowlist(
    rules: PolicyRules,
    hasChannelAllowlist: boolean,
  ): PolicyRules {
    if (!hasChannelAllowlist) return rules;

    // All channels are trusted — change require_approval → allow for send rules
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

  // ── Create / Save Policy ─────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (allowedModels.length === 0) {
      setError("Select at least one execution model");
      return;
    }
    setCreating(true);
    setError(null);

    try {
      let policyId: string;

      if (isEditMode) {
        // Edit mode: PUT existing policy
        const res = await apiFetch(`/policies/${editPolicyId}`, {
          method: "PUT",
          body: JSON.stringify({
            allowedModels,
            defaultMode,
            stepUpApproval,
            securityPreset: securityPreset !== "none" ? securityPreset : undefined,
          }),
        });

        if (!res.ok) {
          const data = (await res.json()) as { error: string };
          throw new Error(data.error);
        }
        policyId = editPolicyId;
      } else {
        // Create mode: POST new policy
        const res = await apiFetch("/policies", {
          method: "POST",
          body: JSON.stringify({
            agentId,
            connectionId,
            actionTemplateId: actionTemplateIdProp ?? connectionService,
            allowedModels,
            defaultMode,
            stepUpApproval,
            securityPreset: securityPreset !== "none" ? securityPreset : undefined,
            policyTier: securityPreset !== "none" ? securityPreset : undefined,
          }),
        });

        if (!res.ok) {
          const data = (await res.json()) as { error: string };
          throw new Error(data.error);
        }

        const data = (await res.json()) as { policy: { id: string } };
        policyId = data.policy?.id;

        if (!policyId) {
          throw new Error("Server returned an invalid policy");
        }
      }

      // Rules are generated server-side from the policyTier via
      // generatePolicyFromTemplate(). The dashboard never sends rules
      // directly — the server is the sole authority on rule content.

      // Apply Telegram user restrictions if configured
      if (connectionProvider === "telegram" && tgAccess === "specific" && tgIds.length > 0) {
        try {
          await apiFetch(`/policies/${policyId}/provider-constraints`, {
            method: "PUT",
            body: JSON.stringify({
              providerConstraints: {
                provider: "telegram",
                allowedChatIds: tgIds.map((e) => e.id),
              },
            }),
          });
        } catch {
          // Constraints failed, but policy was saved
        }
      }

      // Apply Slack channel/user restrictions if configured
      if (connectionProvider === "slack") {
        const hasChannels = slackChannelAccess === "specific" && slackChannelIds.length > 0;
        const hasUsers = slackUserAccess === "specific" && slackUserIds.length > 0;
        if (hasChannels || hasUsers) {
          try {
            await apiFetch(`/policies/${policyId}/provider-constraints`, {
              method: "PUT",
              body: JSON.stringify({
                providerConstraints: {
                  provider: "slack",
                  ...(hasChannels && { allowedChannelIds: slackChannelIds.map((e) => e.id) }),
                  ...(hasUsers && { allowedUserIds: slackUserIds.map((e) => e.id) }),
                },
              }),
            });
          } catch {
            // Constraints failed, but policy was saved
          }
        }
      }

      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : isEditMode ? "Failed to save policy" : "Failed to create policy");
    } finally {
      setCreating(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-600">{error}</p>
          <button onClick={() => setError(null)} className="mt-1 text-xs text-red-500 underline">
            Dismiss
          </button>
        </div>
      )}

      {/* ── Security Preset + Settings ── */}
      <div>
          <div className="flex items-center gap-0.5">
            <h3 className="text-base font-semibold text-foreground">
              {isEditMode ? "Edit Policy" : "Grant Access"}
            </h3>
            {docsPath && (
              <HelpTooltip docsPath={docsPath}>
                Learn about configuring policies and security rules for {serviceEntry?.displayName || connectionProvider}.
              </HelpTooltip>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            Select security &amp; privacy settings
          </p>

          <form onSubmit={handleSubmit} className="mt-4 space-y-5">
            {/* Telegram: Recommendation banner + Who can communicate with this agent? */}
            {connectionProvider === "telegram" && (
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
                    <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${tgAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                      <input type="radio" name="tg-access" value="anyone" checked={tgAccess === "anyone"}
                        onChange={() => setTgAccess("anyone")}
                        className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                      <div>
                        <span className="text-sm font-medium text-foreground">Anyone</span>
                        <p className="text-xs text-muted mt-0.5">
                          The agent can send and receive messages with any Telegram user.
                        </p>
                      </div>
                    </label>

                    <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${tgAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                      <input type="radio" name="tg-access" value="specific" checked={tgAccess === "specific"}
                        onChange={() => setTgAccess("specific")}
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
                  {tgAccess === "anyone" && (
                    <div className="mt-3 rounded-lg border border-border bg-gray-50 p-4 space-y-3">
                      <p className="text-xs text-muted">
                        <strong>Add yourself as a trusted recipient</strong> so the agent can message you without approval. Only users on this list will be able to interact with the agent.
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={tgTrustedInput}
                          onChange={(e) => setTgTrustedInput(e.target.value)}
                          placeholder="Your Telegram User ID"
                          className="block flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTrustedRecipient(); } }}
                        />
                        <button type="button" onClick={addTrustedRecipient} disabled={!tgTrustedInput.trim()}
                          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                          Add
                        </button>
                      </div>
                      {tgTrustedIds.length > 0 && (
                        <div className="space-y-1">
                          {tgTrustedIds.map((id, i) => (
                            <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-1.5">
                              <span className="text-sm font-mono">{id}</span>
                              <button type="button" onClick={() => setTgTrustedIds((p) => p.filter((_, idx) => idx !== i))}
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
                  {tgAccess === "specific" && (
                    <div className="mt-3 rounded-lg border border-border bg-gray-50 p-4 space-y-3">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <input
                            type="text"
                            value={tgIdInput}
                            onChange={(e) => setTgIdInput(e.target.value)}
                            placeholder="Telegram User ID"
                            className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTgUser(); } }}
                          />
                        </div>
                        <div className="flex-1">
                          <input
                            type="text"
                            value={tgLabelInput}
                            onChange={(e) => setTgLabelInput(e.target.value)}
                            placeholder='Name (optional, e.g. "Mom")'
                            className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTgUser(); } }}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={addTgUser}
                          disabled={!tgIdInput.trim()}
                          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Add
                        </button>
                      </div>

                      {tgIds.length > 0 ? (
                        <div className="space-y-1">
                          {tgIds.map((entry, i) => (
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
                                onClick={() => setTgIds((prev) => prev.filter((_, idx) => idx !== i))}
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
            {connectionProvider === "slack" && (
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
                    <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${slackChannelAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                      <input type="radio" name="slack-channel-access" value="anyone" checked={slackChannelAccess === "anyone"}
                        onChange={() => setSlackChannelAccess("anyone")}
                        className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                      <div>
                        <span className="text-sm font-medium text-foreground">Any channel</span>
                        <p className="text-xs text-muted mt-0.5">
                          The agent can read and post in any channel it has access to.
                        </p>
                      </div>
                    </label>

                    <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${slackChannelAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                      <input type="radio" name="slack-channel-access" value="specific" checked={slackChannelAccess === "specific"}
                        onChange={() => setSlackChannelAccess("specific")}
                        className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                      <div>
                        <span className="text-sm font-medium text-foreground">Only specific channels</span>
                        <p className="text-xs text-muted mt-0.5">
                          The agent can only use the channels listed below — all other channels are blocked.
                        </p>
                      </div>
                    </label>
                  </div>

                  {slackChannelAccess === "specific" && (
                    <div className="mt-3 rounded-lg border border-border bg-gray-50 p-4 space-y-3">
                      {/* Load from Slack button */}
                      {slackChannelsAvailable.length === 0 && !slackChannelManualMode && (
                        <button type="button" onClick={loadSlackChannels} disabled={slackChannelsLoading}
                          className="w-full rounded-md border border-blue-300 bg-white px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                          {slackChannelsLoading ? "Loading channels..." : "Load channels from Slack"}
                        </button>
                      )}

                      {/* Searchable channel picker */}
                      {slackChannelsAvailable.length > 0 && (
                        <>
                          <input
                            type="text"
                            value={slackChannelSearch}
                            onChange={(e) => setSlackChannelSearch(e.target.value)}
                            placeholder="Search channels..."
                            className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
                            {slackChannelsAvailable
                              .filter((ch) => ch.name.toLowerCase().includes(slackChannelSearch.toLowerCase()))
                              .map((ch) => {
                                const selected = slackChannelIds.some((e) => e.id === ch.id);
                                return (
                                  <label key={ch.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? "bg-blue-50" : ""}`}>
                                    <input type="checkbox" checked={selected} onChange={() => toggleSlackChannel(ch)}
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
                      {slackChannelsAvailable.length === 0 && !slackChannelManualMode && !slackChannelsLoading && (
                        <p className="text-xs text-center">
                          <button type="button" onClick={() => setSlackChannelManualMode(true)} className="text-blue-600 hover:text-blue-700 underline">
                            Or enter a channel ID manually
                          </button>
                        </p>
                      )}
                      {slackChannelManualMode && (
                        <div className="flex gap-2">
                          <input type="text" value={slackChannelInput} onChange={(e) => setSlackChannelInput(e.target.value)}
                            placeholder="Channel ID (e.g. C0123456789)"
                            className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSlackChannelManual(); } }} />
                          <button type="button" onClick={addSlackChannelManual} disabled={!slackChannelInput.trim()}
                            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                            Add
                          </button>
                        </div>
                      )}

                      {/* Selected channels (shown when using manual mode or from picker) */}
                      {slackChannelIds.length > 0 && slackChannelsAvailable.length === 0 && (
                        <div className="space-y-1">
                          {slackChannelIds.map((entry, i) => (
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
                              <button type="button" onClick={() => setSlackChannelIds((prev) => prev.filter((_, idx) => idx !== i))}
                                className="text-red-400 hover:text-red-600 text-sm">Remove</button>
                            </div>
                          ))}
                        </div>
                      )}

                      {slackChannelIds.length === 0 && slackChannelsAvailable.length === 0 && !slackChannelsLoading && (
                        <p className="text-xs text-muted text-center py-1">
                          No channels selected yet.
                        </p>
                      )}

                      {/* Summary when picker is showing */}
                      {slackChannelsAvailable.length > 0 && slackChannelIds.length > 0 && (
                        <p className="text-xs text-muted">
                          {slackChannelIds.length} channel{slackChannelIds.length !== 1 ? "s" : ""} selected
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
                    <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${slackUserAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                      <input type="radio" name="slack-user-access" value="anyone" checked={slackUserAccess === "anyone"}
                        onChange={() => setSlackUserAccess("anyone")}
                        className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                      <div>
                        <span className="text-sm font-medium text-foreground">Anyone</span>
                        <p className="text-xs text-muted mt-0.5">
                          The agent can read messages from any user in the allowed channels.
                        </p>
                      </div>
                    </label>

                    <label className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer transition-all ${slackUserAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                      <input type="radio" name="slack-user-access" value="specific" checked={slackUserAccess === "specific"}
                        onChange={() => setSlackUserAccess("specific")}
                        className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                      <div>
                        <span className="text-sm font-medium text-foreground">Only specific people</span>
                        <p className="text-xs text-muted mt-0.5">
                          The agent can only see messages from the people listed below — messages from all other users are filtered out.
                        </p>
                      </div>
                    </label>
                  </div>

                  {slackUserAccess === "specific" && (
                    <div className="mt-3 rounded-lg border border-border bg-gray-50 p-4 space-y-3">
                      {/* Load from Slack button */}
                      {slackUsersAvailable.length === 0 && !slackUserManualMode && (
                        <button type="button" onClick={loadSlackUsers} disabled={slackUsersLoading}
                          className="w-full rounded-md border border-blue-300 bg-white px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                          {slackUsersLoading ? "Loading users..." : "Load users from Slack"}
                        </button>
                      )}

                      {/* Searchable user picker */}
                      {slackUsersAvailable.length > 0 && (
                        <>
                          <input
                            type="text"
                            value={slackUserSearch}
                            onChange={(e) => setSlackUserSearch(e.target.value)}
                            placeholder="Search users..."
                            className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
                            {slackUsersAvailable
                              .filter((u) => !u.isBot)
                              .filter((u) =>
                                u.displayName.toLowerCase().includes(slackUserSearch.toLowerCase()) ||
                                u.name.toLowerCase().includes(slackUserSearch.toLowerCase()),
                              )
                              .map((u) => {
                                const selected = slackUserIds.some((e) => e.id === u.id);
                                return (
                                  <label key={u.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? "bg-blue-50" : ""}`}>
                                    <input type="checkbox" checked={selected} onChange={() => toggleSlackUser(u)}
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
                      {slackUsersAvailable.length === 0 && !slackUserManualMode && !slackUsersLoading && (
                        <p className="text-xs text-center">
                          <button type="button" onClick={() => setSlackUserManualMode(true)} className="text-blue-600 hover:text-blue-700 underline">
                            Or enter a member ID manually
                          </button>
                        </p>
                      )}
                      {slackUserManualMode && (
                        <div className="flex gap-2">
                          <input type="text" value={slackUserInput} onChange={(e) => setSlackUserInput(e.target.value)}
                            placeholder="Member ID (e.g. U0123456789)"
                            className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSlackUserManual(); } }} />
                          <button type="button" onClick={addSlackUserManual} disabled={!slackUserInput.trim()}
                            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                            Add
                          </button>
                        </div>
                      )}

                      {/* Selected users (shown when using manual mode) */}
                      {slackUserIds.length > 0 && slackUsersAvailable.length === 0 && (
                        <div className="space-y-1">
                          {slackUserIds.map((entry, i) => (
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
                              <button type="button" onClick={() => setSlackUserIds((prev) => prev.filter((_, idx) => idx !== i))}
                                className="text-red-400 hover:text-red-600 text-sm">Remove</button>
                            </div>
                          ))}
                        </div>
                      )}

                      {slackUserIds.length === 0 && slackUsersAvailable.length === 0 && !slackUsersLoading && (
                        <p className="text-xs text-muted text-center py-1">
                          No users selected yet.
                        </p>
                      )}

                      {/* Summary when picker is showing */}
                      {slackUsersAvailable.length > 0 && slackUserIds.length > 0 && (
                        <p className="text-xs text-muted">
                          {slackUserIds.length} user{slackUserIds.length !== 1 ? "s" : ""} selected
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Vault security note — shown when only proxied access (Model B) */}
            {!(serviceModels.includes("A") && serviceModels.includes("B")) && (
              <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                <span className="text-blue-600 mt-0.5">🔒</span>
                <p className="text-sm text-blue-800">
                  All requests from the agent are brokered through AgentHiFive. Your credentials never leave the Vault.
                </p>
              </div>
            )}

            {/* Connection models — only show when both A and B are available */}
            {serviceModels.includes("A") && serviceModels.includes("B") && (
              <div>
                <div className="space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="radio" name="connection-model" value="A" checked={allowedModels.includes("A")}
                      onChange={() => {
                        if (!allowedModels.includes("A")) {
                          setShowModelAWarning(true);
                        }
                      }}
                      className="mt-0.5 h-4 w-4 border-border text-blue-600 focus:ring-blue-500" />
                    <div>
                      <span className="text-sm font-medium text-foreground">Direct Access</span>
                      <p className="text-xs text-muted">Protect your {connectionLabel} credentials only</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="radio" name="connection-model" value="B" checked={allowedModels.includes("B")}
                      onChange={() => setAllowedModels(["B"])}
                      className="mt-0.5 h-4 w-4 border-border text-blue-600 focus:ring-blue-500" />
                    <div>
                      <span className="text-sm font-medium text-foreground">Proxied Access <span className="text-xs font-normal text-green-600">(Recommended)</span></span>
                      <p className="text-xs text-muted">Protect your {connectionLabel} credentials and control your privacy</p>
                    </div>
                  </label>
                </div>
                {allowedModels.includes("A") && (
                  <p className="mt-2 text-xs text-amber-700 bg-amber-50 rounded-md border border-amber-200 px-3 py-2">
                    <strong>⚠️ Security Notice:</strong> With Direct Access, {agentName} can make any API call the token allows. Only credentials are protected — request filtering, PII redaction, rate limiting, and audit logging are bypassed.
                  </p>
                )}
              </div>
            )}

            {/* Security Preset */}
            <div>
              {presetsLoading ? (
                <div className="space-y-2">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="h-16 rounded-lg border border-muted/30 bg-muted/10 animate-pulse" />
                  ))}
                </div>
              ) : presetsError ? (
                <p className="text-xs text-red-600">{presetsError}</p>
              ) : presets.length > 0 ? (
                <div className={`grid grid-cols-3 gap-2 ${allowedModels.includes("A") && !allowedModels.includes("B") ? "opacity-50 pointer-events-none" : ""}`}>
                  {presets.map((preset) => {
                    const presetsDisabled = allowedModels.includes("A") && !allowedModels.includes("B");
                    const adaptedDescription = connectionProvider === "telegram"
                      ? adaptTelegramDescription(preset.description, preset.id, (tgAccess === "anyone" && tgTrustedIds.length > 0) || (tgAccess === "specific" && tgIds.length > 0))
                      : connectionProvider === "slack"
                        ? adaptSlackDescription(preset.description, preset.id, (slackChannelAccess === "specific" && slackChannelIds.length > 0) || (slackUserAccess === "specific" && slackUserIds.length > 0))
                        : undefined;
                    return (
                      <PresetCard
                        key={preset.id}
                        preset={preset}
                        selected={securityPreset === preset.id}
                        onClick={() => handlePresetChange(preset.id as "minimal" | "standard" | "strict")}
                        {...(adaptedDescription !== undefined && { description: adaptedDescription })}
                        isRecommended={preset.id === getRecommendedPresetId()}
                        disabled={presetsDisabled}
                        onViewSettings={setViewingPreset}
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted">No presets available for this provider</p>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <div>
                {!isEditMode && onDelete && (
                  <button type="button" onClick={onDelete}
                    className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50">
                    Delete Connection
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={onCancel}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100">
                  Cancel
                </button>
                <button type="submit" disabled={creating || allowedModels.length === 0}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                  {creating ? (isEditMode ? "Saving..." : "Granting...") : (isEditMode ? "Save Policy" : "Grant Access")}
                </button>
              </div>
            </div>
          </form>
        </div>

      {/* View Preset Details Modal */}
      {viewingPreset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="mx-auto w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl">
            <div className="sticky top-0 z-10 bg-white border-b border-border px-6 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">{viewingPreset.name} Settings</h3>
                  <p className="text-sm text-muted mt-0.5">{viewingPreset.description}</p>
                </div>
                <button
                  onClick={() => setViewingPreset(null)}
                  className="text-muted hover:text-foreground"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="px-6 py-4 space-y-6">
              {/* Recommended Settings */}
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-3">Recommended Configuration</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border bg-gray-50 px-4 py-3">
                    <span className="text-xs text-muted block mb-1">Default Mode</span>
                    <span className="text-sm font-medium text-foreground">
                      {MODE_LABELS[viewingPreset.recommended.defaultMode] || viewingPreset.recommended.defaultMode}
                    </span>
                  </div>
                  <div className="rounded-lg border border-border bg-gray-50 px-4 py-3">
                    <span className="text-xs text-muted block mb-1">Step-up Approval</span>
                    <span className="text-sm font-medium text-foreground">
                      {APPROVAL_LABELS[viewingPreset.recommended.stepUpApproval] || viewingPreset.recommended.stepUpApproval}
                    </span>
                  </div>
                </div>
              </div>

              {/* Request Rules */}
              {viewingPreset.rules.request.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-3">
                    Request Rules ({viewingPreset.rules.request.length})
                  </h4>
                  <div className="space-y-2">
                    {viewingPreset.rules.request.map((rule, idx) => (
                      <div key={idx} className="rounded-lg border border-border bg-gray-50 px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                                ACTION_LABELS[rule.action]?.color ?? "bg-gray-100 text-gray-700"
                              }`}>
                                {ACTION_LABELS[rule.action]?.label ?? rule.action}
                              </span>
                              {rule.label && (
                                <span className="text-sm font-medium text-foreground">{rule.label}</span>
                              )}
                            </div>
                            {rule.match.urlPattern && (
                              <div className="mt-1.5">
                                <span className="text-xs text-muted">URL Pattern:</span>
                                <code className="ml-2 text-xs font-mono text-foreground bg-white rounded px-1.5 py-0.5 border border-border">
                                  {rule.match.urlPattern}
                                </code>
                              </div>
                            )}
                            {rule.match.methods && rule.match.methods.length > 0 && (
                              <div className="mt-1">
                                <span className="text-xs text-muted">Methods:</span>
                                <span className="ml-2 text-xs font-mono text-foreground">
                                  {rule.match.methods.join(", ")}
                                </span>
                              </div>
                            )}
                            {rule.match.body && rule.match.body.length > 0 && (
                              <div className="mt-1">
                                <span className="text-xs text-muted">Body Conditions:</span>
                                <div className="ml-2 mt-1 space-y-0.5">
                                  {rule.match.body.map((condition, ci) => (
                                    <div key={ci} className="text-xs font-mono text-foreground">
                                      {condition.path} {condition.op} {JSON.stringify(condition.value)}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Response Rules */}
              {viewingPreset.rules.response.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-3">
                    Privacy Protection
                  </h4>
                  <div className="space-y-2">
                    {viewingPreset.rules.response.map((rule, idx) => (
                      <div key={idx} className="rounded-lg border border-border bg-gray-50 px-4 py-3">
                        <div className="flex-1 min-w-0">
                          {rule.label && (
                            <div className="font-medium text-sm text-foreground mb-2">{rule.label}</div>
                          )}
                          {rule.match.urlPattern && (
                            <div className="mb-2">
                              <span className="text-xs text-muted">URL Pattern:</span>
                              <code className="ml-2 text-xs font-mono text-foreground bg-white rounded px-1.5 py-0.5 border border-border">
                                {rule.match.urlPattern}
                              </code>
                            </div>
                          )}
                          {rule.filter.allowFields && rule.filter.allowFields.length > 0 && (
                            <div className="mb-1.5">
                              <span className="text-xs text-muted block mb-1">Allow Fields:</span>
                              <div className="flex flex-wrap gap-1">
                                {rule.filter.allowFields.map((field, fi) => (
                                  <code key={fi} className="text-xs font-mono text-green-700 bg-green-50 rounded px-1.5 py-0.5 border border-green-200">
                                    {field}
                                  </code>
                                ))}
                              </div>
                            </div>
                          )}
                          {rule.filter.denyFields && rule.filter.denyFields.length > 0 && (
                            <div className="mb-1.5">
                              <span className="text-xs text-muted block mb-1">Deny Fields:</span>
                              <div className="flex flex-wrap gap-1">
                                {rule.filter.denyFields.map((field, fi) => (
                                  <code key={fi} className="text-xs font-mono text-red-700 bg-red-50 rounded px-1.5 py-0.5 border border-red-200">
                                    {field}
                                  </code>
                                ))}
                              </div>
                            </div>
                          )}
                          {rule.filter.redact && rule.filter.redact.length > 0 && (
                            <div>
                              <span className="text-xs text-muted block mb-1">Redact Patterns:</span>
                              <div className="space-y-1">
                                {rule.filter.redact.map((redaction, ri) => (
                                  <div key={ri} className="text-xs">
                                    <span className="font-mono text-foreground bg-white rounded px-1.5 py-0.5 border border-border">
                                      {redaction.type}
                                      {redaction.pattern && `: ${redaction.pattern}`}
                                    </span>
                                    {redaction.replacement && (
                                      <span className="text-muted ml-2">→ {redaction.replacement}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="sticky bottom-0 bg-white border-t border-border px-6 py-4">
              <button
                onClick={() => setViewingPreset(null)}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Direct Access Warning (z-50, on top of parent modal) */}
      {showModelAWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground">Enable Direct Access?</h3>
            <p className="mt-2 text-sm text-muted">
              Direct Access gives the agent a <span className="font-medium text-foreground">temporary access token</span> to
              call the provider API directly, <span className="font-medium text-foreground">bypassing the AgentHiFive proxy</span>.
            </p>
            <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3">
              <p className="text-sm text-amber-800">
                This means proxy-level protections (request/response rules, PII redaction, rate limiting,
                and real-time audit logging) will <strong>not apply</strong> to direct access requests. The agent
                can make any API call the token&apos;s scopes allow.
              </p>
            </div>
            <p className="mt-3 text-sm text-muted">
              Only enable this if the agent genuinely needs direct provider access (e.g., streaming responses
              or high-throughput batch operations).
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setShowModelAWarning(false)}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setAllowedModels(["A"]);
                  setShowModelAWarning(false);
                }}
                className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
              >
                Yes, Enable Direct Access
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
