/**
 * Docs-E2E Test Orchestrator
 *
 * Walks through the AgentHiFive documentation as a new user would,
 * flagging every place where the docs are wrong, unclear, or missing.
 *
 * Phases:
 * 1. Verify self-hosted setup (health checks, endpoints)
 * 2. Dashboard walkthrough via Playwright (register, connect, create agent/policy)
 * 3. Agent developer flow via API (bootstrap, token exchange, vault execute)
 *
 * Produces a documentation gap report at the end.
 */
import { execSync } from "node:child_process";
import { printReport } from "./helpers/doc-checker.js";

const API_URL = process.env["AH5_API_URL"] || "http://localhost:4000";
const WEB_URL = process.env["AH5_WEB_URL"] || "http://localhost:3000";
const FIXTURE_PATH =
  process.env["DOCS_E2E_FIXTURE_PATH"] || "/tmp/docs-e2e-fixture.json";

async function waitForService(
  url: string,
  label: string,
  maxRetries = 30,
  intervalMs = 2000,
): Promise<boolean> {
  console.log(`[docs-e2e] Waiting for ${label} at ${url}...`);
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.status > 0) {
        console.log(`[docs-e2e] ${label} is ready.`);
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.error(`[docs-e2e] ${label} did not become ready after ${maxRetries} retries`);
  return false;
}

function runPhase(phase: string, extraEnv: Record<string, string> = {}): boolean {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Running: ${phase}`);
  console.log(`${"─".repeat(60)}\n`);

  try {
    const thisDir = new URL(".", import.meta.url).pathname;
    const phasePath = `${thisDir}phases/${phase}`;
    // Find tsx from the enterprise-api package which has it as a dependency
    const tsxBin = "/home/dev/agenthifive-enterprise/apps/enterprise-api/node_modules/.bin/tsx";
    execSync(
      [
        tsxBin,
        "--test",
        "--test-concurrency=1",
        "--test-force-exit",
        phasePath,
      ].join(" "),
      {
        stdio: "inherit",
        env: {
          ...process.env,
          AH5_API_URL: API_URL,
          AH5_WEB_URL: WEB_URL,
          DOCS_E2E_FIXTURE_PATH: FIXTURE_PATH,
          NODE_PATH: "/home/dev/agenthifive-enterprise/core/integration-testing/docs-e2e/node_modules",
          ...extraEnv,
        },
        cwd: "/home/dev/agenthifive-enterprise",
        timeout: 120_000,
      },
    );
    return true;
  } catch (error) {
    console.error(`[docs-e2e] Phase ${phase} had failures.`);
    return false;
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  AgentHiFive Docs-E2E: Documentation Walkthrough Test   ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Wait for services
  const apiReady = await waitForService(`${API_URL}/health`, "API");
  if (!apiReady) {
    console.error("[docs-e2e] API is not running. Start with: make up && make dev-api");
    process.exit(1);
  }

  const webReady = await waitForService(WEB_URL, "Web");
  if (!webReady) {
    console.error("[docs-e2e] Web is not running. Start with: make dev");
    process.exit(1);
  }

  let allPassed = true;

  // Phase 1: Self-hosted setup
  if (!runPhase("01-selfhost-setup.test.ts")) {
    allPassed = false;
  }

  // Phase 2: Dashboard walkthrough (Playwright)
  if (!runPhase("02-dashboard-walkthrough.test.ts")) {
    allPassed = false;
  }

  // Phase 3: Agent developer flow
  if (!runPhase("03-agent-developer.test.ts")) {
    allPassed = false;
  }

  // Print documentation gap report
  printReport();

  if (allPassed) {
    console.log("[docs-e2e] All phases completed.");
  } else {
    console.log("[docs-e2e] Some phases had failures.");
  }

  process.exit(allPassed ? 0 : 1);
}

main();
