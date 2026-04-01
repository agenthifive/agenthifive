#!/usr/bin/env node
/**
 * Documentation screenshot capture — connects to your running Chrome.
 *
 * SETUP (one time):
 *   cd apps/docs/screenshots
 *   npm init -y && npm install puppeteer-core
 *
 * USAGE:
 *   1. Launch a dedicated Chrome:
 *      "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\temp\chrome-screenshots"
 *   2. Log into https://app-integration.agenthifive.com in that Chrome
 *   3. Run:  node capture.mjs
 *
 *   Custom base URL:  node capture.mjs --base-url=http://localhost:3000
 *   Custom zoom:      node capture.mjs --zoom=0.8
 *   Skip wizard:      node capture.mjs --skip-wizard
 *
 * FLOW:
 *   The script first checks if you're on the onboarding wizard (fresh account).
 *   If so, it walks through each wizard step — capturing screenshots along the
 *   way — then lands on the dashboard for the remaining captures.
 *   If the wizard is already completed, it goes straight to dashboard captures.
 */

import puppeteer from "puppeteer-core";
import { resolve, dirname, relative } from "path";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL =
  process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ??
  "https://app-integration.agenthifive.com";

const SKIP_WIZARD = process.argv.includes("--skip-wizard");
const CDP_URL = "http://127.0.0.1:9222";
const OUTPUT_DIR = resolve(__dirname, "../static/img/getting-started");
const DEBUG_DIR = resolve(__dirname, "debug");
const VIEWPORT = { width: 1280, height: 800 };
const CSS_ZOOM =
  parseFloat(
    process.argv.find((a) => a.startsWith("--zoom="))?.split("=")[1] ?? ""
  ) || 0.60;

// Dev API key for completing wizard Step 1 (Claude / Anthropic)
const LLM_API_KEY =
  process.argv.find((a) => a.startsWith("--api-key="))?.split("=")[1] ??
  "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";

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Apply CSS zoom-out so the full UI fits within the viewport. */
async function applyZoom(page) {
  await page.evaluate((zoom) => {
    document.body.style.zoom = `${zoom}`;
  }, CSS_ZOOM);
  await sleep(500); // let layout reflow
}

/** Click an element by matching text content, retrying until found. */
async function clickByText(page, textMatch, { timeout = 10000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate((text) => {
      const els = [
        ...document.querySelectorAll(
          "button, a, [role=tab], [role=button]"
        ),
      ];
      const el = els.find((e) => e.textContent.includes(text));
      if (el) {
        el.click();
        return true;
      }
      return false;
    }, textMatch);
    if (clicked) return;
    await sleep(500);
  }
  throw new Error(`"${textMatch}" not found after ${timeout}ms`);
}

/** Wait for text to appear on page. */
async function waitForText(page, text, timeout = 15000) {
  await page.waitForFunction(
    (t) => document.body.innerText.includes(t),
    { timeout },
    text
  );
}

/** Take a screenshot and log it. */
async function capture(page, name, description) {
  const outPath = resolve(OUTPUT_DIR, `${name}.jpg`);
  await page.screenshot({ path: outPath, type: "jpeg", quality: 90 });
  console.log(`   ✅ ${name} — ${description}`);
  return outPath;
}

/** Save a debug screenshot on failure. */
async function debugCapture(page, name) {
  const debugPath = resolve(DEBUG_DIR, `${name}-FAILED.jpg`);
  try {
    await page.screenshot({ path: debugPath, type: "jpeg", quality: 90 });
    console.log(`              debug: ${relative(process.cwd(), debugPath)}`);
  } catch {
    // page might be dead
  }
}

/** Navigate, wait for React hydration, and apply zoom. */
async function navigateTo(page, urlPath) {
  await page.goto(`${BASE_URL}${urlPath}`, {
    waitUntil: "networkidle2",
    timeout: 20000,
  });
  await sleep(2000); // React hydration
  await applyZoom(page); // zoom out immediately on every navigation
}

/** Check if page is on the login/auth screen (not authenticated). */
async function isOnLoginPage(page) {
  const url = page.url();
  const pageText = await page.evaluate(() => document.body.innerText);
  return (
    url.includes("/sign-in") ||
    url.includes("/login") ||
    url.includes("/auth") ||
    (pageText.includes("Sign in") &&
      pageText.includes("password") &&
      !pageText.includes("Agent"))
  );
}

/** Check if page landed on the wizard (setup). */
async function isOnWizard(page) {
  const url = page.url();
  const pageText = await page.evaluate(() => document.body.innerText);
  return (
    url.includes("/setup") ||
    pageText.includes("Which AI should OpenClaw think with") ||
    pageText.includes("What you can connect")
  );
}

// ── Wizard flow ─────────────────────────────────────────────────────────────

