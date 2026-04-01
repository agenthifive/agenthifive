import { Command } from "commander";
import { createClient, handleError } from "../client.js";

export const connectCommand = new Command("connect")
  .description("Start OAuth authorization flow for a provider")
  .argument("<provider>", "Provider name: google, microsoft, telegram")
  .option("-l, --label <label>", "Connection label")
  .option("-s, --scopes <scopes>", "Comma-separated scopes")
  .action(async (provider: string, opts: { label?: string; scopes?: string }) => {
    try {
      const client = createClient();
      const scopes = opts.scopes?.split(",").map((s) => s.trim()).filter(Boolean);

      const connectOpts: { label?: string; scopes?: string[] } = {};
      if (opts.label) connectOpts.label = opts.label;
      if (scopes) connectOpts.scopes = scopes;

      const result = await client.connect(
        provider as "google" | "microsoft" | "telegram",
        connectOpts,
      );

      console.log();
      console.log(`  Open this URL to authorize:`);
      console.log(`  ${result.authorizationUrl}`);
      console.log();
      console.log(`Pending connection ID: ${result.pendingConnectionId}`);
      console.log();
      console.log("Complete the OAuth flow in your browser.");
      console.log("The connection will be finalized automatically after authorization.");
    } catch (err) {
      handleError(err);
    }
  });
