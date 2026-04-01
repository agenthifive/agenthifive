export type ConnectionStatus = "healthy" | "needs_reauth" | "revoked";

export const STATUS_CONFIG: Record<
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

export interface AllowlistEntry {
  baseUrl: string;
  methods: string[];
  pathPatterns: string[];
}

export interface RateLimits {
  maxRequestsPerHour: number;
  maxPayloadSizeBytes?: number;
  maxResponseSizeBytes?: number;
}

export interface TimeWindow {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  timezone: string;
}

export interface ProviderConstraints {
  provider: string;
  allowedChatIds?: string[];
  allowedTenantIds?: string[];
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
}

export interface AgentPolicy {
  id: string;
  connectionId: string;
  actionTemplateId: string | null;
  defaultMode: "read_only" | "read_write" | "custom";
  stepUpApproval: "always" | "risk_based" | "never";
  allowedModels: string[];
  allowlists: AllowlistEntry[];
  rateLimits: RateLimits | null;
  timeWindows: TimeWindow[];
  providerConstraints: ProviderConstraints | null;
  securityPreset: string | null;
  createdAt: string;
}

export interface AgentConnection {
  connectionId: string;
  connectionLabel: string;
  connectionService: string;
  connectionProvider: string;
  connectionStatus: ConnectionStatus;
  grantedScopes: string[];
  metadata: Record<string, unknown> | null;
  connectionCreatedAt: string;
  credentialPreview?: {
    primaryLabel: string;
    primaryMasked: string;
    secondaryLabel?: string;
    secondaryMasked?: string;
    tertiaryLabel?: string;
    tertiaryValue?: string;
  } | null;
  connectionUpdatedAt?: string | undefined;
  policies: AgentPolicy[];
}

export type AgentStatus = "created" | "active" | "disabled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  status: AgentStatus;
  createdAt: string;
  connections: AgentConnection[];
}

/** Raw connection shape from GET /connections API */
export interface RawApiConnection {
  id: string;
  provider: string;
  service: string;
  label: string;
  status: string;
  grantedScopes: string[];
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt?: string | undefined;
  credentialPreview?: {
    primaryLabel: string;
    primaryMasked: string;
    secondaryLabel?: string;
    secondaryMasked?: string;
    tertiaryLabel?: string;
    tertiaryValue?: string;
  } | null;
  policies: Array<{
    id: string;
    agentId: string;
    agentName: string;
    actionTemplateId: string | null;
    defaultMode: "read_only" | "read_write" | "custom";
    stepUpApproval: "always" | "risk_based" | "never";
    allowedModels: string[];
    allowlists: AllowlistEntry[];
    rateLimits: RateLimits | null;
    timeWindows: TimeWindow[];
    providerConstraints: ProviderConstraints | null;
    securityPreset: string | null;
  }>;
}

const LLM_PROVIDER_SET = new Set(["anthropic", "openai", "gemini", "openrouter"]);

// Return the stored security preset, or infer from policy settings for legacy policies
export function inferPolicyTier(
  policy: AgentPolicy,
  connectionProvider?: string | null,
): "strict" | "standard" | "minimal" {
  // Use stored preset when available (added in security_preset column)
  if (policy.securityPreset === "strict" || policy.securityPreset === "standard" || policy.securityPreset === "minimal") {
    return policy.securityPreset;
  }

  const maxRequests = policy.rateLimits?.maxRequestsPerHour || 0;
  const timeWindowCount = policy.timeWindows.length;

  // LLM policies are special: standard and minimal both use stepUpApproval=never
  // and usually have no time windows, so infer from the tiered LLM rate limits.
  if (connectionProvider && LLM_PROVIDER_SET.has(connectionProvider)) {
    if (maxRequests > 0 && maxRequests <= 20) return "strict";
    if (maxRequests > 0 && maxRequests <= 100) return "standard";
    return "minimal";
  }

  // Legacy fallback: guess from rate limits and time windows
  if (timeWindowCount === 5 || (maxRequests > 0 && maxRequests <= 50)) {
    return "strict";
  }
  if (timeWindowCount === 7) {
    return "standard";
  }
  if (maxRequests > 0 && maxRequests <= 200 && timeWindowCount > 0) {
    return "standard";
  }
  if (timeWindowCount > 0) {
    return "standard";
  }
  return "minimal";
}

// NOTE: Removed isPolicyCustomized() function - accurate guard customization detection
// requires API calls to fetch guard definitions and compare to enabled guards.
// This is done in SimplifiedPolicyEditor where we have that data available.
