import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { personalAccessTokens } from "../db/schema/personal-access-tokens";

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

const tokenProperties = {
  id: { type: "string" as const, format: "uuid" },
  name: { type: "string" as const },
  expiresAt: { type: "string" as const, format: "date-time" },
  lastUsedAt: { type: "string" as const, format: "date-time", nullable: true },
  createdAt: { type: "string" as const, format: "date-time" },
  isExpired: { type: "boolean" as const },
};

export default async function tokenRoutes(fastify: FastifyInstance) {
  /**
   * POST /tokens
   * Creates a personal access token. The plain token is returned once and cannot be retrieved later.
   */
  fastify.post("/tokens", {
    schema: {
      tags: ["Tokens"],
      summary: "Create personal access token",
      description:
        "Generates a new PAT for API authentication via the X-API-Key header. " +
        "The token value is returned once and cannot be retrieved later.",
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100, description: "Token label (e.g. 'CI/CD Pipeline')" },
          expiresInDays: { type: "integer", minimum: 1, maximum: 90, default: 30, description: "Token lifetime in days (1-90, default 30)" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            token: { type: "object", properties: tokenProperties },
            plainToken: { type: "string", description: "The token value — shown once, never retrievable later" },
          },
        },
        400: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { sub, wid } = request.user;
    const body = request.body as { name?: string; expiresInDays?: number };

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "name is required and must be a non-empty string" });
    }

    const expiresInDays = body.expiresInDays ?? 30;
    if (expiresInDays < 1 || expiresInDays > 90) {
      return reply.code(400).send({ error: "expiresInDays must be between 1 and 90" });
    }

    const plainToken = `ah5p_${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(plainToken).digest("hex");
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const [row] = await db
      .insert(personalAccessTokens)
      .values({
        userId: sub,
        workspaceId: wid,
        name: body.name.trim(),
        tokenHash,
        expiresAt,
      })
      .returning({
        id: personalAccessTokens.id,
        name: personalAccessTokens.name,
        expiresAt: personalAccessTokens.expiresAt,
        lastUsedAt: personalAccessTokens.lastUsedAt,
        createdAt: personalAccessTokens.createdAt,
      });

    return {
      token: { ...row!, isExpired: false },
      plainToken,
    };
  });

  /**
   * GET /tokens
   * Lists all active (non-revoked) PATs for the current user in the current workspace.
   */
  fastify.get("/tokens", {
    schema: {
      tags: ["Tokens"],
      summary: "List personal access tokens",
      description: "Returns all non-revoked PATs for the current user in the current workspace.",
      response: {
        200: {
          type: "object",
          properties: {
            tokens: {
              type: "array",
              items: { type: "object", properties: tokenProperties },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { sub, wid } = request.user;

    const rows = await db
      .select({
        id: personalAccessTokens.id,
        name: personalAccessTokens.name,
        expiresAt: personalAccessTokens.expiresAt,
        lastUsedAt: personalAccessTokens.lastUsedAt,
        createdAt: personalAccessTokens.createdAt,
      })
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.userId, sub),
          eq(personalAccessTokens.workspaceId, wid),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .orderBy(personalAccessTokens.createdAt);

    return {
      tokens: rows.map((r) => ({
        ...r,
        isExpired: r.expiresAt < new Date(),
      })),
    };
  });

  /**
   * DELETE /tokens/:id
   * Revokes a PAT by setting revokedAt. Takes effect immediately.
   */
  fastify.delete<{ Params: { id: string } }>("/tokens/:id", {
    schema: {
      tags: ["Tokens"],
      summary: "Revoke personal access token",
      description: "Soft-deletes a PAT by setting revokedAt. The token becomes invalid immediately.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid", description: "Token ID" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: { success: { type: "boolean" as const } },
        },
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { sub, wid } = request.user;
    const { id } = request.params;

    const result = await db
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(personalAccessTokens.id, id),
          eq(personalAccessTokens.userId, sub),
          eq(personalAccessTokens.workspaceId, wid),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .returning({ id: personalAccessTokens.id });

    if (result.length === 0) {
      return reply.code(404).send({ error: "Token not found or already revoked" });
    }

    return { success: true };
  });

  /**
   * PUT /tokens/:id
   * Updates the display name of a personal access token.
   */
  fastify.put<{ Params: { id: string } }>("/tokens/:id", {
    schema: {
      tags: ["Tokens"],
      summary: "Rename personal access token",
      description: "Updates the display name of a non-revoked PAT.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid", description: "Token ID" },
        },
      },
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100, description: "New token label" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            token: {
              type: "object",
              properties: {
                id: { type: "string" as const, format: "uuid" },
                name: { type: "string" as const },
              },
            },
          },
        },
        400: errorResponse,
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { sub, wid } = request.user;
    const { id } = request.params;
    const body = request.body as { name?: string };

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "name is required and must be a non-empty string" });
    }

    if (body.name.length > 100) {
      return reply.code(400).send({ error: "name must be at most 100 characters" });
    }

    const [updated] = await db
      .update(personalAccessTokens)
      .set({ name: body.name.trim() })
      .where(
        and(
          eq(personalAccessTokens.id, id),
          eq(personalAccessTokens.userId, sub),
          eq(personalAccessTokens.workspaceId, wid),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .returning({ id: personalAccessTokens.id, name: personalAccessTokens.name });

    if (!updated) {
      return reply.code(404).send({ error: "Token not found or already revoked" });
    }

    return { token: updated };
  });
}
