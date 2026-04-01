/**
 * Action proxy abstraction for brokered API proxying.
 *
 * When configured, an AI agent framework routes outgoing API calls (Slack,
 * MS Teams, etc.) through the AgentHiFive vault proxy instead of calling
 * provider APIs directly. This enables:
 * - Content filtering (profanity, PII)
 * - Action allowlists (block deletions, restrict sharing scope)
 * - Rate limiting (N ops per time window)
 * - Audit logging (every API call is recorded)
 */

export type ProxyRequest = {
  /** Which connection/credential to use (required for multi-account services) */
  connectionId?: string;

  /** Service ID for singleton services — vault resolves the connection server-side */
  service?: string;

  /** Target provider API */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;

  /** Context for policy evaluation */
  context?: {
    tool: string; // e.g., "slack_actions", "msteams_send"
    action: string; // e.g., "send_message", "delete_channel"
    channel?: string; // e.g., "slack", "msteams"
    agentId?: string;
  };
};

export type ProxyResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  auditId: string;
  /** If blocked by policy, this explains why */
  blocked?: {
    reason: string;
    policy: string;
  };
};

export interface ActionProxy {
  /**
   * Execute an API call through the vault proxy.
   * @param signal Optional AbortSignal — when the caller aborts, the HTTP
   *   request to the vault is also aborted, preventing orphan requests.
   */
  execute(request: ProxyRequest, signal?: AbortSignal): Promise<ProxyResponse>;
}
