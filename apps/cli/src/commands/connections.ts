import { Command } from "commander";
import { createClient, handleError } from "../client.js";

const listCommand = new Command("list")
  .description("List all connections")
  .action(async () => {
    try {
      const client = createClient();
      const connections = await client.listConnections();

      if (connections.length === 0) {
        console.log("No connections found.");
        return;
      }

      console.log();
      for (const conn of connections) {
        const statusIcon =
          conn.status === "healthy" ? "●" :
          conn.status === "needs_reauth" ? "●" :
          "●";
        const statusLabel =
          conn.status === "healthy" ? "healthy" :
          conn.status === "needs_reauth" ? "needs reauth" :
          "revoked";
        console.log(`  ${statusIcon} ${conn.provider.padEnd(12)} ${conn.label.padEnd(24)} [${statusLabel}]`);
        console.log(`    ID: ${conn.id}`);
        if (conn.grantedScopes.length > 0) {
          console.log(`    Scopes: ${conn.grantedScopes.join(", ")}`);
        }
        console.log(`    Created: ${conn.createdAt}`);
        console.log();
      }
    } catch (err) {
      handleError(err);
    }
  });

const revokeCommand = new Command("revoke")
  .description("Revoke a connection")
  .argument("<id>", "Connection ID to revoke")
  .action(async (id: string) => {
    try {
      const client = createClient();
      const result = await client.revokeConnection(id);

      if (result.revoked) {
        console.log(`Connection ${id} revoked.`);
        console.log(`  Audit ID: ${result.auditId}`);
      }
    } catch (err) {
      handleError(err);
    }
  });

export const connectionsCommand = new Command("connections")
  .description("Manage connections")
  .addCommand(listCommand)
  .addCommand(revokeCommand);
