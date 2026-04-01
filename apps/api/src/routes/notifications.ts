import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} from "../services/notifications";
import { subscribeToNotifications } from "../services/pg-listeners";

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

export default async function notificationRoutes(fastify: FastifyInstance) {
  /**
   * GET /notifications
   * List notifications for the current workspace (paginated, newest first).
   */
  fastify.get("/notifications", {
    schema: {
      tags: ["Notifications"],
      summary: "List notifications",
      description:
        "Returns notifications for the current workspace, sorted by newest first. " +
        "Supports pagination and filtering by unread status.",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          offset: { type: "integer", minimum: 0, default: 0 },
          unreadOnly: { type: "boolean", default: false },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            notifications: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  type: { type: "string" },
                  title: { type: "string" },
                  body: { type: "string" },
                  linkUrl: { type: "string", nullable: true },
                  read: { type: "boolean" },
                  metadata: { type: "object", nullable: true, additionalProperties: true },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { wid: workspaceId } = request.user;
    const query = request.query as {
      limit?: number;
      offset?: number;
      unreadOnly?: boolean;
    };

    const rows = await getNotifications(workspaceId, {
      ...(query.limit !== undefined && { limit: query.limit }),
      ...(query.offset !== undefined && { offset: query.offset }),
      ...(query.unreadOnly !== undefined && { unreadOnly: query.unreadOnly }),
    });
    return { notifications: rows };
  });

  /**
   * GET /notifications/unread-count
   * Returns the number of unread notifications.
   */
  fastify.get("/notifications/unread-count", {
    schema: {
      tags: ["Notifications"],
      summary: "Get unread count",
      description: "Returns the number of unread notifications for the current workspace.",
      response: {
        200: {
          type: "object",
          properties: {
            count: { type: "integer" },
          },
        },
      },
    },
  }, async (request) => {
    const { wid: workspaceId } = request.user;
    const count = await getUnreadCount(workspaceId);
    return { count };
  });

  /**
   * POST /notifications/:id/read
   * Mark a single notification as read.
   */
  fastify.post<{ Params: { id: string } }>("/notifications/:id/read", {
    schema: {
      tags: ["Notifications"],
      summary: "Mark as read",
      description: "Marks a single notification as read.",
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
            success: { type: "boolean" },
          },
        },
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { wid: workspaceId } = request.user;

    const updated = await markAsRead(id, workspaceId);
    if (!updated) {
      return reply.code(404).send({ error: "Notification not found" });
    }
    return { success: true };
  });

  /**
   * POST /notifications/read-all
   * Mark all notifications as read.
   */
  fastify.post("/notifications/read-all", {
    schema: {
      tags: ["Notifications"],
      summary: "Mark all as read",
      description: "Marks all unread notifications as read for the current workspace.",
      response: {
        200: {
          type: "object",
          properties: {
            updated: { type: "integer" },
          },
        },
      },
    },
  }, async (request) => {
    const { wid: workspaceId } = request.user;
    const updated = await markAllAsRead(workspaceId);
    return { updated };
  });

  /**
   * GET /notifications/stream
   * SSE endpoint for real-time notification push.
   */
  fastify.get("/notifications/stream", {
    schema: {
      tags: ["Notifications"],
      summary: "Real-time notification stream (SSE)",
      description:
        "Server-Sent Events endpoint for real-time notification push. " +
        "Sends `event: connected` on connection, then `event: notification` with JSON data " +
        "when new notifications arrive. 30-second heartbeat comments (`: heartbeat`) keep " +
        "the connection alive. Set `X-Accel-Buffering: no` for Nginx compatibility.",
      produces: ["text/event-stream"],
      response: {
        200: {
          description: "SSE stream (Content-Type: text/event-stream)",
          type: "string",
        },
      },
    },
  }, async (request, reply) => {
    const { wid: workspaceId } = request.user;

    // Set SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Nginx: don't buffer SSE
    });

    // Send initial connected event
    reply.raw.write("event: connected\ndata: {}\n\n");

    // Subscribe to notifications
    const unsubscribe = subscribeToNotifications(workspaceId, (notification) => {
      reply.raw.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
    });

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 30_000);

    // Cleanup on connection close
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
