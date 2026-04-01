import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { workspaces } from "../db/schema/workspaces";

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

const workspaceResponse = {
  type: "object" as const,
  properties: {
    id: { type: "string" as const, format: "uuid" },
    name: { type: "string" as const },
    ownerId: { type: "string" as const },
    createdAt: { type: "string" as const, format: "date-time" },
    updatedAt: { type: "string" as const, format: "date-time" },
  },
};

export default async function workspaceRoutes(fastify: FastifyInstance) {
  // GET /workspaces/current — get the current user's workspace
  fastify.get("/workspaces/current", {
    schema: {
      tags: ["Workspaces"],
      summary: "Get current workspace",
      description: "Returns the workspace for the authenticated user.",
      response: {
        200: workspaceResponse,
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { wid } = request.user;

    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        ownerId: workspaces.ownerId,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, wid))
      .limit(1);

    if (rows.length === 0) {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    return rows[0];
  });

  // PUT /workspaces/current — update the current user's workspace
  fastify.put("/workspaces/current", {
    schema: {
      tags: ["Workspaces"],
      summary: "Update current workspace",
      description: "Updates the name of the authenticated user's workspace. Only the workspace owner can update.",
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, description: "New workspace name" },
        },
      },
      response: {
        200: workspaceResponse,
        400: errorResponse,
        403: errorResponse,
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { wid, sub } = request.user;
    const { name } = request.body as { name?: string };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.code(400).send({ error: "name is required and must be a non-empty string" });
    }

    // Verify the user is the workspace owner
    const rows = await db
      .select({ ownerId: workspaces.ownerId })
      .from(workspaces)
      .where(eq(workspaces.id, wid))
      .limit(1);

    if (rows.length === 0) {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    if (rows[0]!.ownerId !== sub) {
      return reply.code(403).send({ error: "Only the workspace owner can update settings" });
    }

    const updated = await db
      .update(workspaces)
      .set({ name: name.trim(), updatedAt: new Date() })
      .where(eq(workspaces.id, wid))
      .returning({
        id: workspaces.id,
        name: workspaces.name,
        ownerId: workspaces.ownerId,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      });

    return updated[0];
  });
}
