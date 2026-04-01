"use client";

const TRUSTED_RECIPIENT_PII_REDACT_RULE_LABEL = "Redact PII outside trusted recipient scope";

export type RuleAction = "allow" | "deny" | "require_approval";

export const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  allow: { label: "Allow", color: "bg-green-100 text-green-700" },
  deny: { label: "Deny", color: "bg-red-100 text-red-700" },
  require_approval: { label: "Approval", color: "bg-yellow-100 text-yellow-700" },
};

/** Minimal preset shape required by PresetCard — structurally compatible with richer local types */
export interface PresetCardPreset {
  id: string;
  name: string;
  description: string;
  rateLimitLabel?: string;
  features?: string[];
  rules: {
    request: Array<{ label?: string; action: string }>;
    response: unknown[];
  };
}

/** Return Telegram preset description adapted for trusted list state */
export function adaptTelegramDescription(description: string, presetId: string, hasTrustedRecipients: boolean): string {
  if (!hasTrustedRecipients) return description;
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
export function adaptSlackDescription(description: string, presetId: string, hasTrustedList: boolean): string {
  if (!hasTrustedList) return description;
  if (presetId === "minimal") {
    return "Only users and channels on your trusted list can interact with the agent — everyone else is blocked. No approval required, no privacy filtering.";
  }
  if (presetId === "standard") {
    return "Only users and channels on your trusted list can interact with the agent — everyone else is blocked. Sending does not require approval for trusted channels. Personal information is redacted outside your trusted list.";
  }
  // strict
  return "Only users and channels on your trusted list can interact with the agent — everyone else is blocked. Sending does not require approval for trusted channels. Message deletion and pin removal are blocked. Personal information is redacted from responses.";
}

interface PresetCardProps {
  preset: PresetCardPreset;
  selected: boolean;
  onClick: () => void;
  /** Override preset.description (e.g. adapted Telegram/Slack description) */
  description?: string;
  isRecommended?: boolean;
  disabled?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onViewSettings?: (preset: any) => void;
}

function getResponseFeatureLabel(responseRules: unknown[]): string {
  const hasTrustedRecipientScopedRedaction = responseRules.some((rule) => {
    if (!rule || typeof rule !== "object") return false;
    const label = (rule as { label?: unknown }).label;
    return label === TRUSTED_RECIPIENT_PII_REDACT_RULE_LABEL;
  });
  return hasTrustedRecipientScopedRedaction
    ? "+ Personal information redaction outside trusted list"
    : "+ Personal information redaction";
}

export default function PresetCard({
  preset,
  selected,
  onClick,
  description,
  isRecommended,
  disabled,
  onViewSettings,
}: PresetCardProps) {
  return (
    <div
      className={`rounded-lg border-2 px-4 py-3 text-left text-sm transition-all flex flex-col ${disabled ? "cursor-not-allowed" : "cursor-pointer"} ${
        selected
          ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500"
          : "border-border hover:border-blue-300 hover:bg-gray-50"
      }`}
      onClick={() => !disabled && onClick()}
    >
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className={`font-semibold ${selected ? "text-blue-700" : "text-foreground"}`}>
            {preset.name}
          </span>
          {isRecommended && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-600">
              Recommended
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          {description ?? preset.description}
        </p>
        {preset.rateLimitLabel && (
          <div className="mt-1 text-xs font-medium text-blue-700 bg-blue-50 rounded px-1.5 py-0.5 inline-block">
            {preset.rateLimitLabel}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {preset.rules.request.map((rule, ri) => (
            <span
              key={ri}
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${
                ACTION_LABELS[rule.action]?.color ?? "bg-gray-100 text-gray-700"
              }`}
            >
              {rule.label || rule.action}
            </span>
          ))}
          {preset.features?.map((feature, fi) => (
            <span
              key={`f-${fi}`}
              className="inline-flex items-center rounded px-1.5 py-0.5 text-xs bg-yellow-100 text-yellow-700"
            >
              {feature}
            </span>
          ))}
          {preset.rules.response.length > 0 && (
            <span className="text-xs text-muted">{getResponseFeatureLabel(preset.rules.response)}</span>
          )}
        </div>
      </div>
      {onViewSettings && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); !disabled && onViewSettings(preset); }}
            className={`text-xs font-medium ${disabled ? "text-gray-400 cursor-not-allowed" : "text-blue-600 hover:text-blue-700"}`}
            disabled={disabled}
          >
            View settings →
          </button>
        </div>
      )}
    </div>
  );
}
