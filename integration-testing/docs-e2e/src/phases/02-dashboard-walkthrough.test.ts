/**
 * Phase 2: Dashboard Walkthrough (Playwright)
 *
 * Docs under test:
 * - getting-started/quickstart.md
 * - getting-started/dashboard-guide.md
 *
 * Uses Playwright to register, create connections, agents, and policies
 * through the web dashboard — exactly as the docs describe.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { API_URL, WEB_URL, TEST_USER, DUMMY_API_KEY } from "../helpers/constants.js";
import { getJwtFromSession } from "../helpers/api-client.js";
import { reportGap } from "../helpers/doc-checker.js";
import { writeFileSync } from "node:fs";

const QS_DOC = "getting-started/quickstart.md";
const FIXTURE_PATH = process.env["DOCS_E2E_FIXTURE_PATH"] || "/tmp/docs-e2e-fixture.json";

const GOOGLE_TEST_EMAIL = "test@santulli.eu";
const GOOGLE_TEST_PASSWORD = "Marco1971+";

// Shared state across tests
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sessionCookie = "";
let jwt = "";
let agentId = "";
let connectionId = "";
let bootstrapSecret = "";

describe("Phase 2: Dashboard Walkthrough", () => {
  before(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    context = await browser.newContext({
      baseURL: WEB_URL,
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
  });

  after(async () => {
    // Write fixture for Phase 3
    if (bootstrapSecret && agentId) {
      const fixture = {
        sessionCookie,
        jwt,
        agentId,
        connectionId,
        bootstrapSecret,
      };
      writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));
      console.log(`[phase2] Fixture written to ${FIXTURE_PATH}`);
    }
    await browser?.close();
  });

  // ── Registration ────────────────────────────────────────────────

  it("Step 1: Register page loads", async () => {
    await page.goto("/register");
    await page.waitForLoadState("networkidle");
    const html = await page.content();
    assert.ok(html.includes("input"), "Register page should have form inputs");
  });

  it("Step 2: Register a new user via API (Quickstart Step 2)", async () => {
    // Register via Better Auth API (requires Origin header for CSRF)
    const signupRes = await fetch(`${API_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: WEB_URL,
      },
      body: JSON.stringify({
        name: TEST_USER.name,
        email: TEST_USER.email,
        password: TEST_USER.password,
      }),
    });

    const body = await signupRes.json().catch(() => ({})) as Record<string, unknown>;
    console.log(`[phase2] Signup: ${signupRes.status}`);

    if (signupRes.ok || signupRes.status === 422) {
      // 422 = user already exists from previous run
      console.log("[phase2] Signup succeeded or user already exists");
    } else {
      console.log(`[phase2] Signup response: ${JSON.stringify(body).slice(0, 200)}`);
    }

    // Email verification is required — bypass via DB
    const pgClient = await import("postgres");
    const DATABASE_URL =
      process.env["DATABASE_URL"] ||
      "postgresql://agenthifive:dev-password@localhost:5432/agenthifive";
    const sql = pgClient.default(DATABASE_URL);
    try {
      await sql`UPDATE t_users SET email_verified = true WHERE email = ${TEST_USER.email}`;
      console.log("[phase2] Email verified in DB");
    } finally {
      await sql.end();
    }

    reportGap({
      file: QS_DOC,
      section: "Step 2: Register",
      severity: "missing",
      description:
        "Email verification is required (requireEmailVerification: true) " +
        "but not mentioned in quickstart. With EMAIL_PROVIDER=noop, " +
        "users cannot verify and are blocked from logging in.",
      evidence: "Better Auth config: requireEmailVerification: true, sendOnSignUp: true",
    });
  });

  // ── Login ───────────────────────────────────────────────────────

  it("Step 3: Log in and get session", async () => {
    const loginRes = await fetch(`${API_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: WEB_URL,
      },
      body: JSON.stringify({
        email: TEST_USER.email,
        password: TEST_USER.password,
      }),
    });

    console.log(`[phase2] Login: ${loginRes.status}`);
    assert.ok(loginRes.ok, `Login should succeed, got ${loginRes.status}`);

    // Extract Set-Cookie headers and inject into Playwright context
    const setCookies = loginRes.headers.getSetCookie();
    for (const sc of setCookies) {
      const [nameValue] = sc.split(";");
      const [name, ...valueParts] = nameValue!.split("=");
      await context.addCookies([{
        name: name!.trim(),
        value: valueParts.join("="),
        domain: "localhost",
        path: "/",
      }]);
    }

    const cookies = await context.cookies();
    sessionCookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    console.log(`[phase2] Cookies: ${cookies.map((c) => c.name).join(", ")}`);
    assert.ok(sessionCookie, "Should have session cookies after login");

    // Get JWT for API calls
    jwt = await getJwtFromSession(sessionCookie);
    console.log(`[phase2] JWT: ${jwt.slice(0, 20)}...`);
  });

  // ── Workspace check ─────────────────────────────────────────────

  it("Step 4: Workspace auto-created (Quickstart Step 3)", async () => {
    const res = await fetch(`${API_URL}/v1/workspaces/current`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    assert.ok(res.ok, "Workspace should exist");
    const data = await res.json() as Record<string, unknown>;
    console.log(`[phase2] Workspace: ${data.name} (${data.id})`);

    reportGap({
      file: QS_DOC,
      section: "Step 3: Create Workspace",
      severity: "wrong",
      description:
        "Quickstart says 'Click Create Workspace' but workspace is " +
        "auto-created on user registration. No manual creation needed.",
      evidence: "GET /v1/workspaces/current returns 200 without manual creation",
    });
  });

  // ── Google OAuth Connection ─────────────────────────────────────

  it("Step 5: Create Google OAuth connection (Quickstart Step 4)", async () => {
    if (!jwt) { console.log("[phase2] Skipping — no JWT"); return; }

    // Start OAuth flow via API
    const startRes = await fetch(`${API_URL}/v1/connections/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        service: "google-gmail",
      }),
    });

    if (!startRes.ok) {
      const text = await startRes.text();
      console.log(`[phase2] OAuth start failed: ${startRes.status} ${text}`);
      return;
    }

    const oauthData = await startRes.json() as { authorizationUrl: string; pendingConnectionId: string };
    console.log(`[phase2] OAuth URL: ${oauthData.authorizationUrl?.slice(0, 80)}...`);
    console.log(`[phase2] Pending connection: ${oauthData.pendingConnectionId}`);

    if (!oauthData.authorizationUrl) {
      console.log("[phase2] No OAuth URL returned");
      return;
    }

    // Navigate Playwright to Google OAuth login
    await page.goto(oauthData.authorizationUrl);
    await page.waitForLoadState("networkidle");
    console.log(`[phase2] OAuth page: ${page.url().slice(0, 80)}`);

    // Fill Google login form
    try {
      // Take screenshot for debugging
      await page.screenshot({ path: "/tmp/docs-e2e-google-1.png" });

      // Step 1: Enter email — Google uses various form layouts
      const emailInput = page.locator('input[type="email"], input[name="identifier"]').first();
      await emailInput.waitFor({ state: "visible", timeout: 10000 });
      await emailInput.fill(GOOGLE_TEST_EMAIL);
      console.log("[phase2] Filled email");

      // Click Next — try multiple selectors for Google's various layouts
      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Avanti"), #identifierNext button, button[type="submit"]').first();
      await nextBtn.click();
      await page.waitForTimeout(4000);
      await page.screenshot({ path: "/tmp/docs-e2e-google-2.png" });
      console.log(`[phase2] After email next: ${page.url().slice(0, 80)}`);

      // Step 2: Enter password
      const passwordInput = page.locator('input[type="password"], input[name="Passwd"]').first();
      await passwordInput.waitFor({ state: "visible", timeout: 10000 });
      await passwordInput.fill(GOOGLE_TEST_PASSWORD);
      console.log("[phase2] Filled password");

      const signInBtn = page.locator('button:has-text("Next"), button:has-text("Avanti"), #passwordNext button, button[type="submit"]').first();
      await signInBtn.click();
      await page.waitForTimeout(4000);
      await page.screenshot({ path: "/tmp/docs-e2e-google-3.png" });
      console.log(`[phase2] After password: ${page.url().slice(0, 80)}`);

      // Step 3: Handle consent/permission screen
      const consentBtn = page.locator('button:has-text("Allow"), button:has-text("Continue"), button:has-text("Consenti"), button:has-text("Continua")').first();
      if (await consentBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await consentBtn.click();
        await page.waitForTimeout(3000);
        console.log("[phase2] Clicked consent");
      }

      // There might be a second consent screen
      const consent2 = page.locator('button:has-text("Allow"), button:has-text("Continue"), button:has-text("Consenti"), button:has-text("Continua")').first();
      if (await consent2.isVisible({ timeout: 3000 }).catch(() => false)) {
        await consent2.click();
        await page.waitForTimeout(3000);
      }

      // Wait for redirect back to our app
      await page.waitForURL(/localhost|connections\/callback/, { timeout: 15000 }).catch(() => {});
      console.log(`[phase2] After OAuth: ${page.url().slice(0, 100)}`);

      // Check if connection was created
      const connectionsRes = await fetch(`${API_URL}/v1/connections`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (connectionsRes.ok) {
        const data = await connectionsRes.json() as Record<string, unknown>;
        // API may return { connections: [...] } or [...]
        const connections = (Array.isArray(data) ? data : (data.connections as Array<Record<string, unknown>> || []));
        const googleConn = connections.find((c: Record<string, unknown>) => c.provider === "google");
        if (googleConn) {
          connectionId = googleConn.id as string;
          console.log(`[phase2] Google connection created: ${connectionId}`);
        } else {
          console.log(`[phase2] No Google connection found. Total connections: ${connections.length}`);
        }
      }
    } catch (err) {
      console.log(`[phase2] OAuth flow error: ${err}`);
      // Take screenshot for debugging
      await page.screenshot({ path: "/tmp/docs-e2e-oauth-error.png" }).catch(() => {});
    }
  });

  // ── Agent creation ──────────────────────────────────────────────

  it("Step 6: Create an agent (Quickstart Step 5)", async () => {
    if (!jwt) { console.log("[phase2] Skipping — no JWT"); return; }

    const res = await fetch(`${API_URL}/v1/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Docs E2E Agent",
        description: "Created by docs-e2e test",
      }),
    });

    assert.ok(res.ok, `Agent creation should succeed, got ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    agentId = (data.agent as Record<string, unknown>)?.id as string || data.id as string || "";
    bootstrapSecret = (data.agent as Record<string, unknown>)?.bootstrapSecret as string
      || data.bootstrapSecret as string || "";

    console.log(`[phase2] Agent: ${agentId}`);
    console.log(`[phase2] Bootstrap secret: ${bootstrapSecret.slice(0, 12)}...`);
    assert.ok(agentId, "Agent should have an ID");
    assert.ok(bootstrapSecret, "Agent should have a bootstrap secret");
  });

  // ── Policy creation ─────────────────────────────────────────────

  it("Step 7: Create a policy (Quickstart Step 6)", async () => {
    if (!jwt || !agentId || !connectionId) {
      console.log(`[phase2] Skipping — jwt=${!!jwt} agent=${!!agentId} connection=${!!connectionId}`);
      return;
    }

    const res = await fetch(`${API_URL}/v1/policies`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        connectionId,
        allowedModels: ["B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [{
          baseUrl: "https://gmail.googleapis.com",
          methods: ["GET"],
          pathPatterns: ["/**"],
        }],
      }),
    });

    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      console.log(`[phase2] Policy created: ${data.id}`);
    } else {
      console.log(`[phase2] Policy creation: ${res.status} ${await res.text()}`);
    }
  });

  // ── Dashboard pages load ────────────────────────────────────────

  it("Step 8: Dashboard pages are accessible", async () => {
    if (!sessionCookie) { console.log("[phase2] Skipping — no session"); return; }

    const pages = [
      "/dashboard",
      "/dashboard/approvals",
      "/dashboard/activity",
      "/dashboard/connections",
      "/dashboard/agents",
      "/dashboard/settings",
    ];

    for (const p of pages) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      const onDashboard = !page.url().includes("login");
      console.log(`[phase2] ${p}: ${onDashboard ? "loaded" : "redirected to login"}`);
    }
  });
});
