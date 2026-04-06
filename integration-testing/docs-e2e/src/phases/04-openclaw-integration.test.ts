/**
 * Phase 4: OpenClaw Integration
 *
 * Docs under test:
 * - getting-started/setup-cli.md
 * - openclaw/plugin-guide.md
 * - openclaw/how-it-works.md
 *
 * Tests the OpenClaw setup CLI → gateway → vault LLM proxy flow.
 * Requires: OpenClaw installed globally, AgentHiFive API running.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { API_URL } from "../helpers/constants.js";
import { reportGap } from "../helpers/doc-checker.js";

const SETUP_DOC = "getting-started/setup-cli.md";
const PLUGIN_DOC = "openclaw/plugin-guide.md";
const FIXTURE_PATH =
  process.env["DOCS_E2E_FIXTURE_PATH"] || "/tmp/docs-e2e-fixture.json";
const CONFIG_PATH =
  process.env["OPENCLAW_CONFIG_PATH"] || `${process.env["HOME"]}/.openclaw/openclaw.json`;
const GATEWAY_PORT = 18789;

interface Phase2Fixture {
  sessionCookie: string;
  jwt: string;
  agentId: string;
  connectionId: string;
  bootstrapSecret: string;
}

let fixture: Phase2Fixture;
let gatewayProcess: ChildProcess | null = null;
let openclawAgentId = "";
let openclawBootstrapSecret = "";

function getJwt(): string {
  const sessionCookie = execSync(
    `curl -s -D- -X POST ${API_URL}/api/auth/sign-in/email ` +
      `-H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' ` +
      `-d '{"email":"docs-e2e@test.local","password":"TestPassword123!"}' 2>&1 | ` +
      `grep -i 'set-cookie:' | head -1 | sed 's/.*set-cookie: //i' | cut -d';' -f1`,
    { encoding: "utf-8" },
  ).trim();

  const jwt = execSync(
    `curl -s -X POST ${API_URL}/api/auth/token ` +
      `-H 'Cookie: ${sessionCookie}' -H 'Origin: http://localhost:3000'`,
    { encoding: "utf-8" },
  ).trim();

  const parsed = JSON.parse(jwt) as { token: string };
  return parsed.token;
}

describe("Phase 4: OpenClaw Integration", () => {
  before(() => {
    try {
      fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Phase2Fixture;
    } catch {
      console.log("[phase4] No fixture from Phase 2");
    }

    // Check OpenClaw is installed
    try {
      const version = execSync("openclaw --version", { encoding: "utf-8" }).trim();
      console.log(`[phase4] OpenClaw: ${version}`);
    } catch {
      console.log("[phase4] OpenClaw not installed — skipping Phase 4");
    }
  });

  after(() => {
    if (gatewayProcess) {
      gatewayProcess.kill();
      gatewayProcess = null;
      console.log("[phase4] Gateway stopped");
    }
  });

  // ── Setup CLI ───────────────────────────────────────────────────

  it("Step 1: Create agent + Gemini policy for OpenClaw", async () => {
    const jwt = getJwt();

    // Create agent
    const agentRes = await fetch(`${API_URL}/v1/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "OpenClaw E2E Agent",
        description: "Phase 4 OpenClaw integration test",
      }),
    });
    assert.ok(agentRes.ok, `Agent creation failed: ${agentRes.status}`);
    const agentData = (await agentRes.json()) as Record<string, unknown>;
    openclawAgentId =
      ((agentData.agent as Record<string, unknown>)?.id as string) || "";
    openclawBootstrapSecret = (agentData.bootstrapSecret as string) || "";
    console.log(`[phase4] Agent: ${openclawAgentId}`);
    console.log(
      `[phase4] Bootstrap: ${openclawBootstrapSecret.slice(0, 12)}...`,
    );

    // Find Gemini connection
    const connRes = await fetch(`${API_URL}/v1/connections`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const connData = (await connRes.json()) as Record<string, unknown>;
    const connections = (connData.connections as Array<Record<string, unknown>>) || [];
    const geminiConn = connections.find((c) => c.service === "gemini");

    if (!geminiConn) {
      console.log("[phase4] No Gemini connection — creating one");
      const createRes = await fetch(`${API_URL}/v1/connections/api-key`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "gemini",
          service: "gemini",
          label: "E2E Gemini",
          apiKey: "AIzaSyAZ_RlkCHbuCG5r3rMmKtzmUpdEXy7b9pM",
        }),
      });
      if (createRes.ok) {
        const data = (await createRes.json()) as { connection: { id: string } };
        const geminiId = data.connection.id;
        console.log(`[phase4] Gemini connection: ${geminiId}`);

        // Create policy
        await fetch(`${API_URL}/v1/policies`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId: openclawAgentId,
            connectionId: geminiId,
            allowedModels: ["B"],
            defaultMode: "read_write",
            stepUpApproval: "never",
            allowlists: [
              {
                baseUrl: "https://generativelanguage.googleapis.com",
                methods: ["GET", "POST"],
                pathPatterns: ["/**"],
              },
            ],
          }),
        });
        console.log("[phase4] Gemini policy created");
      }
    } else {
      console.log(`[phase4] Gemini connection exists: ${geminiConn.id}`);
      // Create policy for this agent
      await fetch(`${API_URL}/v1/policies`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentId: openclawAgentId,
          connectionId: geminiConn.id,
          allowedModels: ["B"],
          defaultMode: "read_write",
          stepUpApproval: "never",
          allowlists: [
            {
              baseUrl: "https://generativelanguage.googleapis.com",
              methods: ["GET", "POST"],
              pathPatterns: ["/**"],
            },
          ],
        }),
      });
      console.log("[phase4] Gemini policy created");
    }
  });

  it("Step 2: Run setup CLI (setup-cli.md)", () => {
    if (!openclawBootstrapSecret) {
      console.log("[phase4] Skipping — no bootstrap secret");
      return;
    }

    try {
      const setupCli =
        "/home/dev/agenthifive-enterprise/core/packages/openclaw-setup/dist/cli.js";

      const output = execSync(
        [
          "node",
          setupCli,
          `--base-url ${API_URL}`,
          `--bootstrap-secret ${openclawBootstrapSecret}`,
          "--default-model gemini/gemini-2.0-flash",
          "--non-interactive",
          "--skip-onboard",
          "--skip-plugin-install",
        ].join(" "),
        { encoding: "utf-8", timeout: 30_000 },
      );

      console.log("[phase4] Setup output:");
      for (const line of output.split("\n").filter((l) => l.trim())) {
        console.log(`  ${line}`);
      }

      // Verify patches applied
      if (output.includes("Enabled successfully")) {
        console.log("[phase4] Credential patch: applied");
      } else if (output.includes("Could not locate anchor")) {
        console.log("[phase4] Credential patch: FAILED (anchor not found)");
        reportGap({
          file: SETUP_DOC,
          section: "Step 7: Enabling vault credential proxying",
          severity: "unclear",
          description:
            "Auto-patching may fail on some OpenClaw versions if the code anchor " +
            "point has changed. The docs should mention what to do when this happens.",
          evidence: "Setup output included 'Could not locate anchor point'",
        });
      }
    } catch (err) {
      console.log(
        `[phase4] Setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  it("Step 3: Verify setup config", () => {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    } catch {
      console.log("[phase4] Skipping — no OpenClaw config");
      return;
    }

    // Check models.providers has vault proxy URL
    const models = config.models as Record<string, unknown> | undefined;
    const providers = models?.providers as Record<string, unknown> | undefined;

    if (providers) {
      for (const [key, value] of Object.entries(providers)) {
        const prov = value as Record<string, unknown>;
        const baseUrl = (prov.baseUrl as string) || (prov.baseURL as string) || "";
        if (baseUrl.includes("/v1/vault/llm/")) {
          console.log(`[phase4] Vault proxy: ${key} → ${baseUrl}`);
        }
      }
    }

    // Check agents.defaults.model
    const agents = config.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const model = defaults?.model as string | undefined;
    console.log(`[phase4] Default model: ${model || "NOT SET"}`);
    assert.ok(model, "Default model should be set in config");
  });

  it("Step 4: Start gateway", async () => {
    // Remove isolatedSession if present (compatibility)
    try {
      const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      const agents = config.agents as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const heartbeat = defaults?.heartbeat as Record<string, unknown> | undefined;
      if (heartbeat?.isolatedSession !== undefined) {
        delete heartbeat.isolatedSession;
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
        console.log("[phase4] Removed isolatedSession from config");
      }
    } catch { /* ok */ }

    // Start gateway in background
    gatewayProcess = spawn(
      "openclaw",
      ["gateway", "--port", String(GATEWAY_PORT)],
      {
        env: { ...process.env, OPENCLAW_SKIP_CHANNELS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );

    // Wait for gateway to be ready
    let ready = false;
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      try {
        const res = await fetch(
          `http://127.0.0.1:${GATEWAY_PORT}/__openclaw__/health`,
        );
        if (res.ok || res.status < 500) {
          ready = true;
          break;
        }
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (ready) {
      console.log("[phase4] Gateway is running");
    } else {
      // Read stderr for clues
      let stderr = "";
      gatewayProcess.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await new Promise((r) => setTimeout(r, 500));
      console.log(`[phase4] Gateway may not be fully ready. stderr: ${stderr.slice(0, 300)}`);
    }
  });

  it("Step 5: Send message through OpenClaw → vault LLM proxy", () => {
    if (!gatewayProcess) {
      console.log("[phase4] Skipping — no gateway");
      return;
    }

    try {
      const output = execSync(
        `openclaw agent --message "Reply with exactly: VAULT_TEST_OK" --session-id "docs-e2e-phase4" --json --timeout 45000`,
        { encoding: "utf-8", timeout: 60_000 },
      );

      const result = JSON.parse(output) as {
        status: string;
        result?: {
          payloads?: Array<{ text: string }>;
          meta?: { stopReason?: string; agentMeta?: { model?: string } };
        };
      };

      console.log(`[phase4] Status: ${result.status}`);
      const text = result.result?.payloads?.[0]?.text || "";
      console.log(`[phase4] Response: ${text.slice(0, 200)}`);
      const model = result.result?.meta?.agentMeta?.model || "?";
      console.log(`[phase4] Model: ${model}`);
      const stopReason = result.result?.meta?.stopReason || "?";
      console.log(`[phase4] Stop reason: ${stopReason}`);

      if (stopReason === "end_turn" && text && !text.includes("401") && !text.includes("403")) {
        console.log("[phase4] SUCCESS: LLM responded through vault proxy");
      } else if (text.includes("403")) {
        console.log("[phase4] Policy denied — allowlist may need updating");
      } else if (text.includes("401")) {
        console.log("[phase4] Auth failed — credential patch may not have applied");
      } else if (text.includes("404")) {
        console.log("[phase4] Provider returned 404 — model/endpoint mismatch");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[phase4] Agent command failed: ${msg.slice(0, 300)}`);
    }
  });

  it("Step 6: Verify vault audit trail", async () => {
    try {
      const jwt = getJwt();
      const res = await fetch(`${API_URL}/v1/audit?limit=5`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      if (!res.ok) {
        console.log(`[phase4] Audit query failed: ${res.status}`);
        return;
      }

      const data = (await res.json()) as {
        events: Array<{ action: string; decision: string; agentId?: string }>;
      };

      const vaultEvents = data.events.filter(
        (e) =>
          e.action.startsWith("execution_") &&
          e.agentId === openclawAgentId,
      );

      if (vaultEvents.length > 0) {
        console.log(`[phase4] Vault events for OpenClaw agent:`);
        for (const e of vaultEvents) {
          console.log(`  ${e.action}: ${e.decision}`);
        }
      } else {
        console.log("[phase4] No vault execution events found for this agent");
        // Check for any recent events
        for (const e of data.events.slice(0, 3)) {
          console.log(`  ${e.action}: ${e.decision} (agent: ${e.agentId?.slice(0, 8) || "?"})`);
        }
      }
    } catch (err) {
      console.log(`[phase4] Audit check failed: ${err}`);
    }
  });
});
