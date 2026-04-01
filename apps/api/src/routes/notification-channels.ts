import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { request as undiciRequest } from "undici";
import { decrypt, type EncryptedPayload } from "@agenthifive/security";
import { db } from "../db/client";
import { notificationChannels } from "../db/schema/notification-channels";
import { connections } from "../db/schema/connections";
import { sendTelegramNotification } from "../services/telegram-notifications";
import { sendSlackNotification } from "../services/slack-notifications";

import { getEncryptionKey } from "../services/encryption-key";

export default async function notificationChannelRoutes(fastify: FastifyInstance) {
  /**
   * GET /notification-channels
   * List notification channels for the current workspace.
   */
  fastify.get("/notification-channels", {
    schema: {
      tags: ["Notification Channels"],
      summary: "List notification channels",
      description: "Returns all notification channels configured for the current workspace.",
      response: {
        200: {
          type: "object",
          properties: {
            channels: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  channelType: { type: "string" },
                  enabled: { type: "boolean" },
                  connectionId: { type: "string", format: "uuid", nullable: true },
                  config: { type: "object", additionalProperties: true },
                  verificationStatus: { type: "string" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const wid = request.user.wid;
    const rows = await db
      .select({
        id: notificationChannels.id,
        channelType: notificationChannels.channelType,
        enabled: notificationChannels.enabled,
        connectionId: notificationChannels.connectionId,
        config: notificationChannels.config,
        verificationStatus: notificationChannels.verificationStatus,
        createdAt: notificationChannels.createdAt,
      })
      .from(notificationChannels)
      .where(eq(notificationChannels.workspaceId, wid));

    return { channels: rows };
  });

  /**
   * POST /notification-channels
   * Create or update a notification channel (upsert on workspace + channelType).
   */
  fastify.post("/notification-channels", {
    schema: {
      tags: ["Notification Channels"],
      summary: "Create or update notification channel",
      body: {
        type: "object",
        required: ["channelType", "connectionId", "config"],
        properties: {
          channelType: { type: "string", enum: ["telegram", "slack"] },
          connectionId: { type: "string", format: "uuid" },
          config: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            channel: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                channelType: { type: "string" },
                enabled: { type: "boolean" },
                connectionId: { type: "string", format: "uuid", nullable: true },
                config: { type: "object", additionalProperties: true },
                verificationStatus: { type: "string" },
              },
            },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        404: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const wid = request.user.wid;
    const { channelType, connectionId, config } = request.body as {
      channelType: string;
      connectionId: string;
      config: Record<string, unknown>;
    };

    // Validate config has the required field for the channel type
    if (channelType === "telegram" && !config.chatId) {
      return reply.code(400).send({ error: "chatId is required for Telegram channels" });
    }
    if (channelType === "slack" && !config.channelId) {
      return reply.code(400).send({ error: "channelId is required for Slack channels" });
    }

    // Validate: connection exists, belongs to workspace, matches channel type, is healthy
    const [conn] = await db
      .select({
        id: connections.id,
        provider: connections.provider,
        status: connections.status,
      })
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.workspaceId, wid),
        ),
      )
      .limit(1);

    if (!conn) {
      return reply.code(404).send({ error: "Connection not found" });
    }

    if (conn.provider !== channelType) {
      return reply.code(400).send({ error: `Connection must be a ${channelType} bot connection` });
    }

    if (conn.status !== "healthy") {
      return reply.code(400).send({ error: "Connection is not healthy" });
    }

    // Upsert: insert or update on workspace + channelType
    const [channel] = await db
      .insert(notificationChannels)
      .values({
        workspaceId: wid,
        channelType,
        connectionId,
        config,
        verificationStatus: "pending",
      })
      .onConflictDoUpdate({
        target: [notificationChannels.workspaceId, notificationChannels.channelType],
        set: {
          connectionId,
          config,
          verificationStatus: "pending",
          updatedAt: new Date(),
        },
      })
      .returning({
        id: notificationChannels.id,
        channelType: notificationChannels.channelType,
        enabled: notificationChannels.enabled,
        connectionId: notificationChannels.connectionId,
        config: notificationChannels.config,
        verificationStatus: notificationChannels.verificationStatus,
      });

    return { channel };
  });

  /**
   * DELETE /notification-channels/:id
   * Remove a notification channel.
   */
  fastify.delete<{ Params: { id: string } }>("/notification-channels/:id", {
    schema: {
      tags: ["Notification Channels"],
      summary: "Delete notification channel",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
      response: {
        200: {
          type: "object",
          properties: { deleted: { type: "boolean" } },
        },
        404: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const wid = request.user.wid;
    const { id } = request.params;

    const deleted = await db
      .delete(notificationChannels)
      .where(
        and(
          eq(notificationChannels.id, id),
          eq(notificationChannels.workspaceId, wid),
        ),
      )
      .returning({ id: notificationChannels.id });

    if (deleted.length === 0) {
      return reply.code(404).send({ error: "Notification channel not found" });
    }

    return { deleted: true };
  });

  /**
   * POST /notification-channels/:id/test
   * Send a test message to verify the channel works.
   */
  fastify.post<{ Params: { id: string } }>("/notification-channels/:id/test", {
    schema: {
      tags: ["Notification Channels"],
      summary: "Test notification channel",
      description: "Sends a test message via the configured channel. On success, marks as verified.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            error: { type: "string", nullable: true },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        404: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const wid = request.user.wid;
    const { id } = request.params;

    // Look up the channel
    const [channel] = await db
      .select({
        id: notificationChannels.id,
        channelType: notificationChannels.channelType,
        connectionId: notificationChannels.connectionId,
        config: notificationChannels.config,
      })
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.id, id),
          eq(notificationChannels.workspaceId, wid),
        ),
      )
      .limit(1);

    if (!channel) {
      return reply.code(404).send({ error: "Notification channel not found" });
    }

    if (!channel.connectionId) {
      return reply.code(400).send({ error: "No connection configured for this channel" });
    }

    if (!["telegram", "slack"].includes(channel.channelType)) {
      return reply.code(400).send({ error: "Channel type not supported for testing" });
    }

    const config = channel.config as { chatId?: string; channelId?: string };

    // Fetch the connection to get the encrypted bot token
    const [conn] = await db
      .select({ encryptedTokens: connections.encryptedTokens })
      .from(connections)
      .where(eq(connections.id, channel.connectionId))
      .limit(1);

    if (!conn?.encryptedTokens) {
      return reply.code(400).send({ error: "Connection has no tokens — reconnect the bot" });
    }

    // Send a test message via the appropriate service
    let result: { ok: boolean; error?: string | undefined };

    if (channel.channelType === "telegram") {
      if (!config.chatId) {
        return reply.code(400).send({ error: "No chat ID configured" });
      }
      result = await sendTelegramNotification(conn.encryptedTokens, {
        chatId: config.chatId,
        text: "AgentHiFive test notification. If you see this, your Telegram notification channel is working.",
      });
    } else {
      if (!config.channelId) {
        return reply.code(400).send({ error: "No channel ID configured" });
      }
      result = await sendSlackNotification(conn.encryptedTokens, {
        channel: config.channelId,
        text: "AgentHiFive test notification. If you see this, your Slack notification channel is working.",
      });
    }

    if (result.ok) {
      // Mark as verified
      await db
        .update(notificationChannels)
        .set({ verificationStatus: "verified", updatedAt: new Date() })
        .where(eq(notificationChannels.id, channel.id));

      return { ok: true, error: null };
    }

    return { ok: false, error: result.error ?? "Failed to send test message" };
  });

  /**
   * PATCH /notification-channels/:id/enabled
   * Toggle the enabled status of a notification channel.
   */
  fastify.patch<{ Params: { id: string } }>("/notification-channels/:id/enabled", {
    schema: {
      tags: ["Notification Channels"],
      summary: "Toggle notification channel enabled status",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
      body: {
        type: "object",
        required: ["enabled"],
        properties: {
          enabled: { type: "boolean" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            enabled: { type: "boolean" },
          },
        },
        404: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const wid = request.user.wid;
    const { id } = request.params;
    const { enabled } = request.body as { enabled: boolean };

    const updated = await db
      .update(notificationChannels)
      .set({ enabled, updatedAt: new Date() })
      .where(
        and(
          eq(notificationChannels.id, id),
          eq(notificationChannels.workspaceId, wid),
        ),
      )
      .returning({
        id: notificationChannels.id,
        enabled: notificationChannels.enabled,
      });

    if (updated.length === 0) {
      return reply.code(404).send({ error: "Notification channel not found" });
    }

    return updated[0]!;
  });

  /**
   * POST /notification-channels/telegram/detect-chats
   * Call getUpdates on a Telegram bot to find chats that have messaged it.
   */
  fastify.post("/notification-channels/telegram/detect-chats", {
    schema: {
      tags: ["Notification Channels"],
      summary: "Detect Telegram chats",
      description: "Calls getUpdates on the bot to find users/groups that have messaged it recently.",
      body: {
        type: "object",
        required: ["connectionId"],
        properties: {
          connectionId: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            chats: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  chatId: { type: "string" },
                  name: { type: "string" },
                  type: { type: "string" },
                  username: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        404: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const wid = request.user.wid;
    const { connectionId } = request.body as { connectionId: string };

    // Validate connection belongs to workspace and is a Telegram bot
    const [conn] = await db
      .select({
        id: connections.id,
        provider: connections.provider,
        status: connections.status,
        encryptedTokens: connections.encryptedTokens,
      })
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.workspaceId, wid),
        ),
      )
      .limit(1);

    if (!conn) {
      return reply.code(404).send({ error: "Connection not found" });
    }
    if (conn.provider !== "telegram") {
      return reply.code(400).send({ error: "Connection must be a Telegram bot" });
    }
    if (!conn.encryptedTokens) {
      return reply.code(400).send({ error: "Connection has no tokens — reconnect the bot" });
    }

    // Decrypt bot token
    let botToken: string;
    try {
      const encryptedPayload: EncryptedPayload = JSON.parse(conn.encryptedTokens);
      const decrypted = decrypt(encryptedPayload, getEncryptionKey());
      const tokenData = JSON.parse(decrypted) as { botToken?: string };
      if (!tokenData.botToken) {
        return reply.code(400).send({ error: "No bot token in connection" });
      }
      botToken = tokenData.botToken;
    } catch {
      return reply.code(400).send({ error: "Failed to decrypt bot token" });
    }

    // Call getUpdates with timeout=0 (non-blocking, just fetch buffered updates)
    try {
      const res = await undiciRequest(
        `https://api.telegram.org/bot${botToken}/getUpdates`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ timeout: 0, allowed_updates: ["message"] }),
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
        },
      );
      const resBody = (await res.body.json()) as {
        ok: boolean;
        result?: Array<{
          message?: {
            chat: {
              id: number;
              type: string;
              first_name?: string;
              last_name?: string;
              title?: string;
              username?: string;
            };
          };
        }>;
      };

      if (!resBody.ok || !resBody.result) {
        return reply.code(400).send({ error: "Telegram API returned an error — make sure the bot token is valid" });
      }

      // Deduplicate chats by ID
      const chatMap = new Map<string, { chatId: string; name: string; type: string; username: string | null }>();
      for (const update of resBody.result) {
        const chat = update.message?.chat;
        if (!chat) continue;
        const chatId = String(chat.id);
        if (chatMap.has(chatId)) continue;
        const name = chat.title
          ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || chatId);
        chatMap.set(chatId, {
          chatId,
          name,
          type: chat.type,
          username: chat.username ?? null,
        });
      }

      return { chats: Array.from(chatMap.values()) };
    } catch {
      return reply.code(400).send({ error: "Failed to reach Telegram API" });
    }
  });
}
