/**
 * Runtime verification of whether OpenClaw core patches are applied.
 *
 * Called during plugin registration to inform the user whether credential
 * proxying features are available. The plugin works fully (tools, hooks,
 * prompt injection) WITHOUT patches — they only enable LLM credential
 * proxying via model-auth.ts.
 *
 * Detection strategies:
 * 1. import.meta.resolve — finds sibling model-auth.js (works when plugin
 *    is co-located with OpenClaw, e.g. source/dev installs)
 * 2. PATH scan — finds the openclaw binary, walks to dist/,
 *    finds the chunk with resolveApiKeyForProvider, checks for patch marker
 */

import type { PluginLogger } from "./pending-approvals.js";
import { getPathEnv, readText, pathExists, listDir, realPath } from "./env-paths.js";

const PATCH_MARKERS = [
  "@agenthifive/agenthifive/runtime",
  "@agenthifive/openclaw/runtime", // legacy marker from pre-0.4.0
];

export type PatchStatus = {
  /** Whether the model-auth.ts patch is applied (Tier 0 + Tier 0.5) */
  modelAuth: boolean;
};

/**
 * Probe whether the model-auth patch is applied by checking if OpenClaw's
 * resolveApiKeyForProvider function consults our runtime module.
 */
export async function verifyPatches(logger: PluginLogger): Promise<PatchStatus> {
  const status: PatchStatus = { modelAuth: false };

  // Strategy 1: Check sibling module (source/dev installs)
  try {
    const modelAuthPath = await findModuleFile("../agents/model-auth.js");
    if (modelAuthPath) {
      const source = readText(modelAuthPath);
      status.modelAuth = PATCH_MARKERS.some((m) => source.includes(m));
    }
  } catch {
    // Module not found — try strategy 2
  }

  // Strategy 2: Find OpenClaw via PATH and check dist chunk
  if (!status.modelAuth) {
    try {
      status.modelAuth = await checkPatchViaPath();
    } catch {
      // Detection failed — assume not patched
    }
  }

  if (!status.modelAuth) {
    logger.warn?.(
      "AgentHiFive: model-auth patch not detected. LLM credential proxying is unavailable. " +
        "Tools, prompt injection, and approval flow work normally. " +
        "Run 'npx @agenthifive/openclaw-setup' to apply the patch automatically.",
    );
  } else {
    logger.info?.("AgentHiFive: model-auth patch detected — credential proxying enabled");
  }

  return status;
}

/**
 * Attempt to find the filesystem path of a module relative to openclaw's location.
 * Returns null if the module cannot be found.
 */
async function findModuleFile(specifier: string): Promise<string | null> {
  try {
    const resolved = import.meta.resolve(specifier);
    if (resolved.startsWith("file://")) {
      const { fileURLToPath } = await import("node:url");
      return fileURLToPath(resolved);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find OpenClaw via PATH, locate the dist chunk containing
 * resolveApiKeyForProvider, and check for the patch marker.
 */
async function checkPatchViaPath(): Promise<boolean> {
  const path = await import("node:path");

  const pathEnv = getPathEnv();
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];

  // Find openclaw binary
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `openclaw${ext}`);
      if (!pathExists(candidate)) continue;

      let realBin: string;
      try {
        realBin = realPath(candidate);
      } catch {
        realBin = candidate;
      }

      // Walk up to find package root with name "openclaw"
      let pkgDir = path.dirname(realBin);
      for (let i = 0; i < 10; i++) {
        const pkgPath = path.join(pkgDir, "package.json");
        if (pathExists(pkgPath)) {
          try {
            const pkg = JSON.parse(readText(pkgPath)) as { name?: string };
            if (pkg.name === "openclaw") {
              // Found it — check dist for patch marker
              return checkDistForPatch(path.join(pkgDir, "dist"));
            }
          } catch {
            // Not valid JSON
          }
        }
        const parent = path.dirname(pkgDir);
        if (parent === pkgDir) break;
        pkgDir = parent;
      }
    }
  }

  return false;
}

function checkDistForPatch(distDir: string): boolean {
  if (!pathExists(distDir)) return false;

  const files = listDir(distDir).filter((f) => f.endsWith(".js"));

  // Try auth-profiles or model-auth chunks first
  const authChunk = files.find(
    (f) => f.startsWith("auth-profiles") || f.startsWith("model-auth"),
  );
  if (authChunk) {
    const content = readText(`${distDir}/${authChunk}`);
    if (content.includes("resolveApiKeyForProvider") && PATCH_MARKERS.some((m) => content.includes(m))) {
      return true;
    }
  }

  // Fallback: search all JS files
  for (const file of files) {
    const content = readText(`${distDir}/${file}`);
    if (content.includes("resolveApiKeyForProvider") && PATCH_MARKERS.some((m) => content.includes(m))) {
      return true;
    }
  }

  return false;
}
