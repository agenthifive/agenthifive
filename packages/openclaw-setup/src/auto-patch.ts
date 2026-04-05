/**
 * Auto-patching for OpenClaw's credential resolution.
 *
 * Finds the OpenClaw installation and injects vault credential resolution
 * into resolveApiKeyForProvider(). Supports both source installs (TypeScript)
 * and npm installs (compiled JS chunks with hashed filenames).
 *
 * The patch adds two tiers before local profile resolution:
 * - Tier 0: Proxied providers (vault bearer token used directly)
 * - Tier 0.5: Credential provider chain (query vault before local profiles)
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenClawInstall {
  dir: string;
  kind: "source" | "dist";
}

export interface PatchResult {
  applied: boolean;
  alreadyPatched: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Marker used to detect if the patch is already applied
// ---------------------------------------------------------------------------

const PATCH_MARKER = "@agenthifive/agenthifive/runtime";
const LEGACY_PATCH_MARKER = "@agenthifive/openclaw/runtime";

function hasAnyPatchMarker(source: string): boolean {
  return source.includes(PATCH_MARKER) || source.includes(LEGACY_PATCH_MARKER);
}
const PATCH_VERSION = "@ah5-patch-v5";

// ---------------------------------------------------------------------------
// Code injected into compiled dist files
// ---------------------------------------------------------------------------

/**
 * Build the injected code block.
 * Reads from globalThis.__ah5_runtime which is set by the plugin's runtime module.
 * This avoids ESM module cache issues where different chunks get different
 * module instances of the same file.
 */
function buildInjectedCode(): string {
  return `
\t// -- AgentHiFive: vault LLM proxy (Model B brokered) --
\t// @agenthifive/agenthifive/runtime @ah5-patch-v5
\ttry {
\t\tconst ah5rt = globalThis.__ah5_runtime;
\t\tif (ah5rt?.proxiedProviders?.includes(provider) && ah5rt?.vaultBearerToken) {
\t\t\treturn { apiKey: ah5rt.vaultBearerToken, source: "vault:agent-token", mode: "api-key" };
\t\t} else if (ah5rt) {
\t\t\tconsole.warn("[AH5 patch] provider \\"%s\\" not in proxiedProviders %s (token=%s)", provider, JSON.stringify(ah5rt.proxiedProviders), ah5rt.vaultBearerToken ? "set" : "null");
\t\t}
\t} catch (ah5Err) {
\t\tconsole.error("[AH5 patch] error:", ah5Err?.message ?? ah5Err);
\t}
`;
}

function buildHeaderInjectionCode(): string {
  return `
\t// -- AgentHiFive: inject session + approval replay headers for vault-managed LLM proxy --
\t// @agenthifive/agenthifive/runtime @ah5-patch-v5
\tif (auth?.source === "vault:agent-token") try {
\t\tconst ah5rt = globalThis.__ah5_runtime;
\t\tconst sessionKey = typeof ah5rt?.currentSessionKey === "string" ? ah5rt.currentSessionKey.trim() : "";
\t\tconst approvals = ah5rt?.approvedLlmApprovals && typeof ah5rt.approvedLlmApprovals === "object"
\t\t\t? ah5rt.approvedLlmApprovals
\t\t\t: undefined;
\t\tconst approvalId = sessionKey && approvals && typeof approvals[sessionKey] === "string"
\t\t\t? approvals[sessionKey]
\t\t\t: undefined;
\t\tif (approvalId && approvals) delete approvals[sessionKey];
\t\tif (sessionKey || approvalId) {
\t\t\treturn { ...model, headers: { ...model.headers, ...(sessionKey ? { "x-ah5-session-key": sessionKey } : {}), ...(approvalId ? { "x-ah5-approval-id": approvalId } : {}) } };
\t\t}
\t} catch (ah5Err) {
\t\tconsole.error("[AH5 patch] header inject error:", ah5Err?.message ?? ah5Err);
\t}
`;
}

// ---------------------------------------------------------------------------
// Anchor patterns
// ---------------------------------------------------------------------------

