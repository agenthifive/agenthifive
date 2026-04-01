import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import {
  findDistChunks,
  applyDistPatch,
  validateOpenClawDir,
  isPatchApplied,
} from "../../dist/auto-patch.js";

// Sample compiled JS matching upstream OpenClaw's dist output
const UPSTREAM_MODEL_AUTH_CHUNK = `import { o as resolveOAuthPath } from "./paths-abc.js";
import { n as DEFAULT_AGENT_ID } from "./session-key-xyz.js";

function ensureAuthProfileStore(agentDir) {
  return {};
}

function resolveApiKeyForProfile(params) {
  return null;
}

function resolveProviderAuthOverride(cfg, provider) {
  return null;
}

function resolveAwsSdkAuthInfo() {
  return { apiKey: "aws", source: "aws-sdk", mode: "aws-sdk" };
}

function resolveAuthProfileOrder(params) {
  return [];
}

function applyLocalNoAuthHeaderOverride(model, auth) {
	return model;
}

async function resolveApiKeyForProvider(params) {
\tconst { provider, cfg, profileId, preferredProfile } = params;
\tconst store = params.store ?? ensureAuthProfileStore(params.agentDir);
\tif (profileId) {
\t\tconst resolved = await resolveApiKeyForProfile({
\t\t\tcfg,
\t\t\tstore,
\t\t\tprofileId,
\t\t\tagentDir: params.agentDir
\t\t});
\t\tif (!resolved) throw new Error('No credentials found.');
\t\treturn { apiKey: resolved.apiKey, profileId, source: "profile:" + profileId, mode: "api-key" };
\t}
\tconst authOverride = resolveProviderAuthOverride(cfg, provider);
\tif (authOverride === "aws-sdk") return resolveAwsSdkAuthInfo();
\treturn { apiKey: "fallback", source: "default", mode: "api-key" };
}

export { resolveApiKeyForProvider };
`;