async function runWizard(page) {
  console.log("\n   === Wizard Flow ===\n");

  // ── Step 1: LLM provider selection ──────────────────────────────────────

  // Make sure we're on the setup page
  await navigateTo(page, "/dashboard/setup");
  await waitForText(page, "Which AI should OpenClaw think with", 15000);
  await sleep(1000);

  // Screenshot: Step 1 — initial state (before selecting provider)
  await capture(page, "wizard-step1-llm", "Wizard Step 1 — LLM provider selection");

  // Select Claude (Anthropic) provider
  console.log("   ... selecting Claude provider");
  await clickByText(page, "Claude");
  await sleep(800);

  // Wait for the credential input to appear
  await page.waitForSelector("#credential", { timeout: 5000 });

  // Type the API key
  console.log("   ... entering API key");
  await page.type("#credential", LLM_API_KEY, { delay: 10 });
  await sleep(500);

  // Screenshot: Step 1 — filled state (provider selected + key entered)
  await capture(
    page,
    "wizard-step1-filled",
    "Wizard Step 1 — Claude selected with API key"
  );

  // Click "Continue" to submit
  console.log("   ... clicking Continue");
  await clickByText(page, "Continue");

  // Wait for Step 2 to appear (the API call + transition)
  await waitForText(page, "What you can connect", 20000);
  await sleep(1500);

  // ── Step 2: Browse integrations ─────────────────────────────────────────

  // Screenshot: Step 2 — integrations overview
  await capture(
    page,
    "wizard-step2-accounts",
    "Wizard Step 2 — Available integrations"
  );

  // Click "Finish setup →" to advance to Step 3
  console.log("   ... clicking Finish setup");
  await clickByText(page, "Finish setup");
  await sleep(2000);

  // ── Step 3: Enrollment key (completion) ─────────────────────────────────
  // NOTE: The completion screen only renders if bootstrapSecret exists
  // (i.e., the agent was freshly created in this session). If the agent
  // already existed, the card will be empty. Handle both cases.

  const hasCompletionScreen = await page.evaluate(() =>
    document.body.innerText.includes("ready")
  );

  if (hasCompletionScreen) {
    await sleep(1000);
    await capture(
      page,
      "wizard-step3-complete",
      "Wizard Step 3 — Enrollment key / You're ready!"
    );

    // Click "Go to Dashboard →" to reach the main dashboard
    console.log("   ... clicking Go to Dashboard");
    await clickByText(page, "Go to Dashboard");
    await sleep(2000);
  } else {
    console.log(
      "   ⚠️  No completion screen (agent already existed, no bootstrap secret)."
    );
    console.log(
      "   ⚠️  Skipping wizard-step3-complete screenshot. Clicking Skip setup."
    );
    await clickByText(page, "Skip setup");
    await sleep(2000);
  }

  console.log("\n   === Wizard Complete ===\n");
}

// ── Dashboard screenshot definitions ────────────────────────────────────────