/**
 * Regex matching the store assignment line in resolveApiKeyForProvider.
 * This is stable across upstream versions — it's the first line after
 * the destructuring of params.
 *
 * Upstream dist (2026.3.13):
 *   const store = params.store ?? ensureAuthProfileStore(params.agentDir);
 *   if (profileId) {
 *
 * Some bundler chunks may use different variable names or inline the store
 * differently, so we have multiple anchor patterns (tried in order).
 */
const DIST_ANCHORS = [
  // Primary: exact store assignment
  /const store\s*=\s*params\.store\s*\?\?\s*ensureAuthProfileStore\(params\.agentDir\);\n/,
  // Fallback: any variable = params.store ?? ensureAuthProfileStore(...)
  /(?:const|let|var)\s+\w+\s*=\s*params\.store\s*\?\?\s*ensureAuthProfileStore\([^)]*\);\n/,
  // Fallback 2: function opening — inject right after the opening brace
  /async function resolveApiKeyForProvider\([^)]*\)\s*\{[^\n]*\n/,
];

const HEADER_OVERRIDE_ANCHORS = [
  /function applyLocalNoAuthHeaderOverride\([^)]*\)\s*\{[^\n]*\n/,
];

// ---------------------------------------------------------------------------
// Find OpenClaw installation
// ---------------------------------------------------------------------------

/**
 * Locate the OpenClaw installation directory.
 *
 * Strategy (cascading, first match wins):
 * 1. `which`/`where` openclaw → resolve symlink → walk up to package.json
 * 2. `npm root -g` → check for openclaw package
 * 3. Well-known paths (Linux, macOS, Windows)
 * 4. `find` as last resort (Linux/macOS only, with timeout)
 *
 * Returns null if not found — caller should ask the user.
 */
export function findOpenClawInstallDir(): OpenClawInstall | null {
  // Strategy 1: scan PATH for openclaw binary → resolve symlink
  const result = findViaPath();
  if (result) return result;

  // Strategy 2: derive global node_modules from Node.js binary location
  const npmResult = findViaNpmPrefix();
  if (npmResult) return npmResult;

  // Strategy 3: well-known paths
  const wellKnown = findViaWellKnownPaths();
  if (wellKnown) return wellKnown;

  // Strategy 4: recursive directory scan (last resort)
  const found = findViaRecursiveScan();
  if (found) return found;

  return null;
}

function classifyInstall(dir: string): OpenClawInstall {
  const hasSrc = existsSync(
    path.join(dir, "src", "agents", "model-auth.ts"),
  );
  return { dir, kind: hasSrc ? "source" : "dist" };
}

function isOpenClawDir(dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      name?: string;
    };
    return pkg.name === "openclaw";
  } catch {
    return false;
  }
}

function walkUpToPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (isOpenClawDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findViaPath(): OpenClawInstall | null {
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];

  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `openclaw${ext}`);
      if (!existsSync(candidate)) continue;

      // Resolve symlinks to find the real binary location
      let realBin: string;
      try {
        realBin = realpathSync(candidate);
      } catch {
        realBin = candidate;
      }

      // Walk up from binary to find package root
      const root = walkUpToPackageRoot(path.dirname(realBin));
      if (root) return classifyInstall(root);

      // Binary might be a wrapper script — check if it references a node_modules path
      try {
        const content = readFileSync(realBin, "utf-8");
        const match = /["']([^"']+openclaw[^"']*)['"]/i.exec(content);
        if (match?.[1]) {
          const resolved = path.resolve(path.dirname(realBin), match[1]);
          const root2 = walkUpToPackageRoot(path.dirname(resolved));
          if (root2) return classifyInstall(root2);
        }
      } catch {
        // Not readable as text
      }
    }
  }
  return null;
}

function findViaNpmPrefix(): OpenClawInstall | null {
  // Derive global node_modules from the running Node.js binary location
  // e.g. /usr/lib/node_modules/openclaw or /home/user/.nvm/versions/node/v24/lib/node_modules/openclaw
  const nodeDir = path.dirname(process.execPath); // e.g. /usr/bin or .../bin
  const prefixDir = path.dirname(nodeDir); // e.g. /usr or .../v24

  const candidate = path.join(prefixDir, "lib", "node_modules", "openclaw");
  if (isOpenClawDir(candidate)) return classifyInstall(candidate);

  // Also check directly under prefix (some setups)
  const candidate2 = path.join(prefixDir, "node_modules", "openclaw");
  if (isOpenClawDir(candidate2)) return classifyInstall(candidate2);

  return null;
}

