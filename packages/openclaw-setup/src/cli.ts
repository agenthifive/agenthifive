#!/usr/bin/env node

/**
 * AgentHiFive Setup CLI
 *
 * Standalone CLI for managing OpenClaw + AgentHiFive vault integration.
 *
 * Modes:
 *   (interactive menu)  — first-time setup, change LLM, reconnect, or remove
 *   --verify            — check an existing installation (no changes)
 *   --sync              — re-fetch vault connections, update config
 *
 * Usage:
 *   npx @agenthifive/openclaw-setup
 *   npx @agenthifive/openclaw-setup --base-url https://app.agenthifive.com --bootstrap-secret ah5b_...
 *   npx @agenthifive/openclaw-setup --verify [--openclaw-dir /path/to/openclaw]
 *   npx @agenthifive/openclaw-setup --sync
 *   npx @agenthifive/openclaw-setup --mode remove
 */

import { runSetup, parseSetupArgs } from "./setup-wizard.js";
import { runVerify } from "./verify.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`
  AgentHiFive Setup CLI

  Sets up OpenClaw with AgentHiFive vault integration.
  Run without flags for an interactive menu.

  Usage:
    ah5-setup                                      Interactive menu
    ah5-setup --base-url <url> --bootstrap-secret <secret>   First-time setup
    ah5-setup --mode change-model                  Change default LLM model
    ah5-setup --mode reconnect --bootstrap-secret <secret>   Reconnect to vault
    ah5-setup --sync                               Re-fetch connections, update config
    ah5-setup --mode remove                        Remove AgentHiFive cleanly
    ah5-setup --verify                             Check existing installation

  Modes (--mode):
    setup              First-time setup (default when --base-url given)
    change-model       Re-pick default LLM model using existing auth
    reconnect          New bootstrap secret, re-auth, update config
    sync               Re-fetch vault connections, update channels + providers
    remove             Remove channels.agenthifive, then uninstall plugin

  Options:
    --base-url <url>           AgentHiFive API base URL
    --bootstrap-secret <secret> Bootstrap secret from dashboard (ah5b_...)
    --default-model <model>    Default LLM model (e.g., openai/gpt-4.1)
    --config-path <path>       Explicit OpenClaw config file path
    --openclaw-dir <path>      Explicit OpenClaw installation directory
    --non-interactive          Run without prompts
    --skip-onboard             Skip OpenClaw onboard step
    --skip-plugin-install      Skip plugin installation step
    --sync                     Re-fetch vault connections and update config
    --verify                   Check an existing installation (no changes made)
    -h, --help                 Show this help message

  Notes:
    - For vault-managed providers, changing models later from the OpenClaw TUI
      /models picker is fine.
    - Avoid re-running OpenClaw onboard or models auth for those providers,
      because those flows expect local provider keys/tokens.

`);
  process.exit(0);
}

// --verify mode
if (args.includes("--verify")) {
  // Extract --openclaw-dir if provided
  let openclawDir: string | undefined;
  const dirIdx = args.indexOf("--openclaw-dir");
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    openclawDir = args[dirIdx + 1];
  }

  runVerify(openclawDir).then((ok) => {
    process.exit(ok ? 0 : 1);
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n  ERROR: ${message}\n\n`);
    process.exit(1);
  });
} else if (args.includes("--sync")) {
  // --sync shortcut: same as --mode sync
  const opts = parseSetupArgs(args);
  opts.mode = "sync";

  runSetup(opts).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n  ERROR: ${message}\n\n`);
    process.exit(1);
  });
} else {
  // Setup / change-model / reconnect
  const opts = parseSetupArgs(args);

  runSetup(opts).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n  ERROR: ${message}\n\n`);
    process.exit(1);
  });
}
