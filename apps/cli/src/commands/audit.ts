import { Command } from "commander";
import { createClient, handleError } from "../client.js";

export const auditCommand = new Command("audit")
  .description("List recent audit events")
  .option("-a, --agent <id>", "Filter by agent ID")
  .option("-c, --connection <id>", "Filter by connection ID")
  .option("--action <action>", "Filter by action type")
  .option("--from <date>", "Start date (ISO 8601)")
  .option("--to <date>", "End date (ISO 8601)")
  .option("-n, --limit <count>", "Number of events to show", "20")
  .option("--cursor <cursor>", "Pagination cursor")
  .action(async (opts: {
    agent?: string;
    connection?: string;
    action?: string;
    from?: string;
    to?: string;
    limit: string;
    cursor?: string;
  }) => {
    try {
      const client = createClient();
      const listOpts: Record<string, string | number> = {
        limit: parseInt(opts.limit, 10),
      };
      if (opts.agent) listOpts.agentId = opts.agent;
      if (opts.connection) listOpts.connectionId = opts.connection;
      if (opts.action) listOpts.action = opts.action;
      if (opts.from) listOpts.dateFrom = opts.from;
      if (opts.to) listOpts.dateTo = opts.to;
      if (opts.cursor) listOpts.cursor = opts.cursor;
      const result = await client.listAuditEvents(listOpts);

      if (result.events.length === 0) {
        console.log("No audit events found.");
        return;
      }

      console.log();
      for (const event of result.events) {
        console.log(`  [${event.timestamp}] ${event.action} — ${event.decision}`);
        console.log(`    Audit ID:  ${event.auditId}`);
        console.log(`    Actor:     ${event.actor}`);
        if (event.agentId) console.log(`    Agent:     ${event.agentId}`);
        if (event.connectionId) console.log(`    Connection: ${event.connectionId}`);
        if (event.metadata && Object.keys(event.metadata).length > 0) {
          console.log(`    Metadata:  ${JSON.stringify(event.metadata)}`);
        }
        console.log();
      }

      if (result.nextCursor) {
        console.log(`  Next page: ah5 audit --cursor "${result.nextCursor}"`);
      }
    } catch (err) {
      handleError(err);
    }
  });