function findViaWellKnownPaths(): OpenClawInstall | null {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    // Windows: AppData paths derived from home directory
    candidates.push(
      path.join(home, "AppData", "Roaming", "npm", "node_modules", "openclaw"),
      path.join(home, "AppData", "Local", "pnpm", "global", "5", "node_modules", "openclaw"),
    );
  } else {
    candidates.push(
      "/usr/lib/node_modules/openclaw",
      "/usr/local/lib/node_modules/openclaw",
      path.join(home, ".local/share/pnpm/global/5/node_modules/openclaw"),
    );

    if (process.platform === "darwin") {
      candidates.push(
        "/opt/homebrew/lib/node_modules/openclaw",
      );
    }
  }

  for (const candidate of candidates) {
    if (isOpenClawDir(candidate)) return classifyInstall(candidate);
  }
  return null;
}

function findViaRecursiveScan(): OpenClawInstall | null {
  const home = os.homedir();
  const searchDirs = ["/usr", "/opt", home].filter(
    (d) => d && existsSync(d),
  );

  const matches: string[] = [];
  const maxDepth = 8;

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth || matches.length > 1) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip hidden dirs, node_modules internals, and proc/sys
        if (entry.name.startsWith(".") && entry.name !== ".nvm" && entry.name !== ".local") continue;
        if (entry.name === "node_modules" && depth > 0) {
          // Check for openclaw directly inside node_modules
          const candidate = path.join(dir, entry.name, "openclaw");
          if (isOpenClawDir(candidate)) matches.push(candidate);
          continue;
        }
        if (entry.name === "openclaw") {
          const candidate = path.join(dir, entry.name);
          if (isOpenClawDir(candidate)) {
            matches.push(candidate);
            continue;
          }
        }
        scan(path.join(dir, entry.name), depth + 1);
      }
    } catch {
      // Permission denied or other error
    }
  }

  for (const searchDir of searchDirs) {
    scan(searchDir, 0);
    if (matches.length > 1) return null; // Multiple — caller should ask user
  }

  if (matches.length === 1) return classifyInstall(matches[0]!);
  return null;
}

/**
 * Find all OpenClaw installations (for disambiguation when multiple exist).
 */
