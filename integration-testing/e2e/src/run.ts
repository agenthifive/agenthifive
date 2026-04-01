/**
 * E2E Agent Auth Test Orchestrator
 *
 * Phases:
 * 1. Wait for the AH5 API to be healthy
 * 2. Push database schema (drizzle-kit push)
 * 3. Seed the database (workspace, agent, connections, policies)
 * 4. Bootstrap the agent and obtain an access token
 * 5. Write shared fixture file for test scenarios to read
 * 6. Run all test scenario files via node --test child process
 *
 * Exit code: 0 if all tests pass, 1 if any fail.
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { seedDatabase } from "./helpers/seed-db.js";
import { bootstrapAndAuthenticate } from "./helpers/agent-auth.js";
import type { E2EFixture } from "./helpers/fixture.js";

const AH5_API_URL = process.env["AH5_API_URL"] || "http://api:4000";
const FIXTURE_PATH = "/tmp/e2e-fixture.json";

// ── Phase 1: Wait for API ─────────────────────────────────────────

async function waitForApi(maxRetries = 30, intervalMs = 2000): Promise<void> {
  console.log(`[e2e] Waiting for AH5 API at ${AH5_API_URL}...`);
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${AH5_API_URL}/health`);
      if (response.ok) {
        console.log("[e2e] API is healthy.");
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`API at ${AH5_API_URL} did not become healthy after ${maxRetries} retries`);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  try {
    // Phase 1: Wait for API
    await waitForApi();

    // Phase 2: Push schema to database (drizzle-kit push)
    console.log("[e2e] Phase 2: Pushing database schema...");
    execSync("npx drizzle-kit push --force", {
      stdio: "inherit",
      cwd: "/app/apps/api",
      env: { ...process.env },
    });

    // Phase 3: Seed database
    console.log("[e2e] Phase 3: Seeding database...");
    const seed = await seedDatabase();
    console.log(`[e2e]   workspace=${seed.workspaceId}`);
    console.log(`[e2e]   agent=${seed.agentId}`);

    // Phase 4: Bootstrap agent
    console.log("[e2e] Phase 4: Bootstrapping agent and exchanging token...");
    const creds = await bootstrapAndAuthenticate(seed.bootstrapSecret);
    console.log(`[e2e]   token=${creds.accessToken.slice(0, 12)}...`);

    // Phase 5: Write fixture for test scenarios
    const fixture: E2EFixture = {
      seed,
      creds: {
        agentId: creds.agentId,
        workspaceId: creds.workspaceId,
        accessToken: creds.accessToken,
        privateKey: creds.privateKey,
        publicKey: creds.publicKey,
      },
    };
    writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
    console.log(`[e2e] Phase 5: Fixture written to ${FIXTURE_PATH}`);

    // Phase 6: Run test scenarios via node --test
    console.log("[e2e] Phase 6: Running test scenarios...\n");
    execSync(
      [
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-force-exit",
        "integration-testing/e2e/src/scenarios/*.test.ts",
      ].join(" "),
      {
        stdio: "inherit",
        env: {
          ...process.env,
          E2E_FIXTURE_PATH: FIXTURE_PATH,
        },
        cwd: "/app",
      },
    );

    console.log("\n[e2e] All tests passed!");
    process.exit(0);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) {
      // execSync throws with exit code on test failure
      console.error("\n[e2e] Some tests failed.");
      process.exit(1);
    }
    console.error("[e2e] Fatal error:", error);
    process.exit(1);
  }
}

main();
