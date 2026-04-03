/**
 * OpenClaw config file discovery and merge utilities.
 *
 * Reimplements OpenClaw's config path resolution logic since we can't
 * import from the openclaw package (we're a plugin, not a dependency).
 *
 * Resolution order (matches OpenClaw's src/config/paths.ts):
 * 1. $OPENCLAW_CONFIG_PATH / $CLAWDBOT_CONFIG_PATH (explicit override)
 * 2. $OPENCLAW_STATE_DIR/openclaw.json
 * 3. ~/.openclaw/openclaw.json (preferred)
 * 4. Legacy: ~/.openclaw/clawdbot.json, ~/.clawdbot/, ~/.moltbot/, ~/.moldbot/
 * 5. Return null — caller must ask the user
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIRNAMES = [".openclaw", ".clawdbot", ".moltbot", ".moldbot"] as const;
const CONFIG_FILENAMES = [
  "openclaw.json",
  "clawdbot.json",
  "moltbot.json",
  "moldbot.json",
] as const;

// ---------------------------------------------------------------------------
// Home directory resolution (cross-platform)
// ---------------------------------------------------------------------------

function resolveHome(): string {
  // Match OpenClaw's home-dir.ts: OPENCLAW_HOME → HOME → USERPROFILE → os.homedir()
  const explicit = process.env.OPENCLAW_HOME?.trim();
  if (explicit && !explicit.startsWith("~")) return path.resolve(explicit);

  const home =
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    os.homedir();

  if (explicit) {
    // OPENCLAW_HOME starts with ~ — expand it
    return path.resolve(explicit.replace(/^~(?=$|[/\\])/, home));
  }

  return home;
}

function expandTilde(p: string): string {
  if (!p.startsWith("~")) return path.resolve(p);
  return path.resolve(p.replace(/^~(?=$|[/\\])/, resolveHome()));
}

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------

/**
 * Find an existing OpenClaw config file.
 *
 * Returns the absolute path to the first existing config file found,
 * or `null` if no config file exists anywhere. The caller should prompt
 * the user rather than silently creating a default file.
 */
export function resolveOpenClawConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // 1. Explicit override
  const explicit =
    env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    const resolved = expandTilde(explicit);
    return existsSync(resolved) ? resolved : null;
  }

  // 2. State dir override
  const stateDir =
    env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (stateDir) {
    const resolved = expandTilde(stateDir);
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(resolved, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  // 3. Default dirs × config filenames
  const home = resolveHome();
  for (const dir of STATE_DIRNAMES) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(home, dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  // 4. Not found — caller should ask the user
  return null;
}

/**
 * Return the canonical default config path (for prompting the user).
 */
export function defaultConfigPath(): string {
  return path.join(resolveHome(), ".openclaw", "openclaw.json");
}

// ---------------------------------------------------------------------------
// Config read / merge / write helpers
// ---------------------------------------------------------------------------

/**
 * Read an existing config file. Returns `{}` if the file doesn't exist.
 * Throws on parse errors so the caller can warn the user.
 */
export function readExistingConfig(
  configPath: string,
): Record<string, unknown> {
  if (!existsSync(configPath)) return {};

  const raw = readFileSync(configPath, "utf-8").trim();
  if (!raw) return {};

  // Try standard JSON first (most configs are valid JSON)
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Try stripping single-line comments and trailing commas (light JSON5 compat)
    const cleaned = raw
      .replace(/\/\/.*$/gm, "") // strip // comments
      .replace(/\/\*[\s\S]*?\*\//g, "") // strip /* */ comments
      .replace(/,(\s*[}\]])/g, "$1"); // strip trailing commas
    return JSON.parse(cleaned) as Record<string, unknown>;
  }
}

/**
 * Deep-merge the AgentHiFive plugin config into an existing OpenClaw config.
 *
 * - Sets `plugins.enabled = true`
 * - Adds `"agenthifive"` to `plugins.allow` (deduped)
 * - Replaces `plugins.entries.agenthifive` entirely (canonical source of truth lives under `channels.agenthifive`)
 * - Merges `models.providers` for LLM proxy baseUrl entries
 * - Merges `agents.defaults` for default model selection
 * - Preserves ALL other keys untouched
 */