export function findAllOpenClawInstalls(): OpenClawInstall[] {
  const results: OpenClawInstall[] = [];
  const seen = new Set<string>();

  const add = (install: OpenClawInstall | null) => {
    if (!install) return;
    const resolved = path.resolve(install.dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    results.push({ ...install, dir: resolved });
  };

  add(findViaPath());
  add(findViaNpmPrefix());
  add(findViaWellKnownPaths());

  return results;
}

// ---------------------------------------------------------------------------
// Validate user-provided path
// ---------------------------------------------------------------------------

/**
 * Validate a user-provided OpenClaw installation path.
 */
export function validateOpenClawDir(dir: string): OpenClawInstall | null {
  const resolved = path.resolve(dir);
  if (!isOpenClawDir(resolved)) return null;
  return classifyInstall(resolved);
}

// ---------------------------------------------------------------------------
// Apply patch to dist (compiled JS)
// ---------------------------------------------------------------------------

/**
 * Find ALL chunk files containing resolveApiKeyForProvider in dist/.
 * OpenClaw's bundler may create multiple copies for different entry points
 * (gateway, TUI, CLI) — we need to patch all of them.
 */
export function findDistChunks(distDir: string): string[] {
  if (!existsSync(distDir)) return [];

  const files = readdirSync(distDir).filter((f) => f.endsWith(".js"));
  const matches: string[] = [];

  for (const file of files) {
    const filePath = path.join(distDir, file);
    const content = readFileSync(filePath, "utf-8");
    // Match any file with the function DEFINITION (not just a call reference).
    // The bundler duplicates the function into multiple entry-point chunks.
    if (content.includes("async function resolveApiKeyForProvider")) {
      matches.push(filePath);
    }
  }

  return matches;
}


export function applyDistPatch(openclawDir: string): PatchResult {
  const distDir = path.join(openclawDir, "dist");
  const chunkPaths = findDistChunks(distDir);

  if (chunkPaths.length === 0) {
    return {
      applied: false,
      alreadyPatched: false,
      message:
        "Could not find resolveApiKeyForProvider in OpenClaw dist/. " +
        "The OpenClaw version may be incompatible.",
    };
  }

  const injectedCode = buildInjectedCode();
  const headerInjectionCode = buildHeaderInjectionCode();
  const patchedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const chunkPath of chunkPaths) {
    let source = readFileSync(chunkPath, "utf-8");
    const basename = path.basename(chunkPath);

    // Already patched with current version?
    if (source.includes(PATCH_VERSION)) {
      skippedFiles.push(basename);
      continue;
    }

    // Patched with older version — restore backup and re-patch
    if (hasAnyPatchMarker(source)) {
      const backupPath = chunkPath + ".bak";
      if (existsSync(backupPath)) {
        source = readFileSync(backupPath, "utf-8");
      } else {
        // No backup — strip the old patch by finding the anchor and everything after it
        // until the next function. Safest: just skip and warn.
        failedFiles.push(`${basename} (old patch, no backup)`);
        continue;
      }
    }

    // Find anchors for auth resolution + header override
    let authMatch: RegExpExecArray | null = null;
    for (const anchor of DIST_ANCHORS) {
      authMatch = anchor.exec(source);
      if (authMatch) break;
    }
    let headerMatch: RegExpExecArray | null = null;
    for (const anchor of HEADER_OVERRIDE_ANCHORS) {
      headerMatch = anchor.exec(source);
      if (headerMatch) break;
    }
    if (!authMatch || !headerMatch) {
      failedFiles.push(basename);
      continue;
    }

    // Create backup (from the clean source)
    const backupPath = chunkPath + ".bak";
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, source);
    }

    // Inject code after both anchor lines, preserving correct offsets.
    const insertions = [
      { index: authMatch.index + authMatch[0].length, code: injectedCode },
      { index: headerMatch.index + headerMatch[0].length, code: headerInjectionCode },
    ].sort((a, b) => a.index - b.index);

    let patched = source;
    let offset = 0;
    for (const insertion of insertions) {
      const pos = insertion.index + offset;
      patched = patched.slice(0, pos) + insertion.code + patched.slice(pos);
      offset += insertion.code.length;
    }

    writeFileSync(chunkPath, patched);
    patchedFiles.push(basename);
  }

  if (patchedFiles.length === 0 && skippedFiles.length > 0) {
    return {
      applied: true,
      alreadyPatched: true,
      message: `Already patched: ${skippedFiles.join(", ")}`,
    };
  }

  if (patchedFiles.length === 0) {
    return {
      applied: false,
      alreadyPatched: false,
      message:
        `Found ${chunkPaths.length} chunk(s) but could not locate anchor point in any. ` +
        "The OpenClaw version may be incompatible.",
    };
  }

  const parts = [`Patched ${patchedFiles.length} chunk(s): ${patchedFiles.join(", ")}`];
  if (skippedFiles.length > 0) parts.push(`(${skippedFiles.length} already patched)`);
  if (failedFiles.length > 0) parts.push(`(${failedFiles.length} failed: ${failedFiles.join(", ")})`);

  return {
    applied: true,
    alreadyPatched: false,
    message: parts.join(" "),
  };
}

// ---------------------------------------------------------------------------
// Apply patch to source install
// ---------------------------------------------------------------------------

