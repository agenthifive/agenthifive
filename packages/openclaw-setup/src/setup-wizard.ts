/**
 * AgentHiFive standalone setup CLI.
 *
 * Three modes of operation:
 * 1. First-time setup — full install + auth + config + patch
 * 2. Change default LLM — re-pick model using existing auth
 * 3. Reconnect to vault — new bootstrap secret, re-auth, update config + re-patch
 *
 * Plus --verify for diagnostics (handled in cli.ts).
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { VaultTokenManager } from "./vault-token-manager.js";
import {
  resolveOpenClawConfigPath,
  defaultConfigPath,
  readExistingConfig,
  mergePluginConfig,
} from "./config-discovery.js";
import {
  findOpenClawInstallDir,
  validateOpenClawDir,
  applyPatch,
  applyBroadcastPatch,
} from "./auto-patch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SetupMode =
  | "setup"
  | "configure-connections"
  | "change-model"
  | "reconnect"
  | "sync"
  | "verify"
  | "remove";

export interface SetupOptions {
  mode?: SetupMode;
  baseUrl?: string;
  bootstrapSecret?: string;
  nonInteractive?: boolean;
  configPath?: string;
  openclawDir?: string;
  skipOnboard?: boolean;
  skipPluginInstall?: boolean;
  defaultModel?: string;
}

interface VaultConnection {
  connectionId: string | null;
  service: string;
  provider: string;
  status: string;
  credentialType: string;
  category: string;
  displayName: string;
  label: string;
  actionTemplateId: string;
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function isOpenClawInstalled(): boolean {
  try {
    execSync("openclaw --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isOnboarded(): boolean {
  const configPath = resolveOpenClawConfigPath();
  if (configPath) return true;
  const stateDir = path.join(os.homedir(), ".openclaw");
  return existsSync(stateDir);
}

async function checkVaultReachable(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${baseUrl}/v1/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: `server returned ${response.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
      return { ok: false, error: `cannot connect to ${baseUrl}` };
    }
    if (msg.includes("AbortError") || msg.includes("timed out")) {
      return { ok: false, error: `connection timed out after 5s` };
    }
    return { ok: false, error: msg };
  }
}

async function promptBaseUrl(
  log: LogFn,
  defaultValue: string,
  opts: { nonInteractive?: boolean },
): Promise<string> {
  let baseUrl: string;

  if (opts.nonInteractive) {
    baseUrl = defaultValue;
  } else {
    baseUrl = await prompt("  AgentHiFive base URL", defaultValue);
  }
  baseUrl = baseUrl.replace(/\/+$/, "");

  // Validate URL format
  try {
    new URL(baseUrl);
  } catch {
    if (opts.nonInteractive) throw new Error(`Invalid URL: ${baseUrl}`);
    log(`  ERROR: "${baseUrl}" is not a valid URL.`);
    return promptBaseUrl(log, defaultValue, opts);
  }

  // Health check
  log(`  Checking connection to ${baseUrl}...`);
  const check = await checkVaultReachable(baseUrl);
  if (check.ok) {
    log(`  Connected.`);
    return baseUrl;
  }

  if (opts.nonInteractive) {
    throw new Error(`Cannot reach vault at ${baseUrl}: ${check.error}`);
  }

  log(`  ERROR: ${check.error}`);
  log(`  Please check the URL and try again.`);
  log("");
  return promptBaseUrl(log, defaultValue, opts);
}

function isPluginInstalled(): boolean {
  const extensionsDir = path.join(os.homedir(), ".openclaw", "extensions");
  if (!existsSync(extensionsDir)) return false;
  try {
    const entries = readdirSync(extensionsDir);
    return entries.some(
      (e) => e === "agenthifive" || e === "@agenthifive",
    );
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// Vault API helpers
// ---------------------------------------------------------------------------

async function bootstrapAgent(
  baseUrl: string,
  bootstrapSecret: string,
): Promise<{
  agentId: string;
  name: string;
  status: string;
  privateKey: JsonWebKey;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const publicJWK = await exportJWK(publicKey);
  const privateJWK = await exportJWK(privateKey);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrapSecret: bootstrapSecret.trim(),
        publicKey: publicJWK,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot connect to ${baseUrl}: ${msg}\n\n` +
        "  Check that the URL is correct and the server is running.",
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Bootstrap failed (${response.status}): ${body || "check that the secret is valid and not expired"}`,
    );
  }

  const result = (await response.json()) as {
    agentId: string;
    name: string;
    status: string;
  };

  return { ...result, privateKey: privateJWK };
}

async function fetchCapabilities(
  baseUrl: string,
  token: string,
): Promise<VaultConnection[]> {
  const response = await fetch(`${baseUrl}/v1/capabilities/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Capabilities fetch failed (${response.status})`);
  }

  const body = (await response.json()) as {
    activeConnections: VaultConnection[];
  };

  return body.activeConnections ?? [];
}

// ---------------------------------------------------------------------------
// Service mapping
// ---------------------------------------------------------------------------

const SUPPORTED_SERVICES: Record<string, string> = {
  telegram: "telegram",
  slack: "slack",
  "anthropic-messages": "anthropic",
  openai: "openai",
  gemini: "gemini",
};

function integrationLabel(conn: VaultConnection): string {
  if (conn.category === "llm") return "LLM proxy";
  if (conn.credentialType === "bot_token") return "brokered API proxy";
  if (conn.credentialType === "oauth") return "brokered API proxy";
  return "auth managed";
}

// ---------------------------------------------------------------------------
// Vault-managed channel config templates
// ---------------------------------------------------------------------------

const CHANNEL_CONFIGS: Record<string, { config: Record<string, unknown>; description: string }> = {
  telegram: {
    config: { enabled: true, dmPolicy: "balanced", allowFrom: [] },
    description: "Receive and send Telegram messages",
  },
  slack: {
    config: { enabled: true },
    description: "Receive and send Slack messages",
  },
};

// ---------------------------------------------------------------------------
// Default models per LLM provider (required by OpenClaw config schema)
// ---------------------------------------------------------------------------

type ModelDef = { id: string; name: string; reasoning?: boolean; input?: string[] };

const DEFAULT_MODELS: Record<string, ModelDef[]> = {
  anthropic: [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true, input: ["text", "image"] },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, input: ["text", "image"] },
  ],
  openai: [
    { id: "gpt-4.1", name: "GPT-4.1", input: ["text", "image"] },
    { id: "o3", name: "o3", reasoning: true, input: ["text", "image"] },
  ],
  gemini: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, input: ["text", "image"] },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", input: ["text", "image"] },
  ],
  openrouter: [
    { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6 (OpenRouter)", reasoning: true, input: ["text", "image"] },
  ],
};

function getProviderConfigAliases(provider: string): string[] {
  if (provider === "gemini") {
    // OpenClaw routes Gemini models under the built-in "google" provider name.
    // Keep the native "gemini" alias too so existing configs and future codepaths
    // continue to resolve cleanly.
    return ["gemini", "google"];
  }
  return [provider];
}

function getProviderBaseUrlSlug(provider: string): string {
  if (provider === "google") {
    return "gemini";
  }
  return provider;
}

type OpenClawModelListRow = {
  key?: string;
  name?: string;
  input?: string;
  tags?: string[];
  missing?: boolean;
};

type OpenClawModelListJson = {
  count?: number;
  models?: OpenClawModelListRow[];
};

type ProviderModelNode = {
  provider: string;
  models: ModelDef[];
};

function parseModelInput(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "-") {
    return ["text"];
  }
  return trimmed
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
}

function toModelDef(provider: string, row: OpenClawModelListRow): ModelDef | null {
  const key = row.key?.trim();
  if (!key) return null;

  const prefix = `${provider}/`;
  if (!key.startsWith(prefix)) return null;
  if (row.missing) return null;

  const id = key.slice(prefix.length).trim();
  if (!id) return null;

  const model: ModelDef = {
    id,
    name: row.name?.trim() || id,
    input: parseModelInput(row.input),
  };

  if (row.tags?.includes("reasoning")) {
    model.reasoning = true;
  }

  return model;
}

export function parseOpenClawModelList(provider: string, value: string): ModelDef[] {
  const parsed = JSON.parse(value) as OpenClawModelListJson;
  const rows = Array.isArray(parsed.models) ? parsed.models : [];
  const seen = new Set<string>();
  const models: ModelDef[] = [];

  for (const row of rows) {
    const model = toModelDef(provider, row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }

  return models;
}

/**
 * Map our internal provider name to the provider ID that OpenClaw's
 * model catalog uses. For example, we call it "gemini" but OpenClaw's
 * `openclaw models list --provider` expects "google".
 */