const DASHBOARD_SCREENS = [
  {
    name: "dashboard-agents",
    url: "/dashboard/my-agents/",
    description: "Main dashboard — agents and connected apps",
  },
  {
    name: "approvals",
    url: "/dashboard/approvals/",
    description: "Agent data access requests",
  },
  {
    name: "add-connection-llm",
    url: "/dashboard/my-agents/",
    description: "Add Connection modal — LLM Access tab",
    prep: async (page) => {
      await clickByText(page, "Connect app");
      await waitForText(page, "LLM Access");
      await sleep(1000);
    },
  },
  {
    name: "add-connection-chat",
    url: "/dashboard/my-agents/",
    description: "Add Connection modal — Chat tab",
    prep: async (page) => {
      await clickByText(page, "Connect app");
      await waitForText(page, "LLM Access");
      await sleep(800);
      await clickByText(page, "Chat with OpenClaw");
      await sleep(1000);
    },
  },
  {
    name: "add-connection-accounts",
    url: "/dashboard/my-agents/",
    description: "Add Connection modal — Accounts tab",
    prep: async (page) => {
      await clickByText(page, "Connect app");
      await waitForText(page, "LLM Access");
      await sleep(800);
      await clickByText(page, "Accounts OpenClaw can access");
      await sleep(1000);
    },
  },
  {
    name: "connection-policy-tiers",
    url: "/dashboard/my-agents/",
    description: "Connection settings — policy protection tiers",
    prep: async (page) => {
      await clickByText(page, "Settings");
      await waitForText(page, "Edit Policy");
      await sleep(800);
      // Scroll modal so all 3 tiers are visible
      await page.evaluate(() => {
        const modal = document.querySelector(
          '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="sheet"], [class*="Sheet"], [class*="drawer"]'
        );
        if (modal) modal.scrollTo(0, modal.scrollHeight);
      });
      await sleep(800);
    },
  },
  {
    name: "advanced-agents",
    url: "/dashboard/agents/",
    description: "Advanced — Agent management",
  },
  {
    name: "advanced-connections",
    url: "/dashboard/connections/",
    description: "Advanced — Connection management",
  },
  {
    name: "advanced-policies",
    url: "/dashboard/policies/",
    description: "Advanced — Policy management",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n📸 AgentHiFive Doc Screenshot Capture");
  console.log(`   Base URL:    ${BASE_URL}`);
  console.log(`   CDP:         ${CDP_URL}`);
  console.log(`   Output:      ${OUTPUT_DIR}`);
  console.log(`   Zoom:        ${CSS_ZOOM} (use --zoom=0.8 to change)`);
  console.log(`   Wizard:      ${SKIP_WIZARD ? "skip (--skip-wizard)" : "auto-detect"}`);
  console.log(`   Screens:     wizard + ${DASHBOARD_SCREENS.length} dashboard\n`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(DEBUG_DIR, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL });
  } catch (e) {
    console.error(
      "\n❌ Could not connect to Chrome on port 9222.\n\n" +
        "Launch Chrome with:\n" +
        '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ' +
        '--remote-debugging-port=9222 --user-data-dir="C:\\temp\\chrome-screenshots"\n\n' +
        "Then log into the app and re-run this script.\n"
    );
    process.exit(1);
  }

  console.log("   ✅ Connected to Chrome\n");

  // ── Auth check + wizard detection ───────────────────────────────────────
  console.log("   Checking authentication...");
  const checkPage = await browser.newPage();
  let needsWizard = false;

  try {
    await checkPage.setViewport(VIEWPORT);
    await navigateTo(checkPage, "/dashboard/my-agents/");

    if (await isOnLoginPage(checkPage)) {
      const debugPath = resolve(DEBUG_DIR, "auth-check-FAILED.jpg");
      await checkPage.screenshot({ path: debugPath }).catch(() => {});
      console.error(
        "\n   ❌ Not authenticated — please log in to the app in the Chrome window first."
      );
      console.error(
        `   Debug screenshot: ${relative(process.cwd(), debugPath)}\n`
      );
      await checkPage.close();
      browser.disconnect();
      process.exit(1);
    }

    console.log("   ✅ Authenticated");

    // Check if we landed on the wizard instead of the dashboard
    needsWizard = await isOnWizard(checkPage);
    if (needsWizard && !SKIP_WIZARD) {
      console.log("   ℹ️  Wizard detected — will capture wizard steps first");
    } else if (needsWizard && SKIP_WIZARD) {
      console.log("   ℹ️  Wizard detected but --skip-wizard flag set, skipping");
      needsWizard = false;
    } else {
      console.log("   ℹ️  Dashboard loaded — wizard already completed");
    }
  } catch (err) {
    const debugPath = resolve(DEBUG_DIR, "auth-check-FAILED.jpg");
    await checkPage.screenshot({ path: debugPath }).catch(() => {});
    console.error(`\n   ❌ ${err.message}`);
    console.error(
      `   Debug screenshot: ${relative(process.cwd(), debugPath)}\n`
    );
    await checkPage.close();
    browser.disconnect();
    process.exit(1);
  }

  // ── Wizard ──────────────────────────────────────────────────────────────

  if (needsWizard) {
    try {
      await runWizard(checkPage);
    } catch (err) {
      console.error(`\n   ❌ Wizard failed: ${err.message}`);
      await debugCapture(checkPage, "wizard");
      await checkPage.close();
      browser.disconnect();
      process.exit(1);
    }
  }

  await checkPage.close();

  // ── Dashboard captures ──────────────────────────────────────────────────
  console.log("   === Dashboard Screens ===\n");

  let succeeded = 0;
  let failed = 0;

  for (const screen of DASHBOARD_SCREENS) {
    process.stdout.write(`   ${screen.name} ... `);
    const page = await browser.newPage();
    try {
      await page.setViewport(VIEWPORT);
      await navigateTo(page, screen.url);

      if (screen.prep) {
        await screen.prep(page);
      }

      await capture(page, screen.name, screen.description);
      succeeded++;
    } catch (err) {
      console.log(`❌  ${err.message}`);
      await debugCapture(page, screen.name);
      failed++;
    } finally {
      await page.close();
    }
  }

  browser.disconnect();

  console.log(
    `\n   Done: ${succeeded} ✅  ${failed} ❌` +
      (failed > 0
        ? `\n   Check debug screenshots in: ${relative(
            process.cwd(),
            DEBUG_DIR
          )}/`
        : "") +
      `\n   Images saved to: ${OUTPUT_DIR}\n`
  );

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
