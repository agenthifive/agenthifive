#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import {
  VaultClient,
  execute,
  connectionsList,
  connectionRevoke,
} from "@agenthifive/agenthifive";
import type {
  ExecuteInput,
  OpenClawAuthConfig,
} from "@agenthifive/agenthifive";

/**
 * Configuration for the AgentHiFive MCP server.
 * Read from environment variables.
 */
interface McpServerConfig {
  baseUrl: string;
  auth: OpenClawAuthConfig;
  pollTimeoutMs: number;
  pollIntervalMs: number;
}

function loadConfig(): McpServerConfig {
  const baseUrl = process.env.AGENTHIFIVE_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "AGENTHIFIVE_BASE_URL environment variable is required",
    );
  }

  // Auth priority:
  // 1. AGENTHIFIVE_BEARER_TOKEN — direct opaque token (testing / manual override)
  // 2. AGENTHIFIVE_PRIVATE_KEY_PATH + AGENTHIFIVE_AGENT_ID — agent auth from key file
  // 3. AGENTHIFIVE_PRIVATE_KEY (base64 JWK) + AGENTHIFIVE_AGENT_ID — agent auth inline
  let auth: OpenClawAuthConfig;

  const bearerToken = process.env.AGENTHIFIVE_BEARER_TOKEN;
  const privateKeyPath = process.env.AGENTHIFIVE_PRIVATE_KEY_PATH;
  const privateKeyBase64 = process.env.AGENTHIFIVE_PRIVATE_KEY;
  const agentId = process.env.AGENTHIFIVE_AGENT_ID;
  const tokenAudience = process.env.AGENTHIFIVE_TOKEN_AUDIENCE;

  if (bearerToken) {
    auth = { mode: "bearer", token: bearerToken };
  } else if (privateKeyPath && agentId) {
    const keyJson = readFileSync(privateKeyPath, "utf-8");
    const privateKey = JSON.parse(keyJson) as JsonWebKey;
    auth = { mode: "agent", privateKey, agentId };
    if (tokenAudience) auth.tokenAudience = tokenAudience;
  } else if (privateKeyBase64 && agentId) {
    const keyJson = Buffer.from(privateKeyBase64, "base64").toString("utf-8");
    const privateKey = JSON.parse(keyJson) as JsonWebKey;
    auth = { mode: "agent", privateKey, agentId };
    if (tokenAudience) auth.tokenAudience = tokenAudience;
  } else {
    throw new Error(
      "Auth required: set AGENTHIFIVE_BEARER_TOKEN, or " +
      "(AGENTHIFIVE_PRIVATE_KEY_PATH or AGENTHIFIVE_PRIVATE_KEY) + AGENTHIFIVE_AGENT_ID",
    );
  }

  return {
    baseUrl,
    auth,
    pollTimeoutMs: Number(process.env.AGENTHIFIVE_POLL_TIMEOUT_MS) || 300_000,
    pollIntervalMs: Number(process.env.AGENTHIFIVE_POLL_INTERVAL_MS) || 5_000,
  };
}

function createVaultClient(config: McpServerConfig): VaultClient {
  return new VaultClient({
    baseUrl: config.baseUrl,
    auth: config.auth,
    pollTimeoutMs: config.pollTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  });
}

/**
 * Direct HTTP fetch against the AgentHiFive API for endpoints not covered by VaultClient.
 * Uses the same VaultClient token management (the client handles auth headers).
 */
