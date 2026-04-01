import { Command } from "commander";
import { loadConfig, saveConfig, getWebUrl } from "../config.js";

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface TokenPollResponse {
  token: string;
  expiresAt: string;
}

export const loginCommand = new Command("login")
  .description("Authenticate via device code flow and store credentials")
  .option("--api-url <url>", "AgentHiFive API URL")
  .option("--web-url <url>", "AgentHiFive Web URL")
  .option("--api-key <key>", "Set API key directly (skip device flow)")
  .action(async (opts: { apiUrl?: string; webUrl?: string; apiKey?: string }) => {
    const config = loadConfig();

    if (opts.apiUrl) config.apiUrl = opts.apiUrl;
    if (opts.webUrl) config.webUrl = opts.webUrl;

    // Direct API key mode — skip device flow
    if (opts.apiKey) {
      config.apiKey = opts.apiKey;
      saveConfig(config);
      console.log("API key saved. You are now authenticated.");
      return;
    }

    const webUrl = opts.webUrl ?? getWebUrl();

    // Start device code flow
    console.log("Starting device code authentication...");

    let deviceResp: DeviceCodeResponse;
    try {
      const res = await fetch(`${webUrl}/api/auth/device-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Failed to start device code flow: ${res.status} ${text}`);
        process.exit(1);
      }
      deviceResp = (await res.json()) as DeviceCodeResponse;
    } catch (err) {
      console.error(`Could not reach ${webUrl}. Is the web app running?`);
      if (err instanceof Error) console.error(`  ${err.message}`);
      process.exit(1);
    }

    console.log();
    console.log(`  Open this URL in your browser:`);
    console.log(`  ${deviceResp.verificationUri}`);
    console.log();
    console.log(`  Enter code: ${deviceResp.userCode}`);
    console.log();
    console.log("Waiting for authorization...");

    // Poll for token
    const intervalMs = (deviceResp.interval || 5) * 1000;
    const expiresAt = Date.now() + deviceResp.expiresIn * 1000;

    while (Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      try {
        const res = await fetch(`${webUrl}/api/auth/device-code/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: deviceResp.deviceCode }),
        });

        if (res.status === 200) {
          const data = (await res.json()) as TokenPollResponse;
          config.apiKey = data.token;
          saveConfig(config);
          console.log("Authentication successful! Credentials saved.");
          return;
        }

        if (res.status === 202) {
          // Still pending, continue polling
          continue;
        }

        if (res.status === 403) {
          console.error("Authorization denied by user.");
          process.exit(1);
        }

        if (res.status === 410) {
          console.error("Device code expired. Please try again.");
          process.exit(1);
        }

        // Unexpected status
        const text = await res.text().catch(() => "");
        console.error(`Unexpected response: ${res.status} ${text}`);
        process.exit(1);
      } catch (err) {
        if (err instanceof Error) console.error(`Polling error: ${err.message}`);
        // Continue polling on network errors
      }
    }

    console.error("Device code expired. Please try again.");
    process.exit(1);
  });
