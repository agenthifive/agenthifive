import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { workspaceOauthApps } from "../db/schema/workspace-oauth-apps";
import { connections } from "../db/schema/connections";
import { encrypt } from "@agenthifive/security";

import { getEncryptionKey } from "../services/encryption-key";

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

const oauthAppProperties = {
  id: { type: "string" as const, format: "uuid" },
  provider: { type: "string" as const },
  clientId: { type: "string" as const },
  tenantId: { type: "string" as const, nullable: true },
  label: { type: "string" as const },
  createdAt: { type: "string" as const, format: "date-time" },
  updatedAt: { type: "string" as const, format: "date-time" },
};

export default async function workspaceOauthAppRoutes(
  fastify: FastifyInstance,
) {
  /**
   * GET /workspace-oauth-apps
   * List OAuth apps for the current workspace. Never exposes secrets.
   */
  fastify.get("/workspace-oauth-apps", {
    schema: {
      tags: ["Settings"],
      summary: "List workspace OAuth apps",
      description:
        "Returns BYA (Bring Your App) OAuth app credentials registered for the current workspace. " +
        "Client secrets are never exposed. One app per provider per workspace.",
      response: {
        200: {
          type: "object",
          properties: {
            apps: {
              type: "array",
              items: {
                type: "object",
                properties: oauthAppProperties,
              },
            },
            callbackUrl: { type: "string" },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const { wid } = request.user;

      const apps = await db
        .select({
          id: workspaceOauthApps.id,
          provider: workspaceOauthApps.provider,
          clientId: workspaceOauthApps.clientId,
          tenantId: workspaceOauthApps.tenantId,
          label: workspaceOauthApps.label,
          createdAt: workspaceOauthApps.createdAt,
          updatedAt: workspaceOauthApps.updatedAt,
        })
        .from(workspaceOauthApps)
        .where(eq(workspaceOauthApps.workspaceId, wid));

      const WEB_URL = process.env["WEB_URL"] || "http://localhost:3000";
      return reply.send({
        apps,
        callbackUrl: `${WEB_URL}/api/connections/callback`,
      });
    },
  });

  /**
   * POST /workspace-oauth-apps
   * Create or update (upsert) an OAuth app for a provider.
   * Encrypts the client secret before storage.
   */
  fastify.post("/workspace-oauth-apps", {
    schema: {
      tags: ["Settings"],
      summary: "Create or update a workspace OAuth app",
      description:
        "Register your own OAuth app credentials for Google or Microsoft. " +
        "Upserts on (workspace, provider) — one app per provider. " +
        "The client secret is encrypted at rest with AES-256-GCM.",
      body: {
        type: "object",
        required: ["provider", "clientId", "clientSecret", "label"],
        properties: {
          provider: {
            type: "string",
            enum: ["google", "microsoft"],
          },
          clientId: { type: "string", minLength: 1 },
          clientSecret: { type: "string", minLength: 1 },
          tenantId: { type: "string", nullable: true },
          label: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: oauthAppProperties,
        },
        201: {
          type: "object",
          properties: oauthAppProperties,
        },
        400: errorResponse,
      },
    },
    handler: async (request, reply) => {
      const { wid } = request.user;
      const body = request.body as {
        provider: "google" | "microsoft";
        clientId: string;
        clientSecret: string;
        tenantId?: string | null;
        label: string;
      };

      // Microsoft requires tenantId info (default to "common" if not provided)
      const tenantId =
        body.provider === "microsoft" ? (body.tenantId || null) : null;

      // Encrypt the client secret
      const encryptedClientSecret = JSON.stringify(
        encrypt(body.clientSecret, getEncryptionKey()),
      );

      // Check for existing app (upsert)
      const [existing] = await db
        .select({ id: workspaceOauthApps.id })
        .from(workspaceOauthApps)
        .where(
          and(
            eq(workspaceOauthApps.workspaceId, wid),
            eq(workspaceOauthApps.provider, body.provider),
          ),
        )
        .limit(1);

      if (existing) {
        // Update
        const [updated] = await db
          .update(workspaceOauthApps)
          .set({
            clientId: body.clientId,
            encryptedClientSecret,
            tenantId,
            label: body.label,
            updatedAt: new Date(),
          })
          .where(eq(workspaceOauthApps.id, existing.id))
          .returning({
            id: workspaceOauthApps.id,
            provider: workspaceOauthApps.provider,
            clientId: workspaceOauthApps.clientId,
            tenantId: workspaceOauthApps.tenantId,
            label: workspaceOauthApps.label,
            createdAt: workspaceOauthApps.createdAt,
            updatedAt: workspaceOauthApps.updatedAt,
          });

        return reply.send(updated);
      }

      // Create
      const [created] = await db
        .insert(workspaceOauthApps)
        .values({
          workspaceId: wid,
          provider: body.provider,
          clientId: body.clientId,
          encryptedClientSecret,
          tenantId,
          label: body.label,
        })
        .returning({
          id: workspaceOauthApps.id,
          provider: workspaceOauthApps.provider,
          clientId: workspaceOauthApps.clientId,
          tenantId: workspaceOauthApps.tenantId,
          label: workspaceOauthApps.label,
          createdAt: workspaceOauthApps.createdAt,
          updatedAt: workspaceOauthApps.updatedAt,
        });

      return reply.code(201).send(created);
    },
  });

  /**
   * DELETE /workspace-oauth-apps/:id
   * Delete a workspace OAuth app.
   * Connections using this app will have oauthAppId set to NULL (FK cascade).
   */
  fastify.delete<{ Params: { id: string } }>("/workspace-oauth-apps/:id", {
    schema: {
      tags: ["Settings"],
      summary: "Delete a workspace OAuth app",
      description:
        "Removes OAuth app credentials for a provider. " +
        "Connections that used this app will fall back to corporate credentials (if available) " +
        "or require re-authentication.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            deleted: { type: "boolean" },
            affectedConnections: { type: "number" },
          },
        },
        404: errorResponse,
      },
    },
    handler: async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;

      // Verify ownership
      const [app] = await db
        .select({ id: workspaceOauthApps.id })
        .from(workspaceOauthApps)
        .where(
          and(
            eq(workspaceOauthApps.id, id),
            eq(workspaceOauthApps.workspaceId, wid),
          ),
        )
        .limit(1);

      if (!app) {
        return reply.code(404).send({ error: "OAuth app not found" });
      }

      // Count affected connections (for informational response)
      const affected = await db
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.oauthAppId, id));

      // Delete (FK SET NULL will null out connection.oauthAppId)
      await db
        .delete(workspaceOauthApps)
        .where(eq(workspaceOauthApps.id, id));

      return reply.send({
        deleted: true,
        affectedConnections: affected.length,
      });
    },
  });
}
