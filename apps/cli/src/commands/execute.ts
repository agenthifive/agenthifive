import { Command } from "commander";
import type { ExecuteModelBOptions } from "@agenthifive/sdk";
import { createClient, handleError } from "../client.js";

export const executeCommand = new Command("execute")
  .description("Execute a Model A or Model B request")
  .requiredOption("-c, --connection <id>", "Connection ID")
  .option("-m, --model <model>", "Execution model: A (token vending) or B (brokered proxy)", "B")
  .option("--method <method>", "HTTP method for Model B (GET, POST, PUT, DELETE, PATCH)", "GET")
  .option("--url <url>", "Target URL for Model B")
  .option("--body <json>", "Request body as JSON for Model B")
  .option("--headers <json>", "Request headers as JSON for Model B")
  .option("--query <json>", "Query parameters as JSON for Model B")
  .action(async (opts: {
    connection: string;
    model: string;
    method?: string;
    url?: string;
    body?: string;
    headers?: string;
    query?: string;
  }) => {
    try {
      const client = createClient();
      const model = opts.model.toUpperCase();

      if (model === "A") {
        const result = await client.execute({ model: "A", connectionId: opts.connection });
        if ("accessToken" in result) {
          console.log(`Access token vended (Model A):`);
          console.log(`  Token:     ${result.accessToken}`);
          console.log(`  Type:      ${result.tokenType}`);
          console.log(`  Expires:   ${result.expiresIn}s`);
          console.log(`  Audit ID:  ${result.auditId}`);
        } else if ("approvalRequired" in result) {
          console.log(`Step-up approval required.`);
          console.log(`  Approval ID: ${result.approvalRequestId}`);
          console.log(`  Audit ID:    ${result.auditId}`);
        }
        return;
      }

      if (model === "B") {
        if (!opts.url) {
          console.error("Error: --url is required for Model B execution.");
          process.exit(1);
        }

        const method = (opts.method?.toUpperCase() ?? "GET") as "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
        let body: unknown;
        let headers: Record<string, string> | undefined;
        let query: Record<string, string> | undefined;

        if (opts.body) {
          try {
            body = JSON.parse(opts.body) as unknown;
          } catch {
            console.error("Error: --body must be valid JSON.");
            process.exit(1);
          }
        }

        if (opts.headers) {
          try {
            headers = JSON.parse(opts.headers) as Record<string, string>;
          } catch {
            console.error("Error: --headers must be valid JSON.");
            process.exit(1);
          }
        }

        if (opts.query) {
          try {
            query = JSON.parse(opts.query) as Record<string, string>;
          } catch {
            console.error("Error: --query must be valid JSON.");
            process.exit(1);
          }
        }

        const execOpts: ExecuteModelBOptions & { model: "B" } = {
          model: "B",
          connectionId: opts.connection,
          method,
          url: opts.url,
        };
        if (body !== undefined) execOpts.body = body;
        if (headers) execOpts.headers = headers;
        if (query) execOpts.query = query;

        const result = await client.execute(execOpts);

        if ("approvalRequired" in result) {
          console.log(`Step-up approval required.`);
          console.log(`  Approval ID: ${result.approvalRequestId}`);
          console.log(`  Audit ID:    ${result.auditId}`);
          return;
        }

        if ("status" in result && "body" in result) {
          console.log(`Model B execution result:`);
          console.log(`  Status:   ${result.status}`);
          console.log(`  Audit ID: ${result.auditId}`);
          console.log(`  Body:`);
          console.log(JSON.stringify(result.body, null, 2));
        }
        return;
      }

      console.error(`Error: Unknown model "${opts.model}". Use A or B.`);
      process.exit(1);
    } catch (err) {
      handleError(err);
    }
  });
