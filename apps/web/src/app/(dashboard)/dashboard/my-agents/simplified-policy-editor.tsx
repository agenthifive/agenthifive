"use client";

import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api-client";
import { inferPolicyTier, type AgentPolicy, type AllowlistEntry, type RateLimits, type TimeWindow } from "./types";
import PresetCard, { adaptTelegramDescription, adaptSlackDescription } from "./preset-card";

interface SimplifiedPolicyEditorProps {
  policy: AgentPolicy;
  connectionId: string;
  connectionService: string;
  onSaved: () => void;
  onCancel: () => void;
}

type PresetTier = "minimal" | "standard" | "strict";

interface RulePreset {
  id: string;
  name: string;
  description: string;
  rules: {
    request: any[];
    response: any[];
  };
  recommended: {
    defaultMode: string;
    stepUpApproval: string;
  };
  rateLimitLabel?: string;
  features?: string[];
}

interface Guard {
  id: string;
  category: string;
  name: string;
  description: string;
  presetTier: "standard" | "strict" | null;
  risk: "low" | "medium" | "high";
  requestRules: any[];
  responseRules: any[];
}

interface GuardCategory {
  id: string;
  name: string;
  description: string;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LLM_PROVIDERS = new Set(["anthropic", "openai", "gemini", "openrouter"]);

// Map services to their relevant guard categories
function getRelevantCategoriesForService(service: string): string[] {
  const categoryMap: Record<string, string[]> = {
    "google-gmail": ["content_safety", "messaging"],
    "google-calendar": ["content_safety", "calendar", "destructive"],
    "google-drive": ["content_safety", "file_sharing", "data_reading", "destructive"],
    "google-sheets": ["content_safety", "file_sharing", "data_reading", "destructive"],
    "google-docs": ["content_safety", "file_sharing", "data_reading", "destructive"],
    "microsoft-outlook-mail": ["content_safety", "messaging"],
    "microsoft-outlook-calendar": ["content_safety", "calendar", "destructive"],
    "microsoft-onedrive": ["content_safety", "file_sharing", "data_reading", "destructive"],
    "microsoft-teams": ["content_safety", "messaging"],
    "slack": ["content_safety", "messaging"],
    "telegram": ["content_safety", "messaging"],
  };

  return categoryMap[service] || ["content_safety"]; // Default to just content_safety if unknown
}


export default function SimplifiedPolicyEditor({
  policy,
  connectionId,
  connectionService,
  onSaved,
  onCancel,
}: SimplifiedPolicyEditorProps) {
  const connectionProvider = connectionService.split("-")[0] || connectionService;

  // Use stored securityPreset if available, otherwise infer from legacy policy settings
  const inferPreset = (): PresetTier => {
    return inferPolicyTier(policy, connectionProvider);
  };

  const [selectedPreset, setSelectedPreset] = useState<PresetTier>(inferPreset());
  const [presetChangedByUser, setPresetChangedByUser] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [presets, setPresets] = useState<Record<PresetTier, RulePreset> | null>(null);
  const [guards, setGuards] = useState<Guard[]>([]);
  const [guardCategories, setGuardCategories] = useState<GuardCategory[]>([]);
  const [enabledGuards, setEnabledGuards] = useState<Set<string>>(new Set());

  // Advanced settings
  const [allowlists, setAllowlists] = useState<AllowlistEntry[]>(
    policy.allowlists.length > 0
      ? policy.allowlists.map((a) => ({ ...a }))
      : [{ baseUrl: "", methods: ["GET"], pathPatterns: [""] }]
  );
  const [rateLimits, setRateLimits] = useState<RateLimits | null>(
    policy.rateLimits || { maxRequestsPerHour: 100 }
  );
  const [timeWindows, setTimeWindows] = useState<TimeWindow[]>(policy.timeWindows || []);

  const [saving, setSaving] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // Telegram trusted recipients state
  const isTelegram = connectionService === "telegram";
  const [tgAccess, setTgAccess] = useState<"anyone" | "specific">(
    (policy.providerConstraints?.allowedChatIds?.length ?? 0) > 0 ? "specific" : "anyone",
  );
  const [tgChatIds, setTgChatIds] = useState<{ id: string; label?: string }[]>(
    (policy.providerConstraints?.allowedChatIds ?? []).map((id) => ({ id })),
  );
  const [tgChatInput, setTgChatInput] = useState("");

  // Slack channel/user access state
  const isSlack = connectionService === "slack";
  const [slackChannelAccess, setSlackChannelAccess] = useState<"any" | "specific">(
    (policy.providerConstraints?.allowedChannelIds?.length ?? 0) > 0 ? "specific" : "any",
  );
  const [slackChannelIds, setSlackChannelIds] = useState<{ id: string; label?: string }[]>(
    (policy.providerConstraints?.allowedChannelIds ?? []).map((id) => ({ id })),
  );
  const [slackUserAccess, setSlackUserAccess] = useState<"anyone" | "specific">(
    (policy.providerConstraints?.allowedUserIds?.length ?? 0) > 0 ? "specific" : "anyone",
  );
  const [slackUserIds, setSlackUserIds] = useState<{ id: string; label?: string }[]>(
    (policy.providerConstraints?.allowedUserIds ?? []).map((id) => ({ id })),
  );
  const [slackChannelInput, setSlackChannelInput] = useState("");
  const [slackUserInput, setSlackUserInput] = useState("");
  const [slackChannelsLoading, setSlackChannelsLoading] = useState(false);
  const [slackChannelsAvailable, setSlackChannelsAvailable] = useState<{ id: string; name: string; isPrivate: boolean; memberCount: number }[]>([]);
  const [slackChannelSearch, setSlackChannelSearch] = useState("");
  const [slackChannelManualMode, setSlackChannelManualMode] = useState(false);
  const [slackUsersLoading, setSlackUsersLoading] = useState(false);
  const [slackUsersAvailable, setSlackUsersAvailable] = useState<{ id: string; name: string; displayName: string; isBot: boolean }[]>([]);
  const [slackUserSearch, setSlackUserSearch] = useState("");
  const [slackUserManualMode, setSlackUserManualMode] = useState(false);

  // Fetch presets and guards on mount to show what each preset includes
  useEffect(() => {
    async function fetchPresetsAndGuards() {
      try {
        // Fetch presets
        const presetsRes = await apiFetch(`/templates/${connectionService}/rules?connectionId=${connectionId}`);
        if (presetsRes.ok) {
          const data = await presetsRes.json() as { presets: RulePreset[] };
          const presetMap: Record<PresetTier, RulePreset> = {
            minimal: data.presets.find(p => p.id === "minimal")!,
            standard: data.presets.find(p => p.id === "standard")!,
            strict: data.presets.find(p => p.id === "strict")!,
          };
          setPresets(presetMap);
        }

        // Fetch guards and categories
        const provider = connectionService.split("-")[0]; // e.g., "google-gmail" -> "google"
        const guardsRes = await apiFetch(`/templates/${provider}/guards`);
        if (guardsRes.ok) {
          const guardsData = await guardsRes.json() as { guards: Guard[]; categories: GuardCategory[] };

          // Filter guards by service-relevant categories
          const relevantCategories = getRelevantCategoriesForService(connectionService);
          const filteredGuards = guardsData.guards.filter(g =>
            relevantCategories.includes(g.category)
          );

          setGuards(filteredGuards);
          setGuardCategories(guardsData.categories.filter(c =>
            relevantCategories.includes(c.id)
          ));
        }
      } catch (err) {
        console.error("Failed to fetch presets/guards:", err);
      }
    }
    fetchPresetsAndGuards();
  }, [connectionId, connectionService]);

  // Get guards for a specific preset tier
  const getGuardsForPreset = (tier: PresetTier): Guard[] => {
    if (tier === "minimal") return []; // Minimal has no guards
    return guards.filter(g => g.presetTier === tier || (tier === "strict" && g.presetTier === "standard"));
  };

  // Auto-enable guards when preset changes
  useEffect(() => {
    if (guards.length === 0) return;
    const presetGuards = getGuardsForPreset(selectedPreset);
    setEnabledGuards(new Set(presetGuards.map(g => g.id)));
  }, [selectedPreset, guards]);

  // Refresh allowlists, rate limits, and time windows when user changes the preset
  const templateId = policy.actionTemplateId || connectionService;
  useEffect(() => {
    if (!presetChangedByUser || !templateId) return;

    async function fetchTemplateConfig() {
      setLoadingConfig(true);
      try {
        const res = await apiFetch(
          `/templates/${templateId}/config?tier=${selectedPreset}`
        );
        if (!res.ok) return;
        const config = await res.json() as {
          allowlists: AllowlistEntry[];
          rateLimits: RateLimits | null;
          timeWindows: TimeWindow[];
        };
        setAllowlists(config.allowlists.length > 0
          ? config.allowlists
          : [{ baseUrl: "", methods: ["GET"], pathPatterns: [""] }]
        );
        setRateLimits(config.rateLimits || { maxRequestsPerHour: 100 });
        setTimeWindows(config.timeWindows || []);
      } catch (err) {
        console.error("Failed to fetch template config:", err);
      } finally {
        setLoadingConfig(false);
      }
    }

    fetchTemplateConfig();
  }, [selectedPreset, presetChangedByUser, templateId]);

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

  // Check if guards have been customized from preset defaults
  const isCustomized = (): boolean => {
    const presetGuards = new Set(getGuardsForPreset(selectedPreset).map(g => g.id));
    if (presetGuards.size !== enabledGuards.size) return true;
    for (const id of enabledGuards) {
      if (!presetGuards.has(id)) return true;
    }
    return false;
  };

  async function loadSlackChannels() {
    setSlackChannelsLoading(true);
    try {
      const res = await apiFetch(`/connections/${connectionId}/lookup`, {
        method: "POST",
        body: JSON.stringify({ type: "channels" }),
      });
      const data = await res.json();
      if (data.items) setSlackChannelsAvailable(data.items);
    } catch { /* ignore */ }
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
    } catch { /* ignore */ }
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

  function addSlackChannelManual() {
    const id = slackChannelInput.trim();
    if (id && !slackChannelIds.some((e) => e.id === id)) {
      setSlackChannelIds((prev) => [...prev, { id }]);
      setSlackChannelInput("");
    }
  }

  function addSlackUserManual() {
    const id = slackUserInput.trim();
    if (id && !slackUserIds.some((e) => e.id === id)) {
      setSlackUserIds((prev) => [...prev, { id }]);
      setSlackUserInput("");
    }
  }

  function addTgChatId() {
    const id = tgChatInput.trim();
    if (id && !tgChatIds.some((e) => e.id === id)) {
      setTgChatIds((prev) => [...prev, { id }]);
      setTgChatInput("");
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      // Map preset to policy settings
      let defaultMode: "read_only" | "read_write" | "custom" = "read_only";
      let stepUpApproval: "never" | "risk_based" | "always" = "never";

      if (selectedPreset === "minimal") {
        defaultMode = "read_only";
        stepUpApproval = "never";
      } else if (selectedPreset === "standard") {
        defaultMode = "read_write";
        stepUpApproval = "risk_based";
      } else if (selectedPreset === "strict") {
        defaultMode = "custom";
        stepUpApproval = "always";
      }

      // Update policy
      const updateRes = await apiFetch(`/policies/${policy.id}`, {
        method: "PUT",
        body: JSON.stringify({
          defaultMode,
          stepUpApproval,
          allowedModels: policy.allowedModels,
          providerConstraints: policy.providerConstraints,
          securityPreset: selectedPreset,
        }),
      });

      if (!updateRes.ok) {
        throw new Error("Failed to update policy");
      }

      // Update allowlists if changed
      const allowlistRes = await apiFetch(`/policies/${policy.id}/allowlists`, {
        method: "PUT",
        body: JSON.stringify({ allowlists: allowlists.filter(a => a.baseUrl) }),
      });

      if (!allowlistRes.ok) {
        throw new Error("Failed to update allowlists");
      }

      // Update rate limits if changed
      if (rateLimits) {
        const rateLimitRes = await apiFetch(`/policies/${policy.id}/rate-limits`, {
          method: "PUT",
          body: JSON.stringify(rateLimits),
        });

        if (!rateLimitRes.ok) {
          throw new Error("Failed to update rate limits");
        }
      } else {
        // Delete rate limits
        await apiFetch(`/policies/${policy.id}/rate-limits`, { method: "DELETE" });
      }

      // Update time windows if changed (skip for services where time windows are hidden)
      if (connectionService !== "telegram") {
        const timeWindowRes = await apiFetch(`/policies/${policy.id}/time-windows`, {
          method: "PUT",
          body: JSON.stringify({ timeWindows }),
        });

        if (!timeWindowRes.ok) {
          throw new Error("Failed to update time windows");
        }
      }

      // Rules are generated server-side from the securityPreset via
      // generatePolicyFromTemplate(). The dashboard never sends rules
      // directly — the server is the sole authority on rule content.

      // Update Telegram provider constraints
      if (isTelegram) {
        const chatIds = tgAccess === "specific" ? tgChatIds.map((e) => e.id) : [];
        const pcRes = await apiFetch(`/policies/${policy.id}/provider-constraints`, {
          method: "PUT",
          body: JSON.stringify({
            providerConstraints: chatIds.length > 0
              ? { provider: "telegram", allowedChatIds: chatIds }
              : null,
          }),
        });
        if (!pcRes.ok) {
          throw new Error("Failed to update Telegram access settings");
        }
      }

      // Update Slack provider constraints
      if (isSlack) {
        const chIds = slackChannelAccess === "specific" ? slackChannelIds.map((e) => e.id) : [];
        const uIds = slackUserAccess === "specific" ? slackUserIds.map((e) => e.id) : [];
        const hasConstraints = chIds.length > 0 || uIds.length > 0;
        const pcRes = await apiFetch(`/policies/${policy.id}/provider-constraints`, {
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
        if (!pcRes.ok) {
          throw new Error("Failed to update Slack access settings");
        }
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save policy");
      // Scroll error into view — it renders at the top of the form
      setTimeout(() => errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div ref={errorRef} className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {/* Telegram Trusted Recipients */}
      {isTelegram && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-2">Who can the agent interact with?</h3>
          <div className="space-y-2">
            <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${tgAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
              <input type="radio" name="spe-tg-access" value="anyone" checked={tgAccess === "anyone"}
                onChange={() => setTgAccess("anyone")}
                className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
              <div>
                <span className="text-sm font-medium text-foreground">Anyone</span>
                <p className="text-xs text-muted mt-0.5">The agent can send and receive messages with any Telegram user.</p>
              </div>
            </label>
            <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${tgAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
              <input type="radio" name="spe-tg-access" value="specific" checked={tgAccess === "specific"}
                onChange={() => setTgAccess("specific")}
                className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
              <div>
                <span className="text-sm font-medium text-foreground">Only specific people</span>
                <p className="text-xs text-muted mt-0.5">Only listed users can interact — everyone else is blocked.</p>
              </div>
            </label>
          </div>

          {tgAccess === "specific" && (
            <div className="mt-2 rounded-lg border border-border bg-gray-50 p-3 space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={tgChatInput}
                  onChange={(e) => setTgChatInput(e.target.value)}
                  placeholder="Telegram User ID (e.g. 123456789)"
                  className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTgChatId(); } }}
                />
                <button
                  type="button"
                  onClick={addTgChatId}
                  disabled={!tgChatInput.trim()}
                  className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add
                </button>
              </div>
              {tgChatIds.length > 0 ? (
                <div className="space-y-1">
                  {tgChatIds.map((entry, i) => (
                    <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-2">
                      <span className="text-sm font-mono text-foreground">{entry.id}</span>
                      <button
                        type="button"
                        onClick={() => setTgChatIds((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-red-400 hover:text-red-600 text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted text-center py-1">No users added yet. Add at least one Telegram user ID.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Slack Channel/User Access (before preset, matching create wizard order) */}
      {isSlack && (
        <div className="space-y-4">
          {/* Channel access */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-2">Channel Access</h3>
            <div className="space-y-2">
              <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${slackChannelAccess === "any" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                <input type="radio" name="spe-slack-channel" value="any" checked={slackChannelAccess === "any"}
                  onChange={() => setSlackChannelAccess("any")}
                  className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                <div>
                  <span className="text-sm font-medium text-foreground">Any channel</span>
                  <p className="text-xs text-muted mt-0.5">Open to all channels.</p>
                </div>
              </label>
              <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${slackChannelAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                <input type="radio" name="spe-slack-channel" value="specific" checked={slackChannelAccess === "specific"}
                  onChange={() => setSlackChannelAccess("specific")}
                  className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                <div>
                  <span className="text-sm font-medium text-foreground">Only specific channels</span>
                  <p className="text-xs text-muted mt-0.5">All other channels are blocked.</p>
                </div>
              </label>
            </div>

            {slackChannelAccess === "specific" && (
              <div className="mt-2 rounded-lg border border-border bg-gray-50 p-3 space-y-2">
                {slackChannelsAvailable.length === 0 && !slackChannelManualMode && (
                  <button type="button" onClick={loadSlackChannels} disabled={slackChannelsLoading}
                    className="w-full rounded-md border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                    {slackChannelsLoading ? "Loading channels..." : "Load channels from Slack"}
                  </button>
                )}

                {slackChannelsAvailable.length > 0 && (
                  <>
                    <input type="text" value={slackChannelSearch} onChange={(e) => setSlackChannelSearch(e.target.value)}
                      placeholder="Search channels..."
                      className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
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

                {slackChannelIds.length > 0 && slackChannelsAvailable.length === 0 && (
                  <div className="space-y-1">
                    {slackChannelIds.map((entry, i) => (
                      <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">#</span>
                          <span className="text-sm font-mono text-foreground">{entry.label || entry.id}</span>
                        </div>
                        <button type="button" onClick={() => setSlackChannelIds((prev) => prev.filter((_, idx) => idx !== i))}
                          className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                      </div>
                    ))}
                  </div>
                )}

                {slackChannelIds.length === 0 && slackChannelsAvailable.length === 0 && !slackChannelsLoading && (
                  <p className="text-xs text-muted text-center py-1">No channels selected yet.</p>
                )}

                {slackChannelsAvailable.length > 0 && slackChannelIds.length > 0 && (
                  <p className="text-xs text-muted">{slackChannelIds.length} channel{slackChannelIds.length !== 1 ? "s" : ""} selected</p>
                )}
              </div>
            )}
          </div>

          {/* User access */}
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-2">User Access</h3>
            <div className="space-y-2">
              <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${slackUserAccess === "anyone" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                <input type="radio" name="spe-slack-user" value="anyone" checked={slackUserAccess === "anyone"}
                  onChange={() => setSlackUserAccess("anyone")}
                  className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                <div>
                  <span className="text-sm font-medium text-foreground">Anyone</span>
                  <p className="text-xs text-muted mt-0.5">Messages from any user visible.</p>
                </div>
              </label>
              <label className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 cursor-pointer transition-all ${slackUserAccess === "specific" ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-300"}`}>
                <input type="radio" name="spe-slack-user" value="specific" checked={slackUserAccess === "specific"}
                  onChange={() => setSlackUserAccess("specific")}
                  className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500" />
                <div>
                  <span className="text-sm font-medium text-foreground">Only specific people</span>
                  <p className="text-xs text-muted mt-0.5">Messages from all other users are filtered out.</p>
                </div>
              </label>
            </div>

            {slackUserAccess === "specific" && (
              <div className="mt-2 rounded-lg border border-border bg-gray-50 p-3 space-y-2">
                {slackUsersAvailable.length === 0 && !slackUserManualMode && (
                  <button type="button" onClick={loadSlackUsers} disabled={slackUsersLoading}
                    className="w-full rounded-md border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                    {slackUsersLoading ? "Loading users..." : "Load users from Slack"}
                  </button>
                )}

                {slackUsersAvailable.length > 0 && (
                  <>
                    <input type="text" value={slackUserSearch} onChange={(e) => setSlackUserSearch(e.target.value)}
                      placeholder="Search users..."
                      className="block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-foreground shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-white divide-y divide-border">
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

                {slackUserIds.length > 0 && slackUsersAvailable.length === 0 && (
                  <div className="space-y-1">
                    {slackUserIds.map((entry, i) => (
                      <div key={i} className="flex items-center justify-between rounded-md bg-white border border-border px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                            {(entry.label || entry.id).charAt(0).toUpperCase()}
                          </span>
                          <span className="text-sm font-mono text-foreground">{entry.label || entry.id}</span>
                        </div>
                        <button type="button" onClick={() => setSlackUserIds((prev) => prev.filter((_, idx) => idx !== i))}
                          className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                      </div>
                    ))}
                  </div>
                )}

                {slackUserIds.length === 0 && slackUsersAvailable.length === 0 && !slackUsersLoading && (
                  <p className="text-xs text-muted text-center py-1">No users selected yet.</p>
                )}

                {slackUsersAvailable.length > 0 && slackUserIds.length > 0 && (
                  <p className="text-xs text-muted">{slackUserIds.length} user{slackUserIds.length !== 1 ? "s" : ""} selected</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Preset Selection */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Security Preset</h3>
        {presets && (
          <div className="grid grid-cols-3 gap-2">
            {(["minimal", "standard", "strict"] as const).map((tier) => {
              const preset = presets[tier];
              const hasTelegram = connectionService === "telegram";
              const hasSlack = connectionService === "slack";
              const adaptedDescription = hasTelegram
                ? adaptTelegramDescription(preset.description, tier, tgAccess === "specific" && tgChatIds.length > 0)
                : hasSlack
                  ? adaptSlackDescription(preset.description, tier, !!(policy.providerConstraints?.allowedChannelIds?.length || policy.providerConstraints?.allowedUserIds?.length))
                  : undefined;
              return (
                <PresetCard
                  key={tier}
                  preset={preset}
                  selected={selectedPreset === tier}
                  onClick={() => { setSelectedPreset(tier); setPresetChangedByUser(true); }}
                  {...(adaptedDescription !== undefined && { description: adaptedDescription })}
                  isRecommended={tier === "standard"}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Advanced Configuration (Collapsible) */}
      <div className="border border-border rounded-lg">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
        >
          <span className="text-sm font-semibold text-foreground">Advanced Configuration</span>
          <svg
            className={`h-5 w-5 text-muted transition-transform ${showAdvanced ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showAdvanced && (
          <div className="px-4 pb-4 space-y-6 border-t border-border pt-4">
            {/* Allowlists */}
            <div>
              <h4 className="text-sm font-medium text-foreground mb-2">Allowlists</h4>
              <p className="text-xs text-muted mb-3">Define which API endpoints this agent can access</p>
              <div className="space-y-3">
                {allowlists.map((entry, idx) => (
                  <div key={idx} className="border border-border rounded p-3 space-y-2">
                    <input
                      type="text"
                      placeholder="Base URL (e.g., https://www.googleapis.com)"
                      value={entry.baseUrl}
                      onChange={(e) => {
                        const updated = [...allowlists];
                        updated[idx]!.baseUrl = e.target.value;
                        setAllowlists(updated);
                      }}
                      className="w-full rounded border border-border px-3 py-2 text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Path patterns (comma-separated, e.g., /gmail/v1/*)"
                      value={entry.pathPatterns.join(", ")}
                      onChange={(e) => {
                        const updated = [...allowlists];
                        updated[idx]!.pathPatterns = e.target.value.split(",").map(p => p.trim()).filter(Boolean);
                        setAllowlists(updated);
                      }}
                      className="w-full rounded border border-border px-3 py-2 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      {["GET", "POST", "PUT", "DELETE", "PATCH"].map((method) => (
                        <label key={method} className="flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={entry.methods.includes(method as any)}
                            onChange={(e) => {
                              const updated = [...allowlists];
                              if (e.target.checked) {
                                updated[idx]!.methods = [...updated[idx]!.methods, method as any];
                              } else {
                                updated[idx]!.methods = updated[idx]!.methods.filter(m => m !== method);
                              }
                              setAllowlists(updated);
                            }}
                          />
                          {method}
                        </label>
                      ))}
                      <button
                        onClick={() => setAllowlists(allowlists.filter((_, i) => i !== idx))}
                        className="ml-auto text-xs text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => setAllowlists([...allowlists, { baseUrl: "", methods: ["GET"], pathPatterns: [""] }])}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  + Add Allowlist Rule
                </button>
              </div>
            </div>

            {/* Rate Limits */}
            <div>
              <h4 className="text-sm font-medium text-foreground mb-2">Rate Limits</h4>
              <p className="text-xs text-muted mb-3">Configure request rate limits and payload constraints</p>
              {rateLimits ? (
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-muted mb-1">Max Requests per Hour</label>
                    <input
                      type="number"
                      value={rateLimits.maxRequestsPerHour}
                      onChange={(e) => setRateLimits({ ...rateLimits, maxRequestsPerHour: parseInt(e.target.value) || 100 })}
                      className="w-full rounded border border-border px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted mb-1">Max Payload Size (bytes, optional)</label>
                    <input
                      type="number"
                      placeholder="e.g., 1048576 for 1MB"
                      value={rateLimits.maxPayloadSizeBytes || ""}
                      onChange={(e) => { const v = parseInt(e.target.value); const { maxPayloadSizeBytes: _, ...rest } = rateLimits; setRateLimits(v ? { ...rest, maxPayloadSizeBytes: v } : rest); }}
                      className="w-full rounded border border-border px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted mb-1">Max Response Size (bytes, optional)</label>
                    <input
                      type="number"
                      placeholder="e.g., 10485760 for 10MB"
                      value={rateLimits.maxResponseSizeBytes || ""}
                      onChange={(e) => { const v = parseInt(e.target.value); const { maxResponseSizeBytes: _, ...rest } = rateLimits; setRateLimits(v ? { ...rest, maxResponseSizeBytes: v } : rest); }}
                      className="w-full rounded border border-border px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    onClick={() => setRateLimits(null)}
                    className="text-xs text-red-600 hover:text-red-700"
                  >
                    Remove Rate Limits
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setRateLimits({ maxRequestsPerHour: 100 })}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  + Add Rate Limits
                </button>
              )}
            </div>

            {/* Time Windows (hidden for Telegram and LLM providers) */}
            {connectionService !== "telegram" && !LLM_PROVIDERS.has(connectionService.split("-")[0]!) && (
            <div>
              <h4 className="text-sm font-medium text-foreground mb-2">Time Windows</h4>
              <p className="text-xs text-muted mb-3">Restrict when this policy is active</p>
              <div className="space-y-2">
                {timeWindows.map((tw, idx) => (
                  <div key={idx} className="flex items-center gap-2 border border-border rounded p-2">
                    <select
                      value={tw.dayOfWeek}
                      onChange={(e) => {
                        const updated = [...timeWindows];
                        updated[idx]!.dayOfWeek = parseInt(e.target.value) as any;
                        setTimeWindows(updated);
                      }}
                      className="rounded border border-border px-2 py-1 text-xs"
                    >
                      {DAY_NAMES.map((day, i) => (
                        <option key={i} value={i}>{day}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0"
                      max="23"
                      value={tw.startHour}
                      onChange={(e) => {
                        const updated = [...timeWindows];
                        updated[idx]!.startHour = parseInt(e.target.value) || 0;
                        setTimeWindows(updated);
                      }}
                      className="w-16 rounded border border-border px-2 py-1 text-xs"
                    />
                    <span className="text-xs text-muted">to</span>
                    <input
                      type="number"
                      min="0"
                      max="23"
                      value={tw.endHour}
                      onChange={(e) => {
                        const updated = [...timeWindows];
                        updated[idx]!.endHour = parseInt(e.target.value) || 23;
                        setTimeWindows(updated);
                      }}
                      className="w-16 rounded border border-border px-2 py-1 text-xs"
                    />
                    <input
                      type="text"
                      placeholder="Timezone (e.g., America/New_York)"
                      value={tw.timezone}
                      onChange={(e) => {
                        const updated = [...timeWindows];
                        updated[idx]!.timezone = e.target.value;
                        setTimeWindows(updated);
                      }}
                      className="flex-1 rounded border border-border px-2 py-1 text-xs"
                    />
                    <button
                      onClick={() => setTimeWindows(timeWindows.filter((_, i) => i !== idx))}
                      className="text-xs text-red-600 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setTimeWindows([...timeWindows, { dayOfWeek: 1, startHour: 9, endHour: 17, timezone: "America/New_York" }])}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  + Add Time Window
                </button>
              </div>
            </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
        <button
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || loadingConfig}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {loadingConfig ? "Loading..." : saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
}
