import { requireOpenClawSdkCore } from "./openclaw-host.js";
import {
  buildAgentHiFiveChannelPlugin,
  setAgentHiFiveChannelRuntime,
} from "./channels/plugin.js";
import { registerAgentHiFivePlugin } from "./register.js";

const sdk = requireOpenClawSdkCore();
const plugin = buildAgentHiFiveChannelPlugin(sdk);
const configSchema = {
  schema: {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        description: "AgentHiFive Vault API base URL",
        default: "https://app.agenthifive.com",
      },
      auth: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["bearer", "agent"],
            description: "Authentication mode: 'bearer' for opaque token, 'agent' for ES256 JWT",
          },
          token: {
            type: "string",
            description: "Bearer token (only for mode=bearer)",
          },
          agentId: {
            type: "string",
            description: "Agent ID (only for mode=agent)",
          },
          privateKey: {
            type: "string",
            description: "ES256 private key as base64-encoded JWK (only for mode=agent)",
          },
          tokenAudience: {
            type: "string",
            description: "Token audience override (optional, defaults to baseUrl)",
          },
        },
        required: ["mode"],
      },
      pollTimeoutMs: {
        type: "number",
        description: "Approval polling timeout in milliseconds (default: 300000 = 5 min)",
        default: 300000,
      },
      pollIntervalMs: {
        type: "number",
        description: "Approval polling interval in milliseconds (default: 3000 = 3s)",
        default: 3000,
      },
      proxiedProviders: {
        type: "array",
        items: { type: "string" },
        description: "LLM provider IDs that should use AgentHiFive vault-managed proxy credentials",
      },
      connectedProviders: {
        type: "array",
        items: { type: "string" },
        description: "List of connected provider names for prompt injection",
      },
      debugLevel: {
        type: "string",
        enum: ["silent", "error", "warn", "info", "debug"],
        description: "AgentHiFive plugin logging verbosity",
        default: "error",
      },
    },
    required: [],
  },
};

export default sdk.defineChannelPluginEntry({
  id: "agenthifive",
  name: "AgentHiFive Channels",
  description: "Vault-managed Telegram and Slack channel plugin",
  plugin,
  configSchema: configSchema as never,
  setRuntime: setAgentHiFiveChannelRuntime,
  registerFull(api) {
    registerAgentHiFivePlugin(api);
  },
});