export function applySourcePatch(openclawDir: string): PatchResult {
  const targetFile = path.join(
    openclawDir,
    "src",
    "agents",
    "model-auth.ts",
  );

  if (!existsSync(targetFile)) {
    return {
      applied: false,
      alreadyPatched: false,
      message: "src/agents/model-auth.ts not found",
    };
  }

  let source = readFileSync(targetFile, "utf-8");

  if (source.includes(PATCH_VERSION)) {
    return {
      applied: true,
      alreadyPatched: true,
      message: "Source already patched",
    };
  }

  // Patched with older version — restore backup and re-patch
  if (hasAnyPatchMarker(source)) {
    const backupPath = targetFile + ".bak";
    if (existsSync(backupPath)) {
      source = readFileSync(backupPath, "utf-8");
    }
  }

  // Text injection (same approach as dist patching, with spaces instead of tabs)
  let authMatch: RegExpExecArray | null = null;
  for (const anchor of DIST_ANCHORS) {
    authMatch = anchor.exec(source);
    if (authMatch) break;
  }
  let headerMatch: RegExpExecArray | null = null;
  for (const anchor of HEADER_OVERRIDE_ANCHORS) {
    headerMatch = anchor.exec(source);
    if (headerMatch) break;
  }
  if (authMatch && headerMatch) {
    const backupPath = targetFile + ".bak";
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, source);
    }

    const insertions = [
      {
        index: authMatch.index + authMatch[0].length,
        code: `\n${buildInjectedCode().replace(/\t/g, "  ")}\n`,
      },
      {
        index: headerMatch.index + headerMatch[0].length,
        code: `\n${buildHeaderInjectionCode().replace(/\t/g, "  ")}\n`,
      },
    ].sort((a, b) => a.index - b.index);

    let patched = source;
    let offset = 0;
    for (const insertion of insertions) {
      const pos = insertion.index + offset;
      patched = patched.slice(0, pos) + insertion.code + patched.slice(pos);
      offset += insertion.code.length;
    }

    writeFileSync(targetFile, patched);
    return {
      applied: true,
      alreadyPatched: false,
      message: `Source patched (backup: ${path.basename(backupPath)})`,
    };
  }

  return {
    applied: false,
    alreadyPatched: false,
    message: "Could not locate anchor point in source file",
  };
}

// ---------------------------------------------------------------------------
// Unified apply
// ---------------------------------------------------------------------------

/**
 * Apply the credential resolution patch to an OpenClaw installation.
 * Automatically detects source vs dist installs.
 */
export function applyPatch(install: OpenClawInstall): PatchResult {
  return install.kind === "source"
    ? applySourcePatch(install.dir)
    : applyDistPatch(install.dir);
}

// ---------------------------------------------------------------------------
// Broadcast bridge patch — exposes gateway broadcast on globalThis.__ah5_runtime
// ---------------------------------------------------------------------------

const BROADCAST_PATCH_MARKER = "@ah5-broadcast-bridge";
const BROADCAST_PATCH_VERSION = "@ah5-broadcast-v1";

/**
 * Code injected after the `const broadcast = ...` line in gateway chunks.
 * Exposes broadcast on globalThis.__ah5_runtime so the plugin's approval
 * watcher can push events directly to the TUI without going through HTTP
 * hooks (which fail due to bundler module duplication).
 */
function buildBroadcastBridgeCode(): string {
  return `
\t// -- AgentHiFive: broadcast bridge for approval watcher --
\t// ${BROADCAST_PATCH_MARKER} ${BROADCAST_PATCH_VERSION}
\ttry {
\t\tif (typeof globalThis !== "undefined") {
\t\t\tif (!globalThis.__ah5_runtime) globalThis.__ah5_runtime = {};
\t\t\tglobalThis.__ah5_runtime.broadcast = broadcast;
\t\t}
\t} catch (_ah5BrErr) {}
`;
}

/**
 * Anchor patterns for the broadcast definition line in gateway chunks.
 * The broadcast function is defined in src/gateway/server.impl.ts and
 * compiled into gateway-cli-*.js chunks.
 */
const BROADCAST_ANCHORS = [
  // Primary: exact broadcast definition
  /\tconst broadcast = \(event, payload, opts\) => broadcastInternal\(event, payload, opts\);\n/,
  // Fallback: any broadcast assignment using broadcastInternal
  /\t(?:const|let|var)\s+broadcast\s*=\s*\([^)]*\)\s*=>\s*broadcastInternal\([^)]*\);\n/,
];

/**
 * Find gateway chunks that contain the broadcast definition.
 */
