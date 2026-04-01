/**
 * Fix policies missing actionTemplateId by inferring from connection service and granted scopes.
 * Usage: tsx src/db/fix-missing-action-template-ids.ts
 */

import { db } from "./client";
import { policies, connections } from "./schema";
import { eq, isNull, and } from "drizzle-orm";

async function main() {
  console.log("🔧 Fixing policies with missing actionTemplateId...");

  // Find all policies without actionTemplateId
  const policiesWithoutTemplate = await db
    .select({
      policyId: policies.id,
      connectionId: policies.connectionId,
      agentId: policies.agentId,
    })
    .from(policies)
    .where(isNull(policies.actionTemplateId));

  console.log(`\nFound ${policiesWithoutTemplate.length} policies without actionTemplateId`);

  if (policiesWithoutTemplate.length === 0) {
    console.log("✓ All policies have actionTemplateId set!");
    process.exit(0);
  }

  // For each policy, infer actionTemplateId from connection
  for (const policy of policiesWithoutTemplate) {
    const [connection] = await db
      .select({
        service: connections.service,
        grantedScopes: connections.grantedScopes,
      })
      .from(connections)
      .where(eq(connections.id, policy.connectionId))
      .limit(1);

    if (!connection) {
      console.log(`  ⚠️  Policy ${policy.policyId}: connection not found`);
      continue;
    }

    // Infer actionTemplateId from service and scopes
    let actionTemplateId: string | null = null;

    if (connection.service === "google-gmail") {
      // Check if scopes include write/send
      const hasWrite = connection.grantedScopes.some(scope =>
        scope.includes("send") || scope.includes("compose") || scope.includes("modify")
      );
      actionTemplateId = hasWrite ? "gmail-manage" : "gmail-read";
    } else if (connection.service === "google-calendar") {
      const hasWrite = connection.grantedScopes.some(scope =>
        scope.includes("events") && !scope.includes("readonly")
      );
      actionTemplateId = hasWrite ? "calendar-manage" : "calendar-read";
    } else if (connection.service === "google-drive") {
      const hasWrite = connection.grantedScopes.some(scope =>
        scope.includes("file") && !scope.includes("readonly")
      );
      actionTemplateId = hasWrite ? "drive-manage" : "drive-read";
    } else if (connection.service === "microsoft-teams") {
      const hasWrite = connection.grantedScopes.some(scope =>
        scope.toLowerCase().includes("readwrite")
      );
      actionTemplateId = hasWrite ? "teams-manage" : "teams-read";
    }

    if (actionTemplateId) {
      await db
        .update(policies)
        .set({ actionTemplateId })
        .where(eq(policies.id, policy.policyId));

      console.log(`  ✓ Policy ${policy.policyId}: set actionTemplateId to "${actionTemplateId}"`);
    } else {
      console.log(`  ⚠️  Policy ${policy.policyId}: could not infer actionTemplateId for service "${connection.service}"`);
    }
  }

  console.log("\n✅ Done!");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fix failed:", err);
  process.exit(1);
});
