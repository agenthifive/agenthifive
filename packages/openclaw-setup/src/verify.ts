/**
 * Verification / diagnostics for an OpenClaw + AgentHiFive installation.
 *
 * Run via:  npx @agenthifive/openclaw-setup --verify
 *           ah5-setup --verify [--openclaw-dir /path/to/openclaw]
 *
 * Checks everything needed for a healthy installation:
 * 1. OpenClaw installation (location, version, install type)
 * 2. Dist chunk patch status (all chunks, version, globalThis bridge)
 * 3. Plugin installation
 * 4. Config file (vault URL, auth, LLM proxy baseUrls)
 * 5. Vault connectivity
 * 6. Backup file status
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed (actionable output provided)
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findOpenClawInstallDir,
  validateOpenClawDir,
  findDistChunks,
  findGatewayChunks,
  type OpenClawInstall,
} from "./auto-patch.js";
import { resolveOpenClawConfigPath } from "./config-discovery.js";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

let _hasFailures = false;

function ok(msg: string): void {
  process.stdout.write(`  ${GREEN}✔${NC} ${msg}\n`);
}
function fail(msg: string): void {
  _hasFailures = true;
  process.stdout.write(`  ${RED}✖${NC} ${msg}\n`);
}
function warn(msg: string): void {
  process.stdout.write(`  ${YELLOW}!${NC} ${msg}\n`);
}
function info(msg: string): void {
  process.stdout.write(`  ${DIM}${msg}${NC}\n`);
}
function heading(msg: string): void {
  process.stdout.write(`\n  ${msg}\n  ${"─".repeat(45)}\n`);
}

// ---------------------------------------------------------------------------
// Markers (must match auto-patch.ts)
// ---------------------------------------------------------------------------

const PATCH_MARKER = "@agenthifive/agenthifive/runtime";
const LEGACY_PATCH_MARKER = "@agenthifive/openclaw/runtime";
function hasAnyPatchMarker(s: string): boolean {
  return s.includes(PATCH_MARKER) || s.includes(LEGACY_PATCH_MARKER);
}
const PATCH_VERSION = "@ah5-patch-v5";
const BROADCAST_PATCH_MARKER = "@ah5-broadcast-bridge";
const BROADCAST_PATCH_VERSION = "@ah5-broadcast-v1";

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkInstallation(openclawDir?: string): OpenClawInstall | null {
  heading("OpenClaw Installation");

  let install: OpenClawInstall | null = null;

  if (openclawDir) {
    install = validateOpenClawDir(openclawDir);
    if (!install) {
      fail(`${openclawDir} is not an OpenClaw installation`);
      return null;
    }
    ok(`Found at ${install.dir} (user-specified)`);
  } else {
    install = findOpenClawInstallDir();
    if (!install) {
      fail("OpenClaw not found. Use --openclaw-dir or install: npm i -g openclaw");
      return null;
    }
    ok(`Found at ${install.dir}`);
  }

  // Version
  const pkgPath = path.join(install.dir, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    info(`Version: ${pkg.version ?? "unknown"}`);
  } catch {
    info("Version: unknown");
  }

  ok(`Install type: ${install.kind === "source" ? "source (TypeScript)" : "dist (compiled)"}`);
  return install;
}

function checkChunks(install: OpenClawInstall): { total: number; patched: number; unpatched: number } {
  heading("Patch Status");

  const stats = { total: 0, patched: 0, unpatched: 0 };

  if (install.kind === "source") {
    const target = path.join(install.dir, "src", "agents", "model-auth.ts");
    if (!existsSync(target)) {
      fail("model-auth.ts not found");
      return stats;
    }
    stats.total = 1;
    const content = readFileSync(target, "utf-8");
    if (content.includes(PATCH_VERSION)) {
      ok("model-auth.ts: patched (v5)");
      stats.patched = 1;
    } else if (hasAnyPatchMarker(content)) {
      warn("model-auth.ts: OLD patch version — re-run setup to update");
      stats.unpatched = 1;
    } else {
      warn("model-auth.ts: not patched");
      stats.unpatched = 1;
    }
    return stats;
  }

  // Dist install
  const distDir = path.join(install.dir, "dist");
  if (!existsSync(distDir)) {
    fail(`dist/ not found at ${distDir}`);
    return stats;
  }

  const chunks = findDistChunks(distDir);
  stats.total = chunks.length;

  if (chunks.length === 0) {
    fail("No chunks containing resolveApiKeyForProvider found in dist/");
    return stats;
  }

  for (const chunk of chunks) {
    const basename = path.basename(chunk);
    const content = readFileSync(chunk, "utf-8");

    if (content.includes(PATCH_VERSION)) {
      ok(`${basename}: patched (v5)`);
      stats.patched++;
    } else if (hasAnyPatchMarker(content)) {
      warn(`${basename}: OLD patch version — re-run setup to update`);
      stats.unpatched++;
    } else {
      warn(`${basename}: NOT patched`);
      stats.unpatched++;
    }
  }

  info(`Total: ${stats.total} | Patched: ${stats.patched} | Need patching: ${stats.unpatched}`);
  return stats;
}

function checkRuntimeBridge(install: OpenClawInstall): void {
  heading("Runtime Bridge");

  const distDir = path.join(install.dir, "dist");
  if (!existsSync(distDir)) {
    info("(skipped — source install)");
    return;
  }

  // Find a patched chunk to inspect
  const files = readdirSync(distDir).filter((f) => f.endsWith(".js"));
  let sampleContent: string | null = null;

  for (const file of files) {
    const content = readFileSync(path.join(distDir, file), "utf-8");
    if (content.includes(PATCH_VERSION)) {
      sampleContent = content;
      break;
    }
  }

  if (!sampleContent) {
    info("(skipped — no patched chunks found)");
    return;
  }

  if (sampleContent.includes("globalThis.__ah5_runtime")) {
    ok("Uses globalThis bridge (correct)");
  } else if (sampleContent.includes("await import(")) {
    fail("Uses OLD import() approach — re-run setup to update");
  } else {
    warn("Could not determine bridge approach");
  }

  if (sampleContent.includes("vault:agent-token")) {
    ok("Returns vault bearer token (Model B brokered proxy)");
  } else {
    fail("Does not return vault bearer token — patch may be corrupt");
  }
}

function checkBroadcastBridge(install: OpenClawInstall): void {
  heading("Broadcast Bridge");

  if (install.kind === "source") {
    info("(skipped — source install)");
    return;
  }

  const distDir = path.join(install.dir, "dist");
  const gwChunks = findGatewayChunks(distDir);

  if (gwChunks.length === 0) {
    warn("No gateway chunks found — approval wake-up won't work");
    return;
  }

  let patched = 0;
  for (const chunk of gwChunks) {
    const content = readFileSync(chunk, "utf-8");
    const basename = path.basename(chunk);
    if (content.includes(BROADCAST_PATCH_VERSION)) {
      ok(`${basename}: broadcast bridge active`);
      patched++;
    } else if (content.includes(BROADCAST_PATCH_MARKER)) {
      warn(`${basename}: OLD broadcast bridge — re-run setup`);
    } else {
      warn(`${basename}: no broadcast bridge`);
    }
  }

  if (patched === gwChunks.length) {
    ok("Approval watcher can push to TUI");
  } else {
    warn("Approval wake-up may not work — re-run setup to enable");
  }
}

function checkPlugin(): void {
  heading("Plugin");

  const extensionsDir = path.join(os.homedir(), ".openclaw", "extensions");
  if (!existsSync(extensionsDir)) {
    warn(`Extensions directory not found: ${extensionsDir}`);
    return;
  }

  const candidates = ["agenthifive", "@agenthifive"];
  let pluginDir: string | null = null;

  for (const name of candidates) {
    const candidate = path.join(extensionsDir, name);
    if (existsSync(candidate)) {
      pluginDir = candidate;
      break;
    }
  }

  // Also check subdirectories (npm may nest under @agenthifive/openclaw)
  if (!pluginDir) {
    const atDir = path.join(extensionsDir, "@agenthifive", "openclaw");
    if (existsSync(atDir)) pluginDir = atDir;
  }

  if (!pluginDir) {
    fail("Plugin not installed. Run: openclaw plugins install @agenthifive/agenthifive");
    return;
  }

  ok(`Installed at ${pluginDir}`);

  const pkgPath = path.join(pluginDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
      info(`Version: ${pkg.version ?? "unknown"}`);
    } catch {
      // ignore
    }
  }
}

function checkConfig(): void {
  heading("Configuration");

  const configPath = resolveOpenClawConfigPath();
  if (!configPath) {
    warn("No openclaw.json found");
    return;
  }

  ok(`Config: ${configPath}`);

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    fail(`Config parse error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const channels = config.channels as Record<string, unknown> | undefined;
  const agenthifiveChannel = channels?.agenthifive as Record<string, unknown> | undefined;
  const accounts = agenthifiveChannel?.accounts as Record<string, unknown> | undefined;
  const defaultAccount = accounts?.default as Record<string, unknown> | undefined;
  const channelAuth = defaultAccount?.auth as Record<string, unknown> | undefined;

  if (defaultAccount && channelAuth) {
    ok("Channel entry present");

    const baseUrl = defaultAccount.baseUrl as string | undefined;
    if (baseUrl) {
      ok(`Vault URL: ${baseUrl}`);
    } else {
      fail("No vault baseUrl configured");
    }

    if (channelAuth.mode) {
      ok(`Auth mode: ${channelAuth.mode as string}`);
      if (channelAuth.mode === "agent" && channelAuth.agentId) {
        const agentId = channelAuth.agentId as string;
        info(`Agent ID: ${agentId.slice(0, 12)}...`);
      }
    } else {
      fail("No auth configured");
    }

    const providers = defaultAccount.providers as Record<string, unknown> | undefined;
    const connected = Object.entries(providers ?? {})
      .filter(([, provider]) => (provider as Record<string, unknown> | undefined)?.enabled !== false)
      .map(([provider]) => provider);
    if (connected.length > 0) {
      ok(`Connected providers: ${connected.join(", ")}`);
    }
    return;
  }

  // Legacy plugin entry
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const ah5 = entries?.agenthifive as Record<string, unknown> | undefined;

  if (!ah5) {
    warn("No plugins.entries.agenthifive in config");
    return;
  }
  ok("Plugin entry present");

  const pluginConfig = ah5.config as Record<string, unknown> | undefined;
  if (!pluginConfig) {
    warn("No plugin config block");
    return;
  }

  // Vault URL
  const baseUrl = pluginConfig.baseUrl as string | undefined;
  if (baseUrl) {
    ok(`Vault URL: ${baseUrl}`);
  } else {
    fail("No vault baseUrl configured");
  }

  // Auth
  const auth = pluginConfig.auth as Record<string, unknown> | undefined;
  if (auth?.mode) {
    ok(`Auth mode: ${auth.mode}`);
    if (auth.mode === "agent" && auth.agentId) {
      const agentId = auth.agentId as string;
      info(`Agent ID: ${agentId.slice(0, 12)}...`);
    }
  } else {
    fail("No auth configured");
  }

  // Connected providers
  const connected = pluginConfig.connectedProviders as string[] | undefined;
  if (connected && connected.length > 0) {
    ok(`Connected providers: ${connected.join(", ")}`);
  }

  // Proxied providers
  const proxied = pluginConfig.proxiedProviders as string[] | undefined;
  if (proxied && proxied.length > 0) {
    ok(`Proxied LLM providers: ${proxied.join(", ")}`);
  }

  // models.providers (LLM proxy baseUrl redirects)
  const models = config.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, Record<string, unknown>> | undefined;
  if (providers) {
    const proxiedViaBaseUrl = Object.entries(providers)
      .filter(([, v]) => typeof v?.baseUrl === "string" && (v.baseUrl as string).includes("/v1/vault/llm/"))
      .map(([k]) => k);
    if (proxiedViaBaseUrl.length > 0) {
      ok(`LLM proxy baseUrl (Model B): ${proxiedViaBaseUrl.join(", ")}`);
    }
  }

  // Warn about stale load.paths
  const load = plugins?.load as Record<string, unknown> | undefined;
  if (load?.paths) {
    warn("plugins.load.paths is set — this is unnecessary and may cause issues");
    info("Remove it from config; the plugin loads from ~/.openclaw/extensions/");
  }
}

async function checkVaultConnectivity(configPath: string | null): Promise<void> {
  heading("Vault Connectivity");

  if (!configPath) {
    info("(skipped — no config file)");
    return;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    info("(skipped — config parse error)");
    return;
  }

  const channels = config.channels as Record<string, unknown> | undefined;
  const agenthifiveChannel = channels?.agenthifive as Record<string, unknown> | undefined;
  const accounts = agenthifiveChannel?.accounts as Record<string, unknown> | undefined;
  const defaultAccount = accounts?.default as Record<string, unknown> | undefined;
  const channelBaseUrl = defaultAccount?.baseUrl as string | undefined;

  const plugins = config.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const ah5 = entries?.agenthifive as Record<string, unknown> | undefined;
  const pluginConfig = ah5?.config as Record<string, unknown> | undefined;
  const baseUrl = channelBaseUrl ?? (pluginConfig?.baseUrl as string | undefined);

  if (!baseUrl) {
    info("(skipped — no vault baseUrl)");
    return;
  }

  // Health check
  try {
    const response = await fetch(`${baseUrl}/v1/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      ok(`Vault reachable at ${baseUrl} (${response.status})`);
    } else {
      fail(`Vault returned ${response.status} at ${baseUrl}/v1/health`);
    }
  } catch (err) {
    fail(`Cannot reach vault: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function checkBackups(install: OpenClawInstall): void {
  heading("Backups");

  const distDir = path.join(install.dir, "dist");
  if (!existsSync(distDir)) {
    info("(no dist/ directory)");
    return;
  }

  const backups = readdirSync(distDir).filter((f) => f.endsWith(".js.bak"));
  if (backups.length > 0) {
    ok(`${backups.length} backup(s): ${backups.join(", ")}`);
  } else {
    info("No backup files");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runVerify(openclawDir?: string): Promise<boolean> {
  process.stdout.write("\n  AgentHiFive Installation Verification\n");
  process.stdout.write("  ═══════════════════════════════════════════\n");

  // 1. Installation
  const install = checkInstallation(openclawDir);
  if (!install) {
    process.stdout.write(`\n  ${RED}Verification failed — OpenClaw not found${NC}\n\n`);
    return false;
  }

  // 2. Chunks
  const { total, patched, unpatched } = checkChunks(install);

  // 3. Runtime bridge
  checkRuntimeBridge(install);

  // 3b. Broadcast bridge (approval watcher → TUI)
  checkBroadcastBridge(install);

  // 4. Plugin
  checkPlugin();

  // 5. Config
  checkConfig();

  // 6. Vault connectivity
  const configPath = resolveOpenClawConfigPath();
  await checkVaultConnectivity(configPath);

  // 7. Backups
  checkBackups(install);

  // Summary
  process.stdout.write("\n  ═══════════════════════════════════════════\n");
  if (!_hasFailures && total > 0 && unpatched === 0) {
    process.stdout.write(`  ${GREEN}All checks passed — ${patched}/${total} chunk(s) patched${NC}\n\n`);
    return true;
  } else if (unpatched > 0 && !_hasFailures) {
    process.stdout.write(`  ${YELLOW}${unpatched} chunk(s) need patching${NC}\n`);
    process.stdout.write(`  Run setup again to apply:\n`);
    process.stdout.write(`    npx @agenthifive/openclaw-setup --base-url <url> --bootstrap-secret <secret>\n\n`);
    return false;
  } else {
    process.stdout.write(`  ${RED}Issues found — see above${NC}\n\n`);
    return false;
  }
}
