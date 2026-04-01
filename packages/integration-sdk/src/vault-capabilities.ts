/**
 * Capability cache for AgentHiFive vault integration.
 *
 * Caches the response from GET /v1/capabilities/me with:
 * - activeConnections: connections with policies for this agent
 * - pendingRequests: this agent's pending permission requests
 * - availableActions: action templates not yet requested
 *
 * The cache has a configurable TTL (default 60s) to balance freshness with API load.
 */

export interface CapabilityCacheEntry {
  activeConnections: Array<{
    connectionId: string;
    service: string;
    label: string;
    actionTemplateId: string | null;
  }>;
  pendingRequests: Array<{
    id: string;
    actionTemplateId: string;
    reason: string;
    requestedAt: string;
  }>;
  availableActions: Array<{
    id: string;
    serviceId: string;
    label: string;
    description: string;
    requiresApproval: boolean;
  }>;
  fetchedAt: number;
  ttl: number;
}

export interface CapabilityCache {
  /** Fetch capabilities from the vault API. Caches the result for TTL duration. */
  fetch(): Promise<CapabilityCacheEntry>;

  /** Check if the cache is expired (past TTL). */
  isExpired(): boolean;

  /** Check if the agent has an active connection for the given action template ID. */
  hasActiveConnection(actionTemplateId: string): boolean;

  /** Check if there's a pending permission request for the given action template ID. */
  hasPendingRequest(actionTemplateId: string): boolean;

  /** Get an available action template by ID. */
  getAvailableAction(actionTemplateId: string): {
    id: string;
    serviceId: string;
    label: string;
    description: string;
    requiresApproval: boolean;
  } | null;

  /** Invalidate the cache, forcing a fresh fetch on next access. */
  invalidate(): void;
}

export class VaultCapabilityCache implements CapabilityCache {
  private cache: CapabilityCacheEntry | null = null;
  private baseUrl: string;
  private authHeaders: Record<string, string>;
  private defaultTtl: number;
  private timeoutMs: number;

  constructor(config: {
    baseUrl: string;
    authHeaders: Record<string, string>;
    cacheTtl?: number;
    timeoutMs?: number;
  }) {
    this.baseUrl = config.baseUrl;
    this.authHeaders = config.authHeaders;
    this.defaultTtl = config.cacheTtl ?? 60_000;
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  async fetch(): Promise<CapabilityCacheEntry> {
    if (this.cache && !this.isExpired()) {
      return this.cache;
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/capabilities/me`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Vault capabilities API returned ${response.status}`);
      }

      const data = (await response.json()) as {
        activeConnections: CapabilityCacheEntry["activeConnections"];
        pendingRequests: CapabilityCacheEntry["pendingRequests"];
        availableActions: CapabilityCacheEntry["availableActions"];
      };

      this.cache = {
        ...data,
        fetchedAt: Date.now(),
        ttl: this.defaultTtl,
      };

      return this.cache;
    } catch (error) {
      if (this.cache) {
        return this.cache;
      }
      throw error;
    }
  }

  isExpired(): boolean {
    if (!this.cache) {
      return true;
    }
    return Date.now() > this.cache.fetchedAt + this.cache.ttl;
  }

  hasActiveConnection(actionTemplateId: string): boolean {
    if (!this.cache) {
      return false;
    }
    return this.cache.activeConnections.some((conn) => conn.actionTemplateId === actionTemplateId);
  }

  hasPendingRequest(actionTemplateId: string): boolean {
    if (!this.cache) {
      return false;
    }
    return this.cache.pendingRequests.some((req) => req.actionTemplateId === actionTemplateId);
  }

  getAvailableAction(actionTemplateId: string) {
    if (!this.cache) {
      return null;
    }
    return this.cache.availableActions.find((action) => action.id === actionTemplateId) ?? null;
  }

  invalidate(): void {
    this.cache = null;
  }
}