export function mergePluginConfig(
  existing: Record<string, unknown>,
  pluginBlock: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...existing };

  // Extract our plugin config from the block buildConfigOutput() produces
  const srcPlugins = pluginBlock.plugins as Record<string, unknown> | undefined;

  if (srcPlugins) {
    const srcEntries = (srcPlugins.entries as Record<string, unknown>) ?? {};

    // Build merged plugins object
    const plugins = {
      ...((result.plugins as Record<string, unknown>) ?? {}),
    };

    plugins.enabled = true;

    // Merge allow list
    const allow = new Set<string>(
      (plugins.allow as string[] | undefined) ?? [],
    );
    allow.add("agenthifive");
    plugins.allow = [...allow];

    // Replace agenthifive entry entirely (fresh bootstrap replaces old)
    const entries = {
      ...((plugins.entries as Record<string, unknown>) ?? {}),
    };
    entries.agenthifive = srcEntries.agenthifive;
    plugins.entries = entries;

    result.plugins = plugins;
  }

  // Merge models.providers (LLM proxy baseUrl entries)
  const srcModels = pluginBlock.models as Record<string, unknown> | undefined;
  if (srcModels?.providers) {
    const models = {
      ...((result.models as Record<string, unknown>) ?? {}),
    };
    const existingProviders = (models.providers as Record<string, unknown>) ?? {};
    const providers: Record<string, unknown> = {};

    // Drop previously vault-managed providers so reconnecting to a different
    // vault/environment replaces them instead of accumulating stale entries.
    for (const [key, value] of Object.entries(existingProviders)) {
      const provider = value as Record<string, unknown> | undefined;
      if (provider?.apiKey === "vault-managed") continue;
      providers[key] = value;
    }

    const srcProviders = srcModels.providers as Record<string, unknown>;
    for (const [key, value] of Object.entries(srcProviders)) {
      providers[key] = value;
    }
    models.providers = providers;
    result.models = models;
  }

  // Merge tools.alsoAllow (ensure plugin tools are visible to the agent)
  const srcTools = pluginBlock.tools as Record<string, unknown> | undefined;
  if (srcTools?.alsoAllow) {
    const tools = {
      ...((result.tools as Record<string, unknown>) ?? {}),
    };
    const existing = new Set<string>(
      (tools.alsoAllow as string[] | undefined) ?? [],
    );
    for (const entry of srcTools.alsoAllow as string[]) {
      existing.add(entry);
    }
    tools.alsoAllow = [...existing];
    result.tools = tools;
  }

  // Merge agents.defaults (default model selection)
  const srcAgents = pluginBlock.agents as Record<string, unknown> | undefined;
  if (srcAgents?.defaults) {
    const agents = {
      ...((result.agents as Record<string, unknown>) ?? {}),
    };
    const existingDefaults = (agents.defaults as Record<string, unknown>) ?? {};
    const srcDefaults = srcAgents.defaults as Record<string, unknown>;
    const mergedHeartbeat =
      existingDefaults.heartbeat || srcDefaults.heartbeat
        ? {
            ...((existingDefaults.heartbeat as Record<string, unknown>) ?? {}),
            ...((srcDefaults.heartbeat as Record<string, unknown>) ?? {}),
          }
        : undefined;
    const defaults = {
      ...existingDefaults,
      ...srcDefaults,
      ...(mergedHeartbeat ? { heartbeat: mergedHeartbeat } : {}),
    };
    agents.defaults = defaults;
    result.agents = agents;
  }

  // Merge channels (vault-managed channel configs)
  const srcChannels = pluginBlock.channels as Record<string, unknown> | undefined;
  if (srcChannels && Object.keys(srcChannels).length > 0) {
    const channels = {
      ...((result.channels as Record<string, unknown>) ?? {}),
    };

    // Replace the AgentHiFive channel block entirely so reconnects don't keep
    // stale providers or old environment settings.
    channels.agenthifive = srcChannels.agenthifive;
    result.channels = channels;

    // Remove native plugin entries for vault-managed channels.
    // When a channel moves to AgentHiFive management, the old plugins.entries.<channel>
    // config (Socket Mode, groupPolicy, botToken, etc.) must be removed — otherwise
    // the agent sees it and thinks the channel is natively configured.
    const plugins = result.plugins as Record<string, unknown> | undefined;
    if (plugins) {
      const entries = plugins.entries as Record<string, unknown> | undefined;
      const allow = plugins.allow as string[] | undefined;
      const managedChannels = new Set<string>(Object.keys(srcChannels));
      const ah5Channels =
        (((srcChannels.agenthifive as Record<string, unknown> | undefined)?.accounts as Record<string, unknown> | undefined)
          ?.default as Record<string, unknown> | undefined)?.providers as Record<string, unknown> | undefined;
      for (const ch of Object.keys(ah5Channels ?? {})) {
        managedChannels.add(ch);
      }

      for (const ch of managedChannels) {
        if (ch !== "agenthifive" && ch in channels) {
          delete channels[ch];
        }
        if (entries && ch !== "agenthifive" && ch in entries) {
          delete entries[ch];
        }
        if (allow && ch !== "agenthifive") {
          const idx = allow.indexOf(ch);
          if (idx !== -1) allow.splice(idx, 1);
        }
      }
    }
  }

  return result;
}