export function findGatewayChunks(distDir: string): string[] {
  if (!existsSync(distDir)) return [];

  const files = readdirSync(distDir).filter((f) => f.endsWith(".js"));
  const matches: string[] = [];

  for (const file of files) {
    const filePath = path.join(distDir, file);
    const content = readFileSync(filePath, "utf-8");
    if (content.includes("broadcastInternal(event, payload, opts)") &&
        content.includes("startGatewaySidecars")) {
      matches.push(filePath);
    }
  }

  return matches;
}

/**
 * Apply the broadcast bridge patch to gateway dist chunks.
 * This is separate from the credential patch — it targets different chunks
 * and has its own marker/version.
 */
export function applyBroadcastPatch(openclawDir: string): PatchResult {
  const distDir = path.join(openclawDir, "dist");
  const chunkPaths = findGatewayChunks(distDir);

  if (chunkPaths.length === 0) {
    return {
      applied: false,
      alreadyPatched: false,
      message:
        "Could not find gateway broadcast definition in OpenClaw dist/. " +
        "The OpenClaw version may be incompatible.",
    };
  }

  const injectedCode = buildBroadcastBridgeCode();
  const patchedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const chunkPath of chunkPaths) {
    const source = readFileSync(chunkPath, "utf-8");
    const basename = path.basename(chunkPath);

    // Already patched?
    if (source.includes(BROADCAST_PATCH_VERSION)) {
      skippedFiles.push(basename);
      continue;
    }

    // Find anchor
    let match: RegExpExecArray | null = null;
    for (const anchor of BROADCAST_ANCHORS) {
      match = anchor.exec(source);
      if (match) break;
    }
    if (!match) {
      failedFiles.push(basename);
      continue;
    }

    // Inject after the broadcast definition line
    const insertPos = match.index + match[0].length;
    const patched =
      source.slice(0, insertPos) + injectedCode + source.slice(insertPos);

    writeFileSync(chunkPath, patched);
    patchedFiles.push(basename);
  }

  if (patchedFiles.length === 0 && skippedFiles.length > 0) {
    return {
      applied: true,
      alreadyPatched: true,
      message: `Broadcast bridge already patched: ${skippedFiles.join(", ")}`,
    };
  }

  if (patchedFiles.length === 0) {
    return {
      applied: false,
      alreadyPatched: false,
      message:
        `Found ${chunkPaths.length} gateway chunk(s) but could not locate broadcast anchor. ` +
        "The OpenClaw version may be incompatible.",
    };
  }

  const parts = [`Broadcast bridge patched ${patchedFiles.length} chunk(s): ${patchedFiles.join(", ")}`];
  if (skippedFiles.length > 0) parts.push(`(${skippedFiles.length} already patched)`);
  if (failedFiles.length > 0) parts.push(`(${failedFiles.length} failed: ${failedFiles.join(", ")})`);

  return {
    applied: true,
    alreadyPatched: false,
    message: parts.join(" "),
  };
}

/**
 * Check if the broadcast bridge patch is applied.
 */
export function isBroadcastPatchApplied(install: OpenClawInstall): boolean {
  if (install.kind === "source") return false; // Source installs don't need this
  const chunks = findGatewayChunks(path.join(install.dir, "dist"));
  if (chunks.length === 0) return false;
  return chunks.some((p) => readFileSync(p, "utf-8").includes(BROADCAST_PATCH_MARKER));
}

// ---------------------------------------------------------------------------
// Check if patch is applied
// ---------------------------------------------------------------------------

/**
 * Check if the credential resolution patch is applied in an OpenClaw installation.
 */
export function isPatchApplied(install: OpenClawInstall): boolean {
  if (install.kind === "source") {
    const file = path.join(install.dir, "src", "agents", "model-auth.ts");
    if (!existsSync(file)) return false;
    return hasAnyPatchMarker(readFileSync(file, "utf-8"));
  }

  const chunks = findDistChunks(path.join(install.dir, "dist"));
  if (chunks.length === 0) return false;
  return chunks.some((p) => hasAnyPatchMarker(readFileSync(p, "utf-8")));
}