function getOpenClawCatalogProviderId(provider: string): string {
  if (provider === "gemini") return "google";
  return provider;
}

/**
 * Load the full model catalog from OpenClaw in a single call.
 * Returns the raw JSON output, or null if the command fails.
 */
function loadOpenClawFullCatalog(): string | null {
  try {
    // Single call to load ALL providers' models. This takes 30-40s because
    // OpenClaw scans every provider. We only call it once and parse per-provider.
    const raw = execSync(
      "openclaw models list --all --json",
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", timeout: 60_000 },
    );
    // OpenClaw may emit plugin log lines to stdout both BEFORE and AFTER the JSON.
    // Extract only the JSON object by finding the first "{" and its matching "}".
    const jsonStart = raw.indexOf("{");
    if (jsonStart === -1) return null;
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonEnd === -1 || jsonEnd <= jsonStart) return null;
    return raw.slice(jsonStart, jsonEnd + 1);
  } catch (err) {
    log?.(`  [catalog] command failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function resolveProviderModels(proxiedProviders: string[]): Record<string, ModelDef[]> {
  const resolved: Record<string, ModelDef[]> = {};

  // Load full catalog once (not per-provider)
  const catalogJson = loadOpenClawFullCatalog();

  for (const provider of proxiedProviders) {
    const catalogProvider = getOpenClawCatalogProviderId(provider);
    let models: ModelDef[] | null = null;

    if (catalogJson) {
      try {
        models = parseOpenClawModelList(catalogProvider, catalogJson);
        if (models.length === 0) models = null;
      } catch {
        models = null;
      }
    }

    resolved[provider] = models
      ?? DEFAULT_MODELS[provider]
      ?? [{ id: "default", name: "Default", input: ["text"] }];
  }

  return resolved;
}

export function buildProviderModelTree(
  proxiedProviders: string[],
  providerModels: Record<string, ModelDef[]>,
): ProviderModelNode[] {
  return proxiedProviders
    .map((provider) => ({
      provider,
      models: providerModels[provider] ?? [],
    }))
    .filter((entry) => entry.models.length > 0);
}

function providerDisplayName(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "gemini") return "Gemini";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// ---------------------------------------------------------------------------
// Config output builder
// ---------------------------------------------------------------------------

export function buildConfigOutput(params: {
  baseUrl: string;
  agentId: string;
  privateKey: JsonWebKey;
  connections: Record<string, string>;
  connectedProviders: string[];
  proxiedProviders: string[];
  defaultModel?: string | undefined;
  channels?: Record<string, Record<string, unknown>> | undefined;
  providerModels?: Record<string, ModelDef[]> | undefined;
}): object {
  // Build models.providers entries for LLM providers — redirect baseUrl
  // to the vault's LLM proxy endpoint (Model B brokered).
  // Each provider needs a `models` array (required by OpenClaw config schema).
  const modelProviders: Record<string, { baseUrl: string; apiKey: string; models: ModelDef[] }> = {};
  for (const provider of params.proxiedProviders) {
    const providerModels = params.providerModels?.[provider]
      ?? DEFAULT_MODELS[provider]
      ?? [{ id: "default", name: "Default", input: ["text"] }];

    for (const configProvider of getProviderConfigAliases(provider)) {
      modelProviders[configProvider] = {
        baseUrl: `${params.baseUrl}/v1/vault/llm/${getProviderBaseUrlSlug(configProvider)}`,
        apiKey: "vault-managed",
        models: providerModels,
      };
    }
  }

  // Keep heartbeat runs isolated from the main TUI/webchat lane so
  // background HEARTBEAT_OK turns cannot pollute the user's active session.
  const agentDefaults: Record<string, unknown> = {
    heartbeat: {
      isolatedSession: true,
    },
  };
  if (params.defaultModel) {
    agentDefaults.model = params.defaultModel;
  }

  const agentsBlock: Record<string, unknown> = {
    defaults: agentDefaults,
  };

  // Always write the channel auth block — the plugin needs credentials for
  // LLM proxy auth even when no channel providers (Telegram/Slack) are configured.
  const channelProviders = params.channels && Object.keys(params.channels).length > 0
    ? params.channels
    : {};
  const channelConfig = {
    agenthifive: {
      accounts: {
        default: {
          enabled: true,
          baseUrl: params.baseUrl,
          debug_level: "error",
          auth: {
            mode: "agent",
            agentId: params.agentId,
            privateKey: Buffer.from(
              JSON.stringify(params.privateKey),
            ).toString("base64"),
          },
          providers: channelProviders,
        },
      },
    },
  };

  return {
    agents: agentsBlock,
    channels: channelConfig,
    tools: {
      alsoAllow: ["group:plugins"],
    },
    models: {
      providers: modelProviders,
    },
    plugins: {
      enabled: true,
      allow: ["agenthifive"],
      entries: {
        agenthifive: {
          enabled: true,
          config: {
            baseUrl: params.baseUrl,
            auth: {
              mode: "agent",
              agentId: params.agentId,
              privateKey: Buffer.from(
                JSON.stringify(params.privateKey),
              ).toString("base64"),
            },
            connectedProviders: params.connectedProviders,
            proxiedProviders: params.proxiedProviders,
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers used across modes
// ---------------------------------------------------------------------------

type LogFn = (msg: string) => void;

function classifyConnections(vaultConnections: VaultConnection[]): {
  connections: Record<string, string>;
  connectedProviders: string[];
  proxiedProviders: string[];
  channelServices: string[];
} {
  const connections: Record<string, string> = {};
  const connectedProviders: string[] = [];
  const proxiedProviders: string[] = [];
  const channelServices: string[] = [];
  const seenServices = new Set<string>();

  for (const conn of vaultConnections) {
    const openclawName = SUPPORTED_SERVICES[conn.service] ?? conn.service;
    connections[openclawName] = conn.connectionId ?? "vault-managed";

    if (seenServices.has(conn.service)) continue;
    seenServices.add(conn.service);

    connectedProviders.push(openclawName);
    if (conn.category === "llm") {
      proxiedProviders.push(openclawName);
    }
    if (openclawName in CHANNEL_CONFIGS) {
      channelServices.push(openclawName);
    }
  }

  return { connections, connectedProviders, proxiedProviders, channelServices };
}

function logConnections(log: LogFn, vaultConnections: VaultConnection[]): void {
  if (vaultConnections.length > 0) {
    log("  Services available to this agent:");
    log("  " + "-".repeat(50));

    const seenServices = new Set<string>();
    for (const conn of vaultConnections) {
      if (seenServices.has(conn.service)) continue;
      seenServices.add(conn.service);
      const openclawName = SUPPORTED_SERVICES[conn.service] ?? conn.service;
      const displayLabel = conn.displayName || openclawName;
      log(`  + ${displayLabel.padEnd(20)} (${integrationLabel(conn)})`);
    }
  } else {
    log("  No connections found in the vault.");
    log("  Add connections at the AgentHiFive dashboard.");
  }
}

async function pickDefaultModel(
  log: LogFn,
  proxiedProviders: string[],
  providerModels: Record<string, ModelDef[]>,
  opts: { nonInteractive?: boolean; defaultModel?: string },
): Promise<string | undefined> {
  if (opts.defaultModel) return opts.defaultModel;
  if (proxiedProviders.length === 0) return undefined;

  const tree = buildProviderModelTree(proxiedProviders, providerModels);
  if (tree.length === 0) return undefined;

  log("");
  log("  Choose a default LLM provider:");
  log("  " + "-".repeat(50));
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i]!;
    log(`    ${i + 1}) ${providerDisplayName(node.provider)} (${node.models.length} models)`);
  }
  log("");
  log("  Tip: you can still change models later from the OpenClaw TUI /models picker.");
  log("  Avoid changing provider auth in OpenClaw onboard/models auth for vault-managed");
  log("  providers, because those flows expect a local API key or token.");
  log("");

  const fallbackProviderIdx = 0;
  if (opts.nonInteractive) {
    const model = `${tree[0]!.provider}/${tree[0]!.models[0]!.id}`;
    log(`  Using default: ${model}`);
    return model;
  }

  const providerAnswer = await prompt("  Enter provider number", "1");
  const providerIdx = parseInt(providerAnswer, 10) - 1;
  const selectedProvider = tree[providerIdx >= 0 && providerIdx < tree.length ? providerIdx : fallbackProviderIdx]!;

  log("");
  log(`  ${providerDisplayName(selectedProvider.provider)} models:`);
  log("  " + "-".repeat(50));
  for (let i = 0; i < selectedProvider.models.length; i++) {
    const model = selectedProvider.models[i]!;
    log(`    ${i + 1}) ${selectedProvider.provider}/${model.id}  (${model.name})`);
  }
  log("");

  const modelAnswer = await prompt("  Enter model number", "1");
  const modelIdx = parseInt(modelAnswer, 10) - 1;
  const selectedModel = selectedProvider.models[
    modelIdx >= 0 && modelIdx < selectedProvider.models.length ? modelIdx : 0
  ]!;

  if (providerIdx < 0 || providerIdx >= tree.length || modelIdx < 0 || modelIdx >= selectedProvider.models.length) {
    log(`  Invalid choice, using: ${selectedProvider.provider}/${selectedModel.id}`);
  }

  return `${selectedProvider.provider}/${selectedModel.id}`;
}

/**
 * Check whether an existing channel config is already vault-managed
 * under the native AgentHiFive channel-plugin account shape.
 */
function isVaultManagedChannel(service: string, existing: Record<string, unknown>): boolean {
  const accountSection = existing.agenthifive as Record<string, unknown> | undefined;
  const accounts = accountSection?.accounts as Record<string, unknown> | undefined;
  const defaultAccount = accounts?.default as Record<string, unknown> | undefined;
  const providers = defaultAccount?.providers as Record<string, unknown> | undefined;
  const provider = providers?.[service] as Record<string, unknown> | undefined;
  if (!provider) return false;

  if (service === "telegram") {
    const dmPolicy = provider.dmPolicy;
    const allowFrom = provider.allowFrom;
    return (
      provider.enabled !== false
      && (dmPolicy === undefined || typeof dmPolicy === "string")
      && (allowFrom === undefined || Array.isArray(allowFrom))
    );
  }

  return provider.enabled !== false;
}

async function offerChannelConfig(
  log: LogFn,
  channelServices: string[],
  existingConfig: Record<string, unknown>,
  opts: { nonInteractive?: boolean },
): Promise<Record<string, Record<string, unknown>>> {
  if (channelServices.length === 0) return {};

  const existingChannels = (existingConfig.channels ?? {}) as Record<string, unknown>;
  const result: Record<string, Record<string, unknown>> = {};

  // Classify channels: new, needs migration, or already vault-managed
  const toOffer: { service: string; action: "enable" | "migrate" }[] = [];
  for (const service of channelServices) {
    if (!(service in CHANNEL_CONFIGS)) continue;
    if (isVaultManagedChannel(service, existingChannels)) continue;

    const existing = existingChannels[service] as Record<string, unknown> | undefined;

    if (!existing) {
      toOffer.push({ service, action: "enable" });
    } else {
      toOffer.push({ service, action: "migrate" });
    }
  }

  if (toOffer.length === 0) return {};

  log("");
  log("  The vault can receive messages from these channels:");
  log("  " + "\u2500".repeat(50));

  for (const { service, action } of toOffer) {
    const template = CHANNEL_CONFIGS[service]!;
    const displayName = service.charAt(0).toUpperCase() + service.slice(1);
    log("");

    if (action === "enable") {
      log(`  ${displayName} \u2014 ${template.description}`);

      if (opts.nonInteractive) {
        result[service] = { ...template.config };
        log(`  \u2713 ${displayName} enabled`);
      } else {
        const answer = await prompt(`  Enable ${displayName}? [Y/n]`, "Y");
        if (answer.toLowerCase() !== "n") {
          result[service] = { ...template.config };
          log(`  \u2713 ${displayName} enabled`);
        } else {
          log(`  \u2717 ${displayName} skipped`);
        }
      }
    } else {
      // migrate: existing native config → vault-managed
      log(`  ${displayName} \u2014 currently configured with local credentials`);
      log(`  The vault manages ${displayName} credentials. Local tokens are no longer needed.`);

      if (opts.nonInteractive) {
        result[service] = { ...template.config };
        log(`  \u2713 ${displayName} migrated to vault`);
      } else {
        const answer = await prompt(
          `  Replace local ${displayName} config with vault-managed? [Y/n]`,
          "Y",
        );
        if (answer.toLowerCase() !== "n") {
          result[service] = { ...template.config };
          log(`  \u2713 ${displayName} migrated to vault`);
        } else {
          log(`  \u2717 ${displayName} kept as-is (local credentials)`);
        }
      }
    }
  }

  return result;
}

function resolveConfigPath(
  opts: { configPath?: string },
): string {
  return opts.configPath ?? resolveOpenClawConfigPath() ?? defaultConfigPath();
}

async function resolveConfigPathInteractive(
  opts: { configPath?: string; nonInteractive?: boolean },
): Promise<string> {
  let configPath = opts.configPath ?? resolveOpenClawConfigPath();

  if (!configPath && !opts.nonInteractive) {
    const suggested = defaultConfigPath();
    configPath = await prompt("  OpenClaw config path", suggested);
    if (!configPath) configPath = null;
  }

  return configPath ?? defaultConfigPath();
}

function writeConfig(
  log: LogFn,
  configPath: string,
  configBlock: Record<string, unknown>,
  summary: { agentId?: string | undefined; baseUrl?: string | undefined; connectedProviders?: string[] | undefined; proxiedProviders?: string[] | undefined; defaultModel?: string | undefined },
): void {
  const existing = readExistingConfig(configPath);
  const hadExistingConfig = Object.keys(existing).length > 0;
  const merged = mergePluginConfig(existing, configBlock);

  mkdirSync(path.dirname(configPath), { recursive: true });

  // Back up existing config before overwriting
  if (hadExistingConfig && existsSync(configPath)) {
    const backupPath = configPath + ".bak";
    copyFileSync(configPath, backupPath);
    log(`        Backup: ${backupPath}`);
  }

  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  log(`        Config file: ${configPath}`);

  if (hadExistingConfig) {
    log("        Updated existing config:");
  } else {
    log("        Created new config with:");
  }
  if (summary.agentId) {
    log(`          - Agent ID: ${summary.agentId.slice(0, 8)}...`);
  }
  if (summary.baseUrl) {
    log(`          - Vault URL: ${summary.baseUrl}`);
  }
  if (summary.connectedProviders && summary.connectedProviders.length > 0) {
    log(`          - Connected providers: ${summary.connectedProviders.join(", ")}`);
  }
  if (summary.proxiedProviders && summary.proxiedProviders.length > 0) {
    log(`          - LLM credential proxying: ${summary.proxiedProviders.join(", ")}`);
  }
  if (summary.defaultModel) {
    log(`          - Default model: ${summary.defaultModel}`);
  }
}

export function removeAgentHiFiveChannelConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(config);
  const channels = next.channels as Record<string, unknown> | undefined;
  if (!channels || !("agenthifive" in channels)) {
    return next;
  }

  delete channels.agenthifive;
  if (Object.keys(channels).length === 0) {
    delete next.channels;
  }

  return next;
}

function patchOpenClaw(
  log: LogFn,
  opts: { openclawDir?: string; nonInteractive?: boolean },
): void {
  let openclawInstall = opts.openclawDir
    ? validateOpenClawDir(opts.openclawDir)
    : findOpenClawInstallDir();

  if (!openclawInstall && !opts.nonInteractive) {
    // Can't use await here — this is a sync context.
    // But we're always called from async context, so we'll handle this in callers.
  }

  if (openclawInstall) {
    try {
      const result = applyPatch(openclawInstall);
      if (result.alreadyPatched) {
        log("        Already enabled (no changes needed)");
      } else if (result.applied) {
        log("        Enabled successfully");
      } else {
        log(`  WARNING: ${result.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EACCES") || msg.includes("permission denied")) {
        log("  ERROR: Permission denied. Try running with sudo:");
        log("    sudo ah5-setup ...");
      } else {
        log(`  WARNING: Could not enable credential proxying: ${msg}`);
      }
    }

    // Broadcast bridge — enables plugin approval watcher to push to TUI
    if (openclawInstall.kind === "dist") {
      try {
        const bResult = applyBroadcastPatch(openclawInstall.dir);
        if (bResult.alreadyPatched) {
          log("        Broadcast bridge already enabled");
        } else if (bResult.applied) {
          log("        Broadcast bridge enabled");
        } else {
          log(`  WARNING: Broadcast bridge: ${bResult.message}`);
        }
      } catch (err) {
        log(`  WARNING: Broadcast bridge patch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    log("  WARNING: Could not find OpenClaw installation directory.");
    log("  Run 'ah5-setup --openclaw-dir /path/to/openclaw' to enable later.");
  }
}

async function patchOpenClawInteractive(
  log: LogFn,
  opts: { openclawDir?: string; nonInteractive?: boolean },
): Promise<void> {
  let openclawInstall = opts.openclawDir
    ? validateOpenClawDir(opts.openclawDir)
    : findOpenClawInstallDir();

  if (!openclawInstall && !opts.nonInteractive) {
    const userPath = await prompt(
      "  OpenClaw installation path (press Enter to skip)",
    );
    if (userPath) {
      openclawInstall = validateOpenClawDir(userPath);
      if (!openclawInstall) {
        log(`  WARNING: "${userPath}" does not appear to be an OpenClaw installation.`);
      }
    }
  }

  if (openclawInstall) {
    try {
      const result = applyPatch(openclawInstall);
      if (result.alreadyPatched) {
        log("        Already enabled (no changes needed)");
      } else if (result.applied) {
        log("        Enabled successfully");
      } else {
        log(`  WARNING: ${result.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EACCES") || msg.includes("permission denied")) {
        log("  ERROR: Permission denied. Try running with sudo:");
        log("    sudo ah5-setup ...");
      } else {
        log(`  WARNING: Could not enable credential proxying: ${msg}`);
      }
    }

    // Broadcast bridge — enables plugin approval watcher to push to TUI
    if (openclawInstall.kind === "dist") {
      try {
        const bResult = applyBroadcastPatch(openclawInstall.dir);
        if (bResult.alreadyPatched) {
          log("        Broadcast bridge already enabled");
        } else if (bResult.applied) {
          log("        Broadcast bridge enabled");
        } else {
          log(`  WARNING: Broadcast bridge: ${bResult.message}`);
        }
      } catch (err) {
        log(`  WARNING: Broadcast bridge patch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    log("  WARNING: Could not find OpenClaw installation directory.");
    log("  Run 'ah5-setup --openclaw-dir /path/to/openclaw' to enable later.");
  }
}

interface ConfigSummary {
  llmProviders: string[];
  channels: string[];
  plugins: string[];
  localApiKeys: string[];
}

function summarizeExistingConfig(config: Record<string, unknown>): ConfigSummary {
  const result: ConfigSummary = {
    llmProviders: [],
    channels: [],
    plugins: [],
    localApiKeys: [],
  };

  // LLM providers
  const models = config.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, Record<string, unknown>> | undefined;
  if (providers) {
    for (const [name, value] of Object.entries(providers)) {
      result.llmProviders.push(name);
      const apiKey = value?.apiKey;
      if (apiKey && typeof apiKey === "string" && apiKey !== "vault-managed") {
        result.localApiKeys.push(name);
      }
    }
  }

  // Channels
  const channels = config.channels as Record<string, unknown> | undefined;
  if (channels) {
    const direct = Object.keys(channels).filter((name) => name !== "agenthifive");
    const ah5Providers =
      ((((channels.agenthifive as Record<string, unknown> | undefined)?.accounts as Record<string, unknown> | undefined)
        ?.default as Record<string, unknown> | undefined)?.providers as Record<string, unknown> | undefined);
    result.channels = [...direct, ...Object.keys(ah5Providers ?? {})];
  }

  // Plugins (excluding agenthifive)
  const pluginsBlock = config.plugins as Record<string, unknown> | undefined;
  const entries = pluginsBlock?.entries as Record<string, unknown> | undefined;
  if (entries) {
    result.plugins = Object.keys(entries).filter((k) => k !== "agenthifive");
  }

  return result;
}

function logConfigSummary(log: LogFn, configPath: string, summary: ConfigSummary): void {
  log("");
  log(`  Existing OpenClaw config detected: ${configPath}`);
  if (summary.llmProviders.length > 0) {
    log(`    LLM providers:  ${summary.llmProviders.join(", ")}`);
  }
  if (summary.channels.length > 0) {
    log(`    Channels:       ${summary.channels.join(", ")}`);
  }
  if (summary.plugins.length > 0) {
    log(`    Plugins:        ${summary.plugins.join(", ")}`);
  }
  log("  Your existing settings will be preserved.");
}

function cleanLocalApiKeys(
  config: Record<string, unknown>,
  providersToClean: string[],
): void {
  const models = config.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, Record<string, unknown>> | undefined;
  if (!providers) return;
  for (const name of providersToClean) {
    if (providers[name]) {
      providers[name]!.apiKey = "vault-managed";
    }
  }
}

function logDone(log: LogFn, defaultModel?: string, proxiedProviders?: string[]): void {
  log("");
  log("  " + "=".repeat(50));
  log("  Done!");
  log("");
  if (defaultModel) {
    log(`  Default model: ${defaultModel}`);
  }
  if (proxiedProviders && proxiedProviders.length > 0) {
    log("  The vault provides the API key — no local key needed.");
  }
  log("");
  log("  To change models, type /models inside an OpenClaw chat session.");
  log("  The TUI model picker is fine to use with vault-managed providers.");
  log("  Avoid re-running OpenClaw onboard/models auth for those providers,");
  log("  because those setup flows will ask for local provider keys.");
  log("  To manage connections: https://app.agenthifive.com");
  log("");
}

// ---------------------------------------------------------------------------
// Existing auth extraction from openclaw.json
// ---------------------------------------------------------------------------

interface ExistingAuth {
  baseUrl: string;
  agentId: string;
  privateKey: JsonWebKey;
}

function extractExistingAuth(configPath: string): ExistingAuth | null {
  const config = readExistingConfig(configPath);
  try {
    const channels = config.channels as Record<string, unknown> | undefined;
    const agenthifiveChannel = channels?.agenthifive as Record<string, unknown> | undefined;
    const accounts = agenthifiveChannel?.accounts as Record<string, unknown> | undefined;
    const defaultAccount = accounts?.default as Record<string, unknown> | undefined;
    const channelBaseUrl = defaultAccount?.baseUrl as string | undefined;
    const channelAuth = defaultAccount?.auth as Record<string, unknown> | undefined;

    const channelAgentId = channelAuth?.agentId as string | undefined;
    const channelPrivateKeyB64 = channelAuth?.privateKey as string | undefined;
    if (channelBaseUrl && channelAgentId && channelPrivateKeyB64) {
      const privateKey = JSON.parse(
        Buffer.from(channelPrivateKeyB64, "base64").toString("utf-8"),
      ) as JsonWebKey;
      return {
        baseUrl: channelBaseUrl,
        agentId: channelAgentId,
        privateKey,
      };
    }

    const plugins = config.plugins as Record<string, unknown> | undefined;
    if (!plugins) return null;
    const entries = plugins.entries as Record<string, unknown> | undefined;
    if (!entries) return null;
    const ah5 = entries.agenthifive as Record<string, unknown> | undefined;
    if (!ah5) return null;
    const ah5Config = ah5.config as Record<string, unknown> | undefined;
    if (!ah5Config) return null;

    const baseUrl = ah5Config.baseUrl as string | undefined;
    const auth = ah5Config.auth as Record<string, unknown> | undefined;
    if (!baseUrl || !auth) return null;

    const agentId = auth.agentId as string | undefined;
    const privateKeyB64 = auth.privateKey as string | undefined;
    if (!agentId || !privateKeyB64) return null;

    const privateKey = JSON.parse(
      Buffer.from(privateKeyB64, "base64").toString("utf-8"),
    ) as JsonWebKey;

    return { baseUrl, agentId, privateKey };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mode: Interactive menu
// ---------------------------------------------------------------------------

async function showMenu(log: LogFn): Promise<SetupMode> {
  log("");
  log("  AgentHiFive Setup");
  log("  " + "=".repeat(40));
  log("");
  log("  What would you like to do?");
  log("");
  log("    1) First connection to vault   Install plugin + auth + config + patch");
  log("    2) Configure vault connections Change default LLM, connect/remove channels");
  log("    3) Reconnect to vault          New bootstrap secret, re-auth");
  log("    4) Verify installation         Check everything is working");
  log("    5) Remove AgentHiFive          Cleanly remove channel config + uninstall plugin");
  log("");

  const answer = await prompt("  Enter number", "1");
  switch (answer) {
    case "2": return "configure-connections";
    case "3": return "reconnect";
    case "4": return "verify";
    case "5": return "remove";
    default: return "setup";
  }
}

type ConfigureConnectionsAction =
  | { kind: "done" }
  | { kind: "change-model" }
  | { kind: "toggle-channel"; service: string };

function getExistingVaultManagedProviders(
  config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const channels = config.channels as Record<string, unknown> | undefined;
  const agenthifive = channels?.agenthifive as Record<string, unknown> | undefined;
  const accounts = agenthifive?.accounts as Record<string, unknown> | undefined;
  const defaultAccount = accounts?.default as Record<string, unknown> | undefined;
  const providers = defaultAccount?.providers as Record<string, unknown> | undefined;

  const result: Record<string, Record<string, unknown>> = {};
  for (const [service, value] of Object.entries(providers ?? {})) {
    if (value && typeof value === "object") {
      result[service] = { ...(value as Record<string, unknown>) };
    }
  }
  return result;
}

function channelDisplayName(service: string): string {
  return service.charAt(0).toUpperCase() + service.slice(1);
}

async function showConfigureConnectionsMenu(
  log: LogFn,
  channelServices: string[],
  existingConfig: Record<string, unknown>,
): Promise<ConfigureConnectionsAction> {
  const existingChannels = (existingConfig.channels ?? {}) as Record<string, unknown>;

  log("");
  log("  Configure Vault Connections");
  log("  " + "-".repeat(40));
  log("");
  log("    0) Done");
  log("    1) Change default LLM");

  let optionNumber = 2;
  const options = new Map<number, ConfigureConnectionsAction>([
    [0, { kind: "done" }],
    [1, { kind: "change-model" }],
  ]);

  for (const service of channelServices) {
    if (!(service in CHANNEL_CONFIGS)) continue;

    const enabled = isVaultManagedChannel(service, existingChannels);
    const displayName = channelDisplayName(service);
    const description = enabled
      ? "Remove from this OpenClaw config"
      : `Connect ${displayName} from the vault`;

    log(`    ${optionNumber}) ${enabled ? "Remove" : "Connect"} ${displayName.padEnd(14)} ${description}`);
    options.set(optionNumber, { kind: "toggle-channel", service });
    optionNumber += 1;
  }

  if (options.size === 2) {
    log("");
    log("  No channel connections are currently available for this agent.");
  }

  log("");

  const answer = await prompt("  Enter number", "0");
  const idx = parseInt(answer, 10);
  return options.get(idx) ?? { kind: "done" };
}

// ---------------------------------------------------------------------------
// Mode 1: First-time setup (full flow)
// ---------------------------------------------------------------------------

const ONBOARD_CMD =
  "openclaw onboard --non-interactive --accept-risk --auth-choice skip " +
  "--install-daemon --skip-channels --skip-skills --skip-search --skip-health --skip-ui";

async function runFirstTimeSetup(opts: SetupOptions): Promise<void> {
  const log: LogFn = (msg) => process.stdout.write(`${msg}\n`);

  log("");
  log("  Connect to Vault");
  log("  " + "-".repeat(40));
  log("");

  // Step 1: Check OpenClaw
  if (!isOpenClawInstalled()) {
    throw new Error(
      "OpenClaw is not installed. Install it first:\n\n" +
        "  npm install -g openclaw@latest\n",
    );
  }
  log("  [1/7] OpenClaw found on this machine");

  // Step 2: Onboard
  if (!opts.skipOnboard && !isOnboarded()) {
    log("  [2/7] OpenClaw has not been set up yet. Running initial setup:");
    log(`        $ ${ONBOARD_CMD}`);
    log("");
    try {
      execSync(ONBOARD_CMD, { stdio: "inherit" });
    } catch {
      throw new Error(
        "OpenClaw onboard failed. Run it manually first:\n\n" +
          `  ${ONBOARD_CMD}\n`,
      );
    }
    log("");
  } else {
    log("  [2/7] OpenClaw already set up");
  }

  // Step 3: Install plugin
  if (!opts.skipPluginInstall && !isPluginInstalled()) {
    log("  [3/7] Installing AgentHiFive plugin into OpenClaw...");
    log("");
    try {
      execSync("openclaw plugins install @agenthifive/agenthifive", {
        stdio: "inherit",
      });
    } catch {
      throw new Error(
        "Plugin installation failed. Try manually:\n\n" +
          "  openclaw plugins install @agenthifive/agenthifive\n",
      );
    }
    try {
      execSync("openclaw gateway restart", { stdio: "pipe" });
    } catch {
      // Gateway may not be running — that's fine
    }
    log("");
  } else {
    log("  [3/7] AgentHiFive plugin already installed");
  }

  // Step 4: Bootstrap auth
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    if (opts.nonInteractive) {
      throw new Error("--base-url is required in non-interactive mode");
    }
    baseUrl = await promptBaseUrl(log, "https://app.agenthifive.com", opts);
  } else {
    baseUrl = baseUrl.replace(/\/+$/, "");
    log(`  Checking connection to ${baseUrl}...`);
    const check = await checkVaultReachable(baseUrl);
    if (!check.ok) {
      throw new Error(`Cannot reach vault at ${baseUrl}: ${check.error}`);
    }
    log(`  Connected.`);
  }

  // Show existing config summary if present
  const existingConfigPath = resolveOpenClawConfigPath();
  const existingConfig = existingConfigPath ? readExistingConfig(existingConfigPath) : {};
  const configSummary = summarizeExistingConfig(existingConfig);
  const hasExistingConfig = configSummary.llmProviders.length > 0
    || configSummary.channels.length > 0
    || configSummary.plugins.length > 0;

  if (hasExistingConfig && existingConfigPath) {
    logConfigSummary(log, existingConfigPath, configSummary);
  }

  let bootstrapSecret = opts.bootstrapSecret;
  if (!bootstrapSecret) {
    if (opts.nonInteractive) {
      throw new Error("--bootstrap-secret is required in non-interactive mode");
    }
    log("");
    log("  Generate a bootstrap secret from the AgentHiFive dashboard:");
    log("    Dashboard -> Agents -> [your agent] -> Bootstrap Secret");
    log("  The secret expires in 1 hour.");
    log("");
    bootstrapSecret = await prompt("  Bootstrap secret (ah5b_...)");
  }

  if (!bootstrapSecret.startsWith("ah5b_")) {
    throw new Error("Bootstrap secrets must start with ah5b_");
  }

  log("");
  log("  [4/7] Connecting this OpenClaw agent to the AgentHiFive vault...");
  const { agentId, name, status, privateKey } = await bootstrapAgent(
    baseUrl,
    bootstrapSecret,
  );
  log(
    `        Agent "${name}" registered (${agentId.slice(0, 8)}..., status: ${status})`,
  );

  // Verify token exchange
  log("        Verifying secure token exchange...");
  const tokenManager = new VaultTokenManager({
    baseUrl,
    agentId,
    privateKey,
    tokenAudience: baseUrl,
  });

  try {
    await tokenManager.init();
    log("        Connection to vault established");
  } catch (err) {
    log(
      `  WARNING: Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    log("  Config will still be generated — you may need to fix auth settings.");
    tokenManager.stop();
    outputMinimalConfig(log, baseUrl, agentId, privateKey);
    return;
  }

  // Step 5: Fetch capabilities
  log("  [5/7] Fetching connections available in the vault for this agent...");
  let vaultConnections: VaultConnection[] = [];
  try {
    vaultConnections = await fetchCapabilities(
      baseUrl,
      tokenManager.getToken(),
    );
  } catch (err) {
    log(
      `  WARNING: Could not fetch capabilities: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  tokenManager.stop();

  log("");
  logConnections(log, vaultConnections);
  const { connections, connectedProviders, proxiedProviders, channelServices } = classifyConnections(vaultConnections);
  const providerModels = resolveProviderModels(proxiedProviders);

  // Credential migration guidance
  if (hasExistingConfig) {
    // LLM providers: offer to remove local API keys
    const overlappingLlm = configSummary.localApiKeys.filter((k) =>
      proxiedProviders.includes(k),
    );
    if (overlappingLlm.length > 0) {
      log("");
      log(`  The vault will manage API keys for: ${proxiedProviders.join(", ")}`);
      log(`  Your local config has API keys for: ${overlappingLlm.join(", ")}`);
      log("");

      if (opts.nonInteractive) {
        cleanLocalApiKeys(existingConfig, overlappingLlm);
        log(`  Removed local API keys for: ${overlappingLlm.join(", ")}`);
      } else {
        const answer = await prompt(
          `  Remove local API keys for ${overlappingLlm.join(", ")} from your config? [Y/n]`,
          "Y",
        );
        if (answer.toLowerCase() !== "n") {
          cleanLocalApiKeys(existingConfig, overlappingLlm);
          log(`  Local API keys removed. The vault manages these credentials now.`);
        }
      }
    }

  }

  // Step 5b: Choose default LLM model
  const defaultModel = await pickDefaultModel(log, proxiedProviders, providerModels, opts);

  // Step 5c: Offer channel configuration
  const channels = await offerChannelConfig(log, channelServices, existingConfig, opts);

  // Step 6: Write config
  log("");
  log("  [6/7] Saving AgentHiFive configuration...");

  const configBlock = buildConfigOutput({
    baseUrl,
    agentId,
    privateKey,
    connections,
    connectedProviders,
    proxiedProviders,
    defaultModel,
    channels,
    providerModels,
  });

  const configPath = await resolveConfigPathInteractive(opts);

  try {
    writeConfig(log, configPath, configBlock as Record<string, unknown>, {
      agentId, baseUrl, connectedProviders, proxiedProviders, defaultModel,
    });
  } catch (err) {
    log(
      `  WARNING: Could not write config: ${err instanceof Error ? err.message : String(err)}`,
    );
    log("");
    log("  Add this to your openclaw.json manually:");
    log(JSON.stringify(configBlock, null, 2));
  }

  // Step 7: Patch
  log("");
  log("  [7/7] Enabling vault credential proxying...");
  log("        This modifies OpenClaw so it can fetch API keys from the vault");
  log("        instead of requiring them to be stored locally.");

  await patchOpenClawInteractive(log, opts);

  logDone(log, defaultModel, proxiedProviders);
}

// ---------------------------------------------------------------------------
// Mode 2: Change default LLM model
// ---------------------------------------------------------------------------

async function runChangeModel(opts: SetupOptions): Promise<void> {
  const log: LogFn = (msg) => process.stdout.write(`${msg}\n`);

  log("");
  log("  Change Default LLM Model");
  log("  " + "-".repeat(40));
  log("");

  // Read existing config to get auth credentials
  const configPath = resolveConfigPath(opts);
  const existingAuth = extractExistingAuth(configPath);

  if (!existingAuth) {
    throw new Error(
      "No existing AgentHiFive config found. Run first-time setup first.\n\n" +
        "  ah5-setup\n",
    );
  }

  log(`  Config: ${configPath}`);
  log(`  Vault:  ${existingAuth.baseUrl}`);
  log(`  Agent:  ${existingAuth.agentId.slice(0, 8)}...`);
  log("");

  // Use existing auth to fetch capabilities
  log("  Fetching available LLM connections...");
  const tokenManager = new VaultTokenManager({
    baseUrl: existingAuth.baseUrl,
    agentId: existingAuth.agentId,
    privateKey: existingAuth.privateKey,
    tokenAudience: existingAuth.baseUrl,
  });

  try {
    await tokenManager.init();
  } catch (err) {
    tokenManager.stop();
    throw new Error(
      `Could not authenticate with vault: ${err instanceof Error ? err.message : String(err)}. ` +
        "You may need to reconnect (option 3).",
    );
  }

  let vaultConnections: VaultConnection[] = [];
  try {
    vaultConnections = await fetchCapabilities(
      existingAuth.baseUrl,
      tokenManager.getToken(),
    );
  } catch (err) {
    throw new Error(
      `Could not fetch capabilities: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    tokenManager.stop();
  }

  const { proxiedProviders } = classifyConnections(vaultConnections);
  const providerModels = resolveProviderModels(proxiedProviders);

  if (proxiedProviders.length === 0) {
    throw new Error(
      "No LLM connections found. Add LLM connections at the AgentHiFive dashboard.",
    );
  }

  // Pick model
  const defaultModel = await pickDefaultModel(log, proxiedProviders, providerModels, opts);

  if (!defaultModel) {
    log("  No model selected.");
    return;
  }

  // Update only agents.defaults.model in existing config
  const existing = readExistingConfig(configPath);
  const agentsUpdate = {
    agents: { defaults: { model: defaultModel } },
    tools: { alsoAllow: ["group:plugins"] },
  };
  const merged = mergePluginConfig(existing, agentsUpdate);

  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  log("");
  log(`  Default model updated to: ${defaultModel}`);
  log(`  Config saved: ${configPath}`);

  logDone(log, defaultModel, proxiedProviders);
}

async function runConfigureConnections(opts: SetupOptions): Promise<void> {
  if (opts.nonInteractive) {
    throw new Error(
      "Configure vault connections requires interactive mode. " +
        "Use --mode change-model or --mode sync for scripted flows.",
    );
  }

  const log: LogFn = (msg) => process.stdout.write(`${msg}\n`);

  log("");
  log("  Configure Vault Connections");
  log("  " + "-".repeat(40));
  log("");

  const configPath = resolveConfigPath(opts);
  const existingAuth = extractExistingAuth(configPath);

  if (!existingAuth) {
    throw new Error(
      "No existing AgentHiFive config found. Run first-time setup first.\n\n" +
        "  ah5-setup\n",
    );
  }

  log(`  Config: ${configPath}`);
  log(`  Vault:  ${existingAuth.baseUrl}`);
  log(`  Agent:  ${existingAuth.agentId.slice(0, 8)}...`);
  log("");

  log("  Fetching vault connections...");
  const tokenManager = new VaultTokenManager({
    baseUrl: existingAuth.baseUrl,
    agentId: existingAuth.agentId,
    privateKey: existingAuth.privateKey,
    tokenAudience: existingAuth.baseUrl,
  });

  try {
    await tokenManager.init();
  } catch (err) {
    tokenManager.stop();
    throw new Error(
      `Could not authenticate with vault: ${err instanceof Error ? err.message : String(err)}. ` +
        "You may need to reconnect (option 3).",
    );
  }

  let vaultConnections: VaultConnection[] = [];
  try {
    vaultConnections = await fetchCapabilities(
      existingAuth.baseUrl,
      tokenManager.getToken(),
    );
  } catch (err) {
    throw new Error(
      `Could not fetch capabilities: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    tokenManager.stop();
  }

  logConnections(log, vaultConnections);
  const { connections, connectedProviders, proxiedProviders, channelServices } =
    classifyConnections(vaultConnections);

  // Menu loop — keeps returning to the menu after each action until "Done"
  while (true) {
    const existingConfig = readExistingConfig(configPath);
    const action = await showConfigureConnectionsMenu(log, channelServices, existingConfig);

    if (action.kind === "done") {
      log("  Done.");
      break;
    }

    if (action.kind === "change-model") {
      // Lazy-load models only when the user actually selects this option.
      // This can take 30-40s because `openclaw models list --all` loads every
      // provider's catalog. Show a clear message so the user knows to wait.
      log("  Loading available models...");
      const providerModels = resolveProviderModels(proxiedProviders);

      // Let the user know if we fell back to the hardcoded list
      for (const provider of proxiedProviders) {
        if (providerModels[provider] === DEFAULT_MODELS[provider]) {
          log(`  (Using default model list for ${provider} — start the OpenClaw gateway for the full catalog)`);
        }
      }

      const defaultModel = await pickDefaultModel(log, proxiedProviders, providerModels, opts);

      if (!defaultModel) {
        log("  No model selected.");
        continue;
      }

      const agentsUpdate = {
        agents: { defaults: { model: defaultModel } },
        tools: { alsoAllow: ["group:plugins"] },
      };
      const merged = mergePluginConfig(existingConfig, agentsUpdate);

      writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

      log("");
      log(`  Default model updated to: ${defaultModel}`);
      log(`  Config saved: ${configPath}`);
      continue;
    }

    // Toggle channel service
    const currentProviders = getExistingVaultManagedProviders(existingConfig);
    const displayName = channelDisplayName(action.service);
    let actionSummary: string;

    if (action.service in currentProviders) {
      delete currentProviders[action.service];
      actionSummary = `${displayName} removed from this OpenClaw config`;
    } else {
      const template = CHANNEL_CONFIGS[action.service];
      if (!template) {
        throw new Error(`Unsupported channel service: ${action.service}`);
      }
      currentProviders[action.service] = { ...template.config };
      actionSummary = `${displayName} connected from the vault`;
    }

    const existingAgents = (existingConfig.agents as Record<string, unknown>) ?? {};
    const existingDefaults = (existingAgents.defaults as Record<string, unknown>) ?? {};
    const defaultModel = (existingDefaults.model as string) ?? undefined;
    const providerModels = resolveProviderModels(proxiedProviders);

    const configBlock = buildConfigOutput({
      baseUrl: existingAuth.baseUrl,
      agentId: existingAuth.agentId,
      privateKey: existingAuth.privateKey,
      connections,
      connectedProviders,
      proxiedProviders,
      defaultModel,
      channels: currentProviders,
      providerModels,
    });

    writeConfig(log, configPath, configBlock as Record<string, unknown>, {
      agentId: existingAuth.agentId,
      baseUrl: existingAuth.baseUrl,
      connectedProviders,
      proxiedProviders,
      defaultModel,
    });

    log("");
    log(`  ${actionSummary}.`);
    continue;
  }
}

// ---------------------------------------------------------------------------
// Mode 4: Sync connections (re-fetch capabilities, update config)
// ---------------------------------------------------------------------------

async function runSyncConnections(opts: SetupOptions): Promise<void> {
  const log: LogFn = (msg) => process.stdout.write(`${msg}\n`);

  log("");
  log("  Sync Connections");
  log("  " + "-".repeat(40));
  log("");

  // Read existing config to get auth credentials
  const configPath = resolveConfigPath(opts);
  const existingAuth = extractExistingAuth(configPath);

  if (!existingAuth) {
    throw new Error(
      "No existing AgentHiFive config found. Run first-time setup first.\n\n" +
        "  ah5-setup\n",
    );
  }

  log(`  Config: ${configPath}`);
  log(`  Vault:  ${existingAuth.baseUrl}`);
  log(`  Agent:  ${existingAuth.agentId.slice(0, 8)}...`);
  log("");

  // Authenticate and fetch capabilities
  log("  Fetching vault connections...");
  const tokenManager = new VaultTokenManager({
    baseUrl: existingAuth.baseUrl,
    agentId: existingAuth.agentId,
    privateKey: existingAuth.privateKey,
    tokenAudience: existingAuth.baseUrl,
  });

  try {
    await tokenManager.init();
  } catch (err) {
    tokenManager.stop();
    throw new Error(
      `Could not authenticate with vault: ${err instanceof Error ? err.message : String(err)}. ` +
        "You may need to reconnect (option 3).",
    );
  }

  let vaultConnections: VaultConnection[] = [];
  try {
    vaultConnections = await fetchCapabilities(
      existingAuth.baseUrl,
      tokenManager.getToken(),
    );
  } catch (err) {
    throw new Error(
      `Could not fetch capabilities: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    tokenManager.stop();
  }

  logConnections(log, vaultConnections);
  const { connections, connectedProviders, proxiedProviders, channelServices } =
    classifyConnections(vaultConnections);
  const providerModels = resolveProviderModels(proxiedProviders);

  // Offer channel config for new/changed channels
  const existingForChannels = readExistingConfig(configPath);
  const channels = await offerChannelConfig(log, channelServices, existingForChannels, opts);

  // Preserve existing model
  const existingConfig = readExistingConfig(configPath);
  const existingAgents = (existingConfig.agents as Record<string, unknown>) ?? {};
  const existingDefaults = (existingAgents.defaults as Record<string, unknown>) ?? {};
  const defaultModel = (existingDefaults.model as string) ?? undefined;

  // Write updated config
  log("");
  log("  Saving configuration...");

  const configBlock = buildConfigOutput({
    baseUrl: existingAuth.baseUrl,
    agentId: existingAuth.agentId,
    privateKey: existingAuth.privateKey,
    connections,
    connectedProviders,
    proxiedProviders,
    defaultModel,
    channels,
    providerModels,
  });

  try {
    writeConfig(log, configPath, configBlock as Record<string, unknown>, {
      agentId: existingAuth.agentId,
      baseUrl: existingAuth.baseUrl,
      connectedProviders,
      proxiedProviders,
      defaultModel,
    });
  } catch (err) {
    log(
      `  WARNING: Could not write config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  logDone(log, defaultModel, proxiedProviders);
}

// ---------------------------------------------------------------------------
// Mode 3: Reconnect to vault
// ---------------------------------------------------------------------------

async function runReconnect(opts: SetupOptions): Promise<void> {
  const log: LogFn = (msg) => process.stdout.write(`${msg}\n`);

  log("");
  log("  Reconnect to Vault");
  log("  " + "-".repeat(40));
  log("");

  // Read existing config for current vault URL as default
  const configPath = resolveConfigPath(opts);
  const existingAuth = extractExistingAuth(configPath);
  const currentBaseUrl = existingAuth?.baseUrl ?? "https://app.agenthifive.com";

  // Confirm/change vault URL
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    baseUrl = await promptBaseUrl(log, currentBaseUrl, opts);
  } else {
    baseUrl = baseUrl.replace(/\/+$/, "");
    log(`  Checking connection to ${baseUrl}...`);
    const check = await checkVaultReachable(baseUrl);
    if (!check.ok) {
      throw new Error(`Cannot reach vault at ${baseUrl}: ${check.error}`);
    }
    log(`  Connected.`);
  }

  // New bootstrap secret
  let bootstrapSecret = opts.bootstrapSecret;
  if (!bootstrapSecret) {
    if (opts.nonInteractive) {
      throw new Error("--bootstrap-secret is required in non-interactive mode");
    }
    log("");
    log("  Generate a new bootstrap secret from the AgentHiFive dashboard:");
    log("    Dashboard -> Agents -> [your agent] -> Bootstrap Secret");
    log("  The secret expires in 1 hour.");
    log("");
    bootstrapSecret = await prompt("  Bootstrap secret (ah5b_...)");
  }

  if (!bootstrapSecret.startsWith("ah5b_")) {
    throw new Error("Bootstrap secrets must start with ah5b_");
  }

  // Bootstrap new auth
  log("");
  log("  Connecting to vault...");
  const { agentId, name, status, privateKey } = await bootstrapAgent(
    baseUrl,
    bootstrapSecret,
  );
  log(
    `  Agent "${name}" registered (${agentId.slice(0, 8)}..., status: ${status})`,
  );

  // Verify token exchange
  log("  Verifying secure token exchange...");
  const tokenManager = new VaultTokenManager({
    baseUrl,
    agentId,
    privateKey,
    tokenAudience: baseUrl,
  });

  try {
    await tokenManager.init();
    log("  Connection established");
  } catch (err) {
    tokenManager.stop();
    throw new Error(
      `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Fetch capabilities
  log("  Fetching connections...");
  let vaultConnections: VaultConnection[] = [];
  try {
    vaultConnections = await fetchCapabilities(
      baseUrl,
      tokenManager.getToken(),
    );
  } catch (err) {
    log(
      `  WARNING: Could not fetch capabilities: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  tokenManager.stop();

  log("");
  logConnections(log, vaultConnections);
  const { connections, connectedProviders, proxiedProviders, channelServices } = classifyConnections(vaultConnections);
  const providerModels = resolveProviderModels(proxiedProviders);

  // Pick model
  const defaultModel = await pickDefaultModel(log, proxiedProviders, providerModels, opts);

  // Offer channel configuration
  const existingForChannels = readExistingConfig(configPath);
  const channels = await offerChannelConfig(log, channelServices, existingForChannels, opts);

  // Write config (full rebuild of plugin + models + agents blocks)
  log("");
  log("  Saving configuration...");

  const configBlock = buildConfigOutput({
    baseUrl,
    agentId,
    privateKey,
    connections,
    connectedProviders,
    proxiedProviders,
    defaultModel,
    channels,
    providerModels,
  });

  try {
    writeConfig(log, configPath, configBlock as Record<string, unknown>, {
      agentId, baseUrl, connectedProviders, proxiedProviders, defaultModel,
    });
  } catch (err) {
    log(
      `  WARNING: Could not write config: ${err instanceof Error ? err.message : String(err)}`,
    );
    log("");
    log("  Add this to your openclaw.json manually:");
    log(JSON.stringify(configBlock, null, 2));
  }

  // Re-patch
  log("");
  log("  Re-applying vault credential proxy patch...");
  await patchOpenClawInteractive(log, opts);

  logDone(log, defaultModel, proxiedProviders);
}

// ---------------------------------------------------------------------------
// Mode 6: Remove AgentHiFive cleanly
// ---------------------------------------------------------------------------

async function runRemove(opts: SetupOptions): Promise<void> {
  const log: LogFn = (msg) => process.stdout.write(`${msg}\n`);

  log("");
  log("  Remove AgentHiFive");
  log("  " + "-".repeat(40));
  log("");

  const configPath = resolveConfigPath(opts);
  const existing = readExistingConfig(configPath);
  const hadChannelConfig = Boolean((existing.channels as Record<string, unknown> | undefined)?.agenthifive);
  const cleaned = removeAgentHiFiveChannelConfig(existing);

  if (hadChannelConfig) {
    writeFileSync(configPath, JSON.stringify(cleaned, null, 2) + "\n", "utf-8");
    log(`  Removed channels.agenthifive from ${configPath}`);
  } else {
    log("  No channels.agenthifive block found in config");
  }

  if (!isPluginInstalled()) {
    log("  AgentHiFive plugin is not installed.");
    return;
  }

  const uninstallCmd = "openclaw plugins uninstall agenthifive --force";
  log(`  Running: ${uninstallCmd}`);
  try {
    execSync(uninstallCmd, { stdio: "inherit" });
  } catch (err) {
    throw new Error(
      `Plugin uninstall failed after removing channel config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  let mode = opts.mode;

  // If no mode specified and not non-interactive, show menu
  if (!mode) {
    if (opts.nonInteractive) {
      // Non-interactive defaults to full setup
      mode = "setup";
    } else if (opts.baseUrl || opts.bootstrapSecret) {
      // If setup flags are given explicitly, assume first-time setup
      mode = "setup";
    } else {
      mode = await showMenu((msg) => process.stdout.write(`${msg}\n`));
    }
  }

  switch (mode) {
    case "configure-connections":
      return runConfigureConnections(opts);
    case "change-model":
      return runChangeModel(opts);
    case "reconnect":
      return runReconnect(opts);
    case "sync":
      return runSyncConnections(opts);
    case "remove":
      return runRemove(opts);
    case "verify": {
      const { runVerify } = await import("./verify.js");
      const ok = await runVerify(opts.openclawDir);
      if (!ok) process.exit(1);
      return;
    }
    default:
      return runFirstTimeSetup(opts);
  }
}

// ---------------------------------------------------------------------------
// Fallback: minimal config when token exchange fails
// ---------------------------------------------------------------------------

function outputMinimalConfig(
  log: LogFn,
  baseUrl: string,
  agentId: string,
  privateKey: JsonWebKey,
): void {
  const configBlock = buildConfigOutput({
    baseUrl,
    agentId,
    privateKey,
    connections: {},
    connectedProviders: [],
    proxiedProviders: [],
  });

  log("");
  log("  " + "=".repeat(50));
  log("  Add this to your openclaw.json manually:");
  log("  (capabilities could not be fetched - update manually)");
  log("  " + "=".repeat(50));
  log("");
  log(JSON.stringify(configBlock, null, 2));
  log("");
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

export function parseSetupArgs(args: string[]): SetupOptions {
  const opts: SetupOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--base-url" && args[i + 1]) {
      const val = args[++i];
      if (val) opts.baseUrl = val;
    } else if (arg === "--bootstrap-secret" && args[i + 1]) {
      const val = args[++i];
      if (val) opts.bootstrapSecret = val;
    } else if (arg === "--config-path" && args[i + 1]) {
      const val = args[++i];
      if (val) opts.configPath = val;
    } else if (arg === "--openclaw-dir" && args[i + 1]) {
      const val = args[++i];
      if (val) opts.openclawDir = val;
    } else if (arg === "--default-model" && args[i + 1]) {
      const val = args[++i];
      if (val) opts.defaultModel = val;
    } else if (arg === "--mode" && args[i + 1]) {
      const val = args[++i] as SetupMode;
      if (
        val === "setup"
        || val === "configure-connections"
        || val === "change-model"
        || val === "reconnect"
        || val === "verify"
        || val === "sync"
        || val === "remove"
      ) {
        opts.mode = val;
      }
    } else if (arg === "--non-interactive") {
      opts.nonInteractive = true;
    } else if (arg === "--skip-onboard") {
      opts.skipOnboard = true;
    } else if (arg === "--skip-plugin-install") {
      opts.skipPluginInstall = true;
    }
  }

  return opts;
}