function createTempOpenClaw(): string {
  const tmpDir = `/tmp/test-openclaw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const distDir = path.join(tmpDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.3.13" }),
  );
  writeFileSync(
    path.join(distDir, "auth-profiles-ABC123.js"),
    UPSTREAM_MODEL_AUTH_CHUNK,
  );
  return tmpDir;
}

describe("auto-patch", () => {
  describe("findDistChunks", () => {
    it("finds auth-profiles-*.js chunk", () => {
      const tmpDir = createTempOpenClaw();
      try {
        const chunks = findDistChunks(path.join(tmpDir, "dist"));
        assert.equal(chunks.length, 1);
        assert.ok(chunks[0]!.includes("auth-profiles-ABC123.js"));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("finds chunk by content when name doesn't match pattern", () => {
      const tmpDir = `/tmp/test-openclaw-fallback-${Date.now()}`;
      const distDir = path.join(tmpDir, "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(path.join(distDir, "bundle-xyz.js"), UPSTREAM_MODEL_AUTH_CHUNK);
      try {
        const chunks = findDistChunks(distDir);
        assert.equal(chunks.length, 1);
        assert.ok(chunks[0]!.includes("bundle-xyz.js"));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("finds multiple chunks with duplicated function", () => {
      const tmpDir = createTempOpenClaw();
      const distDir = path.join(tmpDir, "dist");
      // Simulate bundler duplicating the function into a second chunk
      writeFileSync(path.join(distDir, "gateway-DEF456.js"), UPSTREAM_MODEL_AUTH_CHUNK);
      try {
        const chunks = findDistChunks(distDir);
        assert.equal(chunks.length, 2);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns empty array for empty dist dir", () => {
      const tmpDir = `/tmp/test-openclaw-empty-${Date.now()}`;
      mkdirSync(tmpDir, { recursive: true });
      try {
        const chunks = findDistChunks(tmpDir);
        assert.equal(chunks.length, 0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns empty array for non-existent dir", () => {
      const chunks = findDistChunks("/tmp/nonexistent-" + Date.now());
      assert.equal(chunks.length, 0);
    });
  });

  describe("applyDistPatch", () => {
    it("injects vault resolution code using globalThis", () => {
      const tmpDir = createTempOpenClaw();
      try {
        const result = applyDistPatch(tmpDir);
        assert.equal(result.applied, true);
        assert.equal(result.alreadyPatched, false);

        const patched = readFileSync(
          path.join(tmpDir, "dist", "auth-profiles-ABC123.js"),
          "utf-8",
        );
        // Patch marker
        assert.ok(patched.includes("@agenthifive/agenthifive/runtime"));
        // Version marker
        assert.ok(patched.includes("@ah5-patch-v5"));
        // globalThis runtime bridge (not import-based)
        assert.ok(patched.includes("globalThis.__ah5_runtime"));
        assert.ok(patched.includes("ah5rt.vaultBearerToken"));
        assert.ok(patched.includes("ah5rt?.proxiedProviders?.includes(provider)"));
        assert.ok(patched.includes('"vault:agent-token"'));
        assert.ok(patched.includes('auth?.source === "vault:agent-token"'));
        assert.ok(patched.includes('"x-ah5-session-key"'));
        assert.ok(patched.includes('"x-ah5-approval-id"'));
        assert.ok(patched.includes("approvedLlmApprovals"));
        assert.ok(patched.includes("currentSessionKey"));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("creates backup file", () => {
      const tmpDir = createTempOpenClaw();
      try {
        applyDistPatch(tmpDir);
        assert.ok(
          existsSync(path.join(tmpDir, "dist", "auth-profiles-ABC123.js.bak")),
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("is idempotent (detects already-patched)", () => {
      const tmpDir = createTempOpenClaw();
      try {
        const first = applyDistPatch(tmpDir);
        assert.equal(first.applied, true);
        assert.equal(first.alreadyPatched, false);

        const second = applyDistPatch(tmpDir);
        assert.equal(second.applied, true);
        assert.equal(second.alreadyPatched, true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("patches all chunks in multi-chunk installs", () => {
      const tmpDir = createTempOpenClaw();
      const distDir = path.join(tmpDir, "dist");
      writeFileSync(path.join(distDir, "gateway-DEF456.js"), UPSTREAM_MODEL_AUTH_CHUNK);
      writeFileSync(path.join(distDir, "tui-GHI789.js"), UPSTREAM_MODEL_AUTH_CHUNK);
      try {
        const result = applyDistPatch(tmpDir);
        assert.equal(result.applied, true);
        assert.ok(result.message.includes("3 chunk(s)"));

        // All chunks should be patched
        for (const file of ["auth-profiles-ABC123.js", "gateway-DEF456.js", "tui-GHI789.js"]) {
          const content = readFileSync(path.join(distDir, file), "utf-8");
          assert.ok(content.includes("@ah5-patch-v5"), `${file} should be patched`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("preserves original code after injection point", () => {
      const tmpDir = createTempOpenClaw();
      try {
        applyDistPatch(tmpDir);
        const patched = readFileSync(
          path.join(tmpDir, "dist", "auth-profiles-ABC123.js"),
          "utf-8",
        );
        // Original code should still be present after the injection
        assert.ok(patched.includes("if (profileId)"));
        assert.ok(patched.includes("resolveApiKeyForProfile"));
        assert.ok(patched.includes("resolveProviderAuthOverride"));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails gracefully when function not found at all", () => {
      const tmpDir = `/tmp/test-openclaw-noanchor-${Date.now()}`;
      const distDir = path.join(tmpDir, "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "openclaw" }),
      );
      // File has no resolveApiKeyForProvider at all — findDistChunks returns empty
      writeFileSync(
        path.join(distDir, "some-other-chunk.js"),
        'function someOtherFunction() { return true; }\n',
      );
      try {
        const result = applyDistPatch(tmpDir);
        assert.equal(result.applied, false);
        assert.ok(result.message.includes("Could not find"));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("validateOpenClawDir", () => {
    it("returns null for non-openclaw directory", () => {
      const tmpDir = `/tmp/test-not-openclaw-${Date.now()}`;
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "not-openclaw" }),
      );
      try {
        const result = validateOpenClawDir(tmpDir);
        assert.equal(result, null);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns dist kind for npm install", () => {
      const tmpDir = createTempOpenClaw();
      try {
        const result = validateOpenClawDir(tmpDir);
        assert.ok(result);
        assert.equal(result.kind, "dist");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns source kind when src/ exists", () => {
      const tmpDir = createTempOpenClaw();
      const srcDir = path.join(tmpDir, "src", "agents");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(path.join(srcDir, "model-auth.ts"), "export {}");
      try {
        const result = validateOpenClawDir(tmpDir);
        assert.ok(result);
        assert.equal(result.kind, "source");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("isPatchApplied", () => {
    it("returns false for unpatched install", () => {
      const tmpDir = createTempOpenClaw();
      try {
        assert.equal(isPatchApplied({ dir: tmpDir, kind: "dist" }), false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns true after patching", () => {
      const tmpDir = createTempOpenClaw();
      try {
        applyDistPatch(tmpDir);
        assert.equal(isPatchApplied({ dir: tmpDir, kind: "dist" }), true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
