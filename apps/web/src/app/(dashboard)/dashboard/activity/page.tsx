"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";

interface ActivityEvent {
  id: string;
  auditId: string;
  timestamp: string;
  actor: string;
  agentId: string | null;
  connectionId: string | null;
  action: string;
  decision: string;
  metadata: Record<string, unknown>;
  agentName: string | null;
  connectionLabel: string | null;
  connectionProvider: string | null;
}

interface FilterOption {
  id: string;
  name?: string;
  label?: string;
  provider?: string;
}

const DECISION_CONFIG: Record<string, { label: string; color: string }> = {
  allow: { label: "Success", color: "bg-green-100 text-green-700" },
  deny: { label: "Denied", color: "bg-red-100 text-red-700" },
  error: { label: "Error", color: "bg-orange-100 text-orange-700" },
};

const PROVIDER_ICONS: Record<string, string> = {
  google: "G",
  microsoft: "M",
  telegram: "T",
};

function describeEvent(event: ActivityEvent): string {
  const { action, metadata, agentName, connectionProvider } = event;
  const agent = agentName ?? "Unknown agent";
  const meta = metadata as Record<string, unknown>;
  const path = formatPath(meta.path ?? meta.url);

  switch (action) {
    case "token_vended":
      return `${agent} obtained access token${connectionProvider ? ` via ${connectionProvider}` : ""}`;

    case "token_vend_denied":
      return `${agent} token request denied${meta.reason ? `: ${meta.reason}` : ""}`;

    case "execution_requested":
      return `${agent} requested ${meta.method ?? "HTTP"}${path ? ` ${path}` : ""}`;

    case "execution_completed": {
      const method = meta.method ?? "HTTP";
      const status = meta.responseStatus ? ` (${meta.responseStatus})` : "";
      return `${agent} executed ${method}${path ? ` ${path}` : ""}${status}`;
    }

    case "execution_denied":
      return `${agent} denied${path ? ` ${meta.method ?? "HTTP"} ${path}` : ""}${meta.reason ? ` — ${meta.reason}` : ""}`;

    case "execution_error":
      return `${agent} execution failed${path ? ` ${path}` : ""}${meta.error ? ` — ${meta.error}` : ""}`;

    case "rate_limit_exceeded":
      return `${agent} rate limited${connectionProvider ? ` on ${connectionProvider}` : ""}`;

    case "connection_revoked":
      return `Connection revoked${connectionProvider ? ` (${connectionProvider})` : ""}`;

    case "connection_needs_reauth":
      return `Connection needs reauthorization${connectionProvider ? ` (${connectionProvider})` : ""}`;

    case "policy_created":
      return `Policy created for ${agent}`;

    case "policy_updated":
      return `Policy updated for ${agent}`;

    case "policy_deleted":
      return `Policy deleted for ${agent}`;

    case "approval_requested":
      return `${agent} requested approval for ${meta.method ?? ""} ${formatPath(meta.url)}`;

    case "approval_approved":
      return `Approval granted for ${agent}${path ? ` — ${meta.method ?? "HTTP"} ${path}` : ""}`;

    case "approval_denied":
      return `Approval denied for ${agent}${path ? ` — ${meta.method ?? "HTTP"} ${path}` : ""}`;

    case "approval_expired":
      return `Approval expired for ${agent}${path ? ` — ${meta.method ?? "HTTP"} ${path}` : ""}`;

    default:
      return `${agent}: ${action}`;
  }
}

