/**
 * Shared constants for the docs-e2e test suite.
 */
import { readFileSync } from "node:fs";

export const API_URL = process.env["AH5_API_URL"] || "http://localhost:4000";
export const WEB_URL = process.env["AH5_WEB_URL"] || "http://localhost:3000";
export const DATABASE_URL =
  process.env["DATABASE_URL"] ||
  "postgresql://agenthifive:dev-password@localhost:5432/agenthifive";

export const TEST_USER = {
  name: "Docs E2E User",
  email: "docs-e2e@test.local",
  password: "TestPassword123!",
};

// Fallback to admin user seeded by enterprise API when signup is blocked.
// Read from .env file if env vars not set (test process doesn't load .env automatically).
function loadAdminCreds(): { email: string; password: string } {
  if (process.env["ADMIN_EMAIL"] && process.env["ADMIN_PASSWORD"]) {
    return { email: process.env["ADMIN_EMAIL"], password: process.env["ADMIN_PASSWORD"] };
  }
  try {
    const envContent = readFileSync("/home/dev/agenthifive-enterprise/.env", "utf-8");
    const email = envContent.match(/^ADMIN_EMAIL=(.+)$/m)?.[1]?.trim() || "";
    const password = envContent.match(/^ADMIN_PASSWORD=(.+)$/m)?.[1]?.trim() || "";
    return { email, password };
  } catch {
    return { email: "", password: "" };
  }
}

export const ADMIN_USER = loadAdminCreds();

export const DUMMY_API_KEY = "sk-test-dummy-for-docs-e2e-verification";
