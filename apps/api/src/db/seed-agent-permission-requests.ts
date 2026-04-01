/**
 * Seed script for agent permission requests.
 * Inserts example permission requests from the OpenClaw agent.
 * Seeds ALL workspaces, so multiple developers each get example data.
 *
 * Usage: tsx src/db/seed-agent-permission-requests.ts
 */

import { db } from "./client";
import { agents, agentPermissionRequests, workspaces, users, notifications } from "./schema";
import { eq } from "drizzle-orm";
import { getActionTemplate } from "@agenthifive/contracts";

async function main() {
  console.log("🌱 Seeding agent permission requests...");

  // Get all existing workspaces
  const allWorkspaces = await db.select().from(workspaces);

  // If no workspaces exist, create demo user and workspace
  if (allWorkspaces.length === 0) {
    console.log("No workspaces found. Creating demo user and workspace...");

    const [user] = await db
      .insert(users)
      .values({
        email: "demo@example.com",
        emailVerified: true,
        name: "Demo User",
      })
      .returning();
    console.log(`✓ Created demo user: ${user.id}`);

    const [workspace] = await db
      .insert(workspaces)
      .values({
        name: `${user.name}'s Workspace`,
        ownerId: user.id,
      })
      .returning();
    console.log(`✓ Created workspace: ${workspace.id}`);

    allWorkspaces.push(workspace);
  } else {
    console.log(`✓ Found ${allWorkspaces.length} existing workspace(s)`);
  }

  // Seed each workspace with OpenClaw agent and permission requests
  for (const workspace of allWorkspaces) {
    console.log(`\n📦 Seeding workspace: ${workspace.id} (${workspace.name})`);

    // Find or create OpenClaw agent for this workspace
    let [openclawAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.name, "OpenClaw"))
      .where(eq(agents.workspaceId, workspace.id))
      .limit(1);

    if (!openclawAgent) {
      console.log(`  Creating OpenClaw agent...`);
      [openclawAgent] = await db
        .insert(agents)
        .values({
          name: "OpenClaw",
          description: "AI assistant that helps you manage your emails, calendar, and tasks",
          workspaceId: workspace.id,
        })
        .returning();
      console.log(`  ✓ Created OpenClaw agent: ${openclawAgent!.id}`);
    } else {
      console.log(`  ✓ Found existing OpenClaw agent: ${openclawAgent.id}`);
    }

    // Clear existing permission requests for this agent
    await db
      .delete(agentPermissionRequests)
      .where(eq(agentPermissionRequests.agentId, openclawAgent!.id));

    // Clear existing permission_request notifications for this workspace
    await db
      .delete(notifications)
      .where(eq(notifications.workspaceId, workspace.id));

    // Insert example permission requests
    const exampleRequests = [
      // Read permissions
      {
        agentId: openclawAgent!.id,
        workspaceId: workspace.id,
        actionTemplateId: "gmail-read",
        reason: "I can help you manage your inbox, find important emails, and suggest replies",
      },
      {
        agentId: openclawAgent!.id,
        workspaceId: workspace.id,
        actionTemplateId: "calendar-read",
        reason: "I can help you schedule meetings, avoid conflicts, and remind you of upcoming events",
      },
      {
        agentId: openclawAgent!.id,
        workspaceId: workspace.id,
        actionTemplateId: "teams-manage",
        reason: "I can monitor your Teams conversations to provide context-aware assistance and summaries",
      },
      {
        agentId: openclawAgent!.id,
        workspaceId: workspace.id,
        actionTemplateId: "drive-read",
        reason: "I can help you search, organize, and find relevant documents in your Drive",
      },
      // Write permissions
      {
        agentId: openclawAgent!.id,
        workspaceId: workspace.id,
        actionTemplateId: "gmail-manage",
        reason: "I can help you send emails, create drafts, and manage your outbox efficiently",
      },
      {
        agentId: openclawAgent!.id,
        workspaceId: workspace.id,
        actionTemplateId: "calendar-manage",
        reason: "I can help you create events, schedule meetings, and manage your calendar on your behalf",
      },
      {
        agentId: openclawAgent!.id,
        workspaceId: workspace.id,
        actionTemplateId: "teams-manage",
        reason: "I can help you send messages, create channels, and collaborate with your team",
      },
      {
        agentId: openclawAgent!.id,
        workspaceId: workspace.id,
        actionTemplateId: "drive-manage",
        reason: "I can help you upload files, create folders, and organize your Drive documents",
      },
    ];

    // Insert permission requests
    const createdRequests = await db
      .insert(agentPermissionRequests)
      .values(exampleRequests)
      .returning({ id: agentPermissionRequests.id, actionTemplateId: agentPermissionRequests.actionTemplateId });

    // Create corresponding notifications
    const notificationValues = createdRequests.map((request) => {
      const template = getActionTemplate(request.actionTemplateId);
      const actionLabel = template?.label ?? request.actionTemplateId;
      return {
        workspaceId: workspace.id,
        type: "permission_request" as const,
        title: "OpenClaw requests access",
        body: `OpenClaw wants to "${actionLabel}". Reason: ${exampleRequests.find((r) => r.actionTemplateId === request.actionTemplateId)?.reason ?? "Access needed"}`,
        linkUrl: "/dashboard/approvals",
        metadata: {
          agentId: openclawAgent!.id,
          actionTemplateId: request.actionTemplateId,
          permissionRequestId: request.id,
        },
      };
    });

    await db.insert(notifications).values(notificationValues);
    console.log(`  ✓ Inserted ${exampleRequests.length} permission requests (4 read + 4 write)`);
    console.log(`  ✓ Created ${notificationValues.length} notifications`);
  }

  console.log("\n✅ Seed complete!");
  console.log(`📊 Seeded ${allWorkspaces.length} workspace(s) total`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