/** Extract a readable API path from a URL or path string, stripping host and common prefixes */
function formatPath(urlOrPath: unknown): string {
  if (typeof urlOrPath !== "string" || !urlOrPath) return "";
  try {
    const parsed = new URL(urlOrPath);
    return parsed.pathname;
  } catch {
    // Already a path (e.g. "/gmail/v1/users/me/messages")
    return urlOrPath;
  }
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

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ACTION_ICON: Record<string, string> = {
  token_vended: "key",
  token_vend_denied: "block",
  execution_requested: "arrow",
  execution_completed: "check",
  execution_denied: "block",
  execution_error: "error",
  rate_limit_exceeded: "clock",
  connection_revoked: "revoke",
  connection_needs_reauth: "warn",
  policy_created: "plus",
  policy_updated: "edit",
  policy_deleted: "minus",
  approval_requested: "question",
  approval_approved: "check",
  approval_denied: "block",
  approval_expired: "clock",
};

function ActionIcon({ action }: { action: string }) {
  const icon = ACTION_ICON[action] ?? "dot";
  const colors: Record<string, string> = {
    key: "bg-blue-100 text-blue-600",
    block: "bg-red-100 text-red-600",
    arrow: "bg-gray-100 text-gray-600",
    check: "bg-green-100 text-green-600",
    error: "bg-orange-100 text-orange-600",
    clock: "bg-yellow-100 text-yellow-600",
    revoke: "bg-red-100 text-red-600",
    warn: "bg-yellow-100 text-yellow-600",
    plus: "bg-blue-100 text-blue-600",
    edit: "bg-purple-100 text-purple-600",
    minus: "bg-red-100 text-red-600",
    question: "bg-yellow-100 text-yellow-600",
    dot: "bg-gray-100 text-gray-600",
  };
  const symbols: Record<string, string> = {
    key: "\u{1F511}",
    block: "\u{1F6AB}",
    arrow: "\u{27A1}",
    check: "\u2713",
    error: "\u26A0",
    clock: "\u{1F552}",
    revoke: "\u2716",
    warn: "\u26A0",
    plus: "+",
    edit: "\u270E",
    minus: "\u2212",
    question: "?",
    dot: "\u2022",
  };

  return (
    <span
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${colors[icon] ?? colors["dot"]}`}
    >
      {symbols[icon] ?? symbols["dot"]}
    </span>
  );
}

export default function ActivityPage() {
  const { data: session } = useSession();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // Filters
  const [filterAgentId, setFilterAgentId] = useState("");
  const [filterConnectionId, setFilterConnectionId] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // Filter options from API
  const [agentOptions, setAgentOptions] = useState<FilterOption[]>([]);
  const [connectionOptions, setConnectionOptions] = useState<FilterOption[]>([]);

  const buildQuery = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams();
      if (filterAgentId) params.set("agentId", filterAgentId);
      if (filterConnectionId) params.set("connectionId", filterConnectionId);
      if (filterDateFrom) params.set("dateFrom", new Date(filterDateFrom).toISOString());
      if (filterDateTo) params.set("dateTo", new Date(filterDateTo).toISOString());
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      return `/activity${qs ? `?${qs}` : ""}`;
    },
    [filterAgentId, filterConnectionId, filterDateFrom, filterDateTo],
  );

  const fetchEvents = useCallback(
    async (append = false, cursor?: string) => {
      if (!append) setLoading(true);
      else setLoadingMore(true);

      try {
        const res = await apiFetch(buildQuery(cursor));
        if (!res.ok) throw new Error("Failed to fetch activity");
        const data = (await res.json()) as {
          events: ActivityEvent[];
          nextCursor: string | null;
          filters: {
            agents: FilterOption[];
            connections: FilterOption[];
          };
        };

        if (append) {
          setEvents((prev) => [...prev, ...data.events]);
        } else {
          setEvents(data.events);
        }
        setNextCursor(data.nextCursor);
        setAgentOptions(data.filters.agents);
        setConnectionOptions(data.filters.connections);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch activity");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [buildQuery],
  );

  useEffect(() => {
    if (!session) return;
    fetchEvents();
  }, [session, fetchEvents]);

  function handleLoadMore() {
    if (nextCursor) {
      fetchEvents(true, nextCursor);
    }
  }

  function handleClearFilters() {
    setFilterAgentId("");
    setFilterConnectionId("");
    setFilterDateFrom("");
    setFilterDateTo("");
  }

  const hasFilters = filterAgentId || filterConnectionId || filterDateFrom || filterDateTo;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted">Loading activity...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-bold text-foreground">Activity</h1>
        <p className="text-sm text-muted">
          Agent activity across your connected apps.
        </p>
      </div>

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

      {/* Filters */}
      <div className="mb-4 rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Agent</label>
            <select
              value={filterAgentId}
              onChange={(e) => setFilterAgentId(e.target.value)}
              className="rounded-md border border-border bg-white px-3 py-1.5 text-sm"
            >
              <option value="">All agents</option>
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Connection</label>
            <select
              value={filterConnectionId}
              onChange={(e) => setFilterConnectionId(e.target.value)}
              className="rounded-md border border-border bg-white px-3 py-1.5 text-sm"
            >
              <option value="">All connections</option>
              {connectionOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.provider})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">From</label>
            <input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="rounded-md border border-border bg-white px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">To</label>
            <input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="rounded-md border border-border bg-white px-3 py-1.5 text-sm"
            />
          </div>
          {hasFilters && (
            <button
              onClick={handleClearFilters}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted hover:text-foreground"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Timeline */}
      {events.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted">
          {hasFilters
            ? "No activity matches the selected filters."
            : "No activity yet. Events will appear here when agents interact with your connections."}
        </div>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-3 top-0 bottom-0 w-px bg-border" />

          <div className="space-y-0">
            {events.map((event) => {
              const decisionCfg = DECISION_CONFIG[event.decision];

              return (
                <div key={event.id} className="relative flex items-center gap-3 py-1.5 pl-0">
                  {/* Timeline icon */}
                  <div className="relative z-10 flex-shrink-0">
                    <ActionIcon action={event.action} />
                  </div>

                  {/* Event content — single row */}
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <p className="text-sm text-foreground truncate flex-1 min-w-0">
                      {describeEvent(event)}
                    </p>

                    {/* Connection badge */}
                    {event.connectionProvider && (
                      <span className="inline-flex items-center gap-1 flex-shrink-0">
                        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-[10px] font-bold text-gray-600">
                          {PROVIDER_ICONS[event.connectionProvider] ?? "?"}
                        </span>
                        <span className="text-xs text-muted hidden sm:inline">{event.connectionLabel}</span>
                      </span>
                    )}

                    {/* Timestamp */}
                    <span className="text-xs text-muted flex-shrink-0 hidden md:inline">{formatTimestamp(event.timestamp)}</span>
                    <span className="text-xs text-gray-400 flex-shrink-0">({timeAgo(event.timestamp)})</span>

                    {/* Decision badge */}
                    {decisionCfg && (
                      <span
                        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium flex-shrink-0 ${decisionCfg.color}`}
                      >
                        {decisionCfg.label}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Load more */}
          {nextCursor && (
            <div className="mt-6 flex justify-center">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="rounded-md border border-border bg-card px-6 py-2 text-sm font-medium text-foreground transition-colors hover:bg-gray-100 disabled:opacity-50"
              >
                {loadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