async function fetchApi(
  client: VaultClient,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<unknown> {
  if (options?.method === "POST") {
    return client.post(path, options.body);
  }
  return client.get(path);
}

/**
 * Creates and configures the MCP server with all AgentHiFive tools.
 */
export function createMcpServer(client: VaultClient): McpServer {
  const server = new McpServer({
    name: "agenthifive",
    version: "0.1.0",
  });

  // Tool: execute
  // Executes an HTTP request through the AgentHiFive Vault proxy (Model B).
  server.registerTool(
    "execute",
    {
      title: "Execute API Request",
      description:
        "Execute an HTTP request through the AgentHiFive Vault proxy (Model B). " +
        "The Vault handles authentication, policy enforcement, allowlist checking, " +
        "rate limiting, and audit logging. You never see the user's credentials. " +
        "If the response has approvalRequired=true (HTTP 202), a step-up approval " +
        "is needed. Tell the user to approve in the dashboard, then re-submit " +
        "the same request with the approvalId from the response.",
      inputSchema: {
        connectionId: z.string().optional().describe(
          "Connection ID (required for multi-account services like Google/Microsoft). Use list_connections to find IDs.",
        ),
        service: z.string().optional().describe(
          "Service ID for singleton services (e.g. 'telegram'). Use instead of connectionId for single-account services.",
        ),
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe(
          "HTTP method for the request",
        ),
        url: z.string().describe(
          "Target URL for the provider API (e.g., 'https://gmail.googleapis.com/gmail/v1/users/me/messages')",
        ),
        query: z.record(z.string(), z.string()).optional().describe(
          "Query parameters as key-value pairs",
        ),
        headers: z.record(z.string(), z.string()).optional().describe(
          "Additional headers (Authorization is injected by the Vault)",
        ),
        body: z.unknown().optional().describe(
          "Request body (for POST, PUT, PATCH methods)",
        ),
        approvalId: z.string().optional().describe(
          "Approval request ID from a previously approved step-up request. " +
          "When provided, the vault verifies the approval and skips the require_approval guard. " +
          "Get this from the approvalRequestId field of a 202 response, after the user approves it.",
        ),
      },
    },
    async ({ connectionId, service, method, url, query, headers, body, approvalId }) => {
      if (!connectionId && !service) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Either connectionId or service must be provided" }) }],
          isError: true,
        };
      }
      const input: ExecuteInput = { method, url };
      if (connectionId) input.connectionId = connectionId;
      if (service) input.service = service;
      if (query) input.query = query;
      if (headers) input.headers = headers;
      if (body !== undefined) input.body = body;
      if (approvalId) input.approvalId = approvalId;

      const result = await execute(client, input);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  // Tool: list_connections
  // Lists all connections in the current workspace.
  server.registerTool(
    "list_connections",
    {
      title: "List Connections",
      description:
        "List all connected provider accounts in the current workspace. " +
        "Shows provider type, label, status (healthy/needs_reauth/revoked), " +
        "granted scopes, and creation date for each connection.",
    },
    async () => {
      const result = await connectionsList(client);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  // Tool: revoke
  // Immediately revokes a connection.
  server.registerTool(
    "revoke",
    {
      title: "Revoke Connection",
      description:
        "Immediately revoke a connection, blocking all future token vending " +
        "and API execution through this connection. This action is immediate " +
        "and cannot be undone. Returns a confirmation with an audit trail ID.",
      inputSchema: {
        connectionId: z.string().describe(
          "The ID of the connection to revoke",
        ),
      },
    },
    async ({ connectionId }) => {
      const result = await connectionRevoke(client, { connectionId });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  // Tool: list_services
  // Discover available services and action templates.
  server.registerTool(
    "list_services",
    {
      title: "List Available Services",
      description:
        "Discover all services available on AgentHiFive (Gmail, Calendar, Drive, Teams, Outlook, Telegram). " +
        "Returns each service with its action templates (e.g., gmail-read, gmail-send). " +
        "Use this to understand what capabilities can be requested.",
    },
    async () => {
      const res = await fetchApi(client, "/v1/capabilities/services");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res) }],
      };
    },
  );

  // Tool: get_my_capabilities
  // Check the agent's current access status.
  server.registerTool(
    "get_my_capabilities",
    {
      title: "Get My Capabilities",
      description:
        "Check what services and actions the agent currently has access to. " +
        "Returns active connections (already granted), pending requests (awaiting approval), " +
        "and available actions (can be requested). Use this before requesting new capabilities.",
    },
    async () => {
      const res = await fetchApi(client, "/v1/capabilities/me");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res) }],
      };
    },
  );

  // Tool: request_capability
  // Ask the user to grant access to a capability.
  server.registerTool(
    "request_capability",
    {
      title: "Request Capability Access",
      description:
        "Request access to a specific service action (e.g., 'gmail-read' to read emails). " +
        "The workspace owner will be notified and can approve via the AgentHiFive dashboard. " +
        "Returns 409 if a request already exists or access is already granted. " +
        "Use list_services to find valid action template IDs.",
      inputSchema: {
        actionTemplateId: z.string().describe(
          "The action template ID to request (e.g., 'gmail-read', 'teams-manage')",
        ),
        reason: z.string().describe(
          "Explain why the agent needs this capability (shown to the user)",
        ),
      },
    },
    async ({ actionTemplateId, reason }) => {
      const res = await fetchApi(client, "/v1/agent-permission-requests", {
        method: "POST",
        body: { actionTemplateId, reason },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res) }],
      };
    },
  );

  // Tool: list_approvals
  // Check for pending or approved step-up approval requests.
  server.registerTool(
    "list_approvals",
    {
      title: "List Step-Up Approvals",
      description:
        "List step-up approval requests for the current workspace. " +
        "Use this after a vault_execute call returns approvalRequired=true to check " +
        "if the user has approved your request. When status is 'approved', re-submit " +
        "the original request with the approvalId to execute it.",
    },
    async () => {
      const res = await fetchApi(client, "/v1/approvals");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res) }],
      };
    },
  );

  return server;
}

/**
 * Main entry point for the MCP server.
 * Reads configuration from environment variables and starts the stdio transport.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = createVaultClient(config);
  const server = createMcpServer(client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when executed directly (not imported as a module)
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const thisFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? resolve(process.argv[1]) : "";

if (thisFile === entryFile) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`AgentHiFive MCP server error: ${message}\n`);
    process.exit(1);
  });
}
