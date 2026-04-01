import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createMockOAuthTokenResponse, createMockTelegramBotInfo } from "./test-data.js";

export interface MockOAuthServer {
  /** HTTP server instance */
  server: Server;
  /** Token endpoint URL */
  tokenUrl: string;
  /** Authorization endpoint URL */
  authUrl: string;
  /** Stop the OAuth server */
  close: () => Promise<void>;
}

/**
 * Read request body from IncomingMessage
 */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

/**
 * Send JSON response
 */
function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Creates a mock Google OAuth server
 *
 * Simulates:
 * - /authorize - Authorization endpoint (302 redirect)
 * - /token - Token endpoint (returns access token + refresh token)
 * - Token refresh (when grant_type=refresh_token)
 * - Error responses (invalid_grant, etc.)
 *
 * @example
 * const mock = await createMockGoogleOAuth();
 * // ... configure OAuth connector to use mock.tokenUrl ...
 * await mock.close();
 */
export async function createMockGoogleOAuth(): Promise<MockOAuthServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Authorization endpoint
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const code = "mock_authorization_code";

      if (!redirectUri || !state) {
        jsonResponse(res, 400, { error: "invalid_request", error_description: "Missing parameters" });
        return;
      }

      // Redirect with authorization code
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);

      res.writeHead(302, { Location: callbackUrl.toString() });
      res.end();
      return;
    }

    // Token endpoint
    if (url.pathname === "/token" && req.method === "POST") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");

      // Token refresh
      if (grantType === "refresh_token") {
        const refreshToken = params.get("refresh_token");

        // Simulate invalid refresh token
        if (refreshToken === "invalid_refresh_token") {
          jsonResponse(res, 400, {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked",
          });
          return;
        }

        // Return new access token
        jsonResponse(res, 200, createMockOAuthTokenResponse(refreshToken ? { refresh_token: refreshToken } : {}));
        return;
      }

      // Authorization code exchange
      if (grantType === "authorization_code") {
        const code = params.get("code");

        if (!code || code !== "mock_authorization_code") {
          jsonResponse(res, 400, {
            error: "invalid_grant",
            error_description: "Invalid authorization code",
          });
          return;
        }

        jsonResponse(res, 200, createMockOAuthTokenResponse());
        return;
      }

      jsonResponse(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    // Default 404
    jsonResponse(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to get server address");
  }

  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return {
    server,
    tokenUrl: `${baseUrl}/token`,
    authUrl: `${baseUrl}/authorize`,
    close,
  };
}

/**
 * Creates a mock Microsoft OAuth server
 *
 * Similar to Google OAuth but with Microsoft-specific endpoints
 */
export async function createMockMicrosoftOAuth(): Promise<MockOAuthServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Microsoft uses /oauth2/v2.0/authorize and /oauth2/v2.0/token
    if (url.pathname.includes("/authorize")) {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const code = "mock_ms_authorization_code";

      if (!redirectUri || !state) {
        jsonResponse(res, 400, { error: "invalid_request" });
        return;
      }

      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);

      res.writeHead(302, { Location: callbackUrl.toString() });
      res.end();
      return;
    }

    if (url.pathname.includes("/token") && req.method === "POST") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");

      if (grantType === "refresh_token") {
        const refreshToken = params.get("refresh_token");

        if (refreshToken === "invalid_refresh_token") {
          jsonResponse(res, 400, {
            error: "invalid_grant",
            error_description: "AADSTS50173: The provided grant has expired",
          });
          return;
        }

        jsonResponse(res, 200, createMockOAuthTokenResponse({
          scope: "User.Read Mail.Read Chat.ReadWrite",
        }));
        return;
      }

      if (grantType === "authorization_code") {
        jsonResponse(res, 200, createMockOAuthTokenResponse({
          scope: "User.Read Mail.Read Chat.ReadWrite",
        }));
        return;
      }

      jsonResponse(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    jsonResponse(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to get server address");
  }

  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return {
    server,
    tokenUrl: `${baseUrl}/oauth2/v2.0/token`,
    authUrl: `${baseUrl}/oauth2/v2.0/authorize`,
    close,
  };
}

/**
 * Creates a mock Telegram Bot API server
 *
 * Simulates:
 * - /botTOKEN/getMe - Bot info validation endpoint
 * - /botTOKEN/sendMessage - Send message endpoint
 *
 * @example
 * const mock = await createMockTelegramAPI();
 * // ... test Telegram bot token validation ...
 * await mock.close();
 */
export async function createMockTelegramAPI(): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Extract bot token from path: /botTOKEN/method
    const match = url.pathname.match(/^\/bot([^/]+)\/(.+)$/);
    if (!match) {
      jsonResponse(res, 404, { ok: false, description: "Not Found" });
      return;
    }

    const [, botToken, method] = match;

    // Simulate invalid bot token
    if (botToken === "invalid_token") {
      jsonResponse(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
      return;
    }

    // getMe endpoint - bot info validation
    if (method === "getMe") {
      jsonResponse(res, 200, createMockTelegramBotInfo());
      return;
    }

    // sendMessage endpoint
    if (method === "sendMessage") {
      const body = await readBody(req);
      const params = JSON.parse(body);

      jsonResponse(res, 200, {
        ok: true,
        result: {
          message_id: 12345,
          chat: { id: params.chat_id, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: params.text,
        },
      });
      return;
    }

    jsonResponse(res, 404, { ok: false, description: "Method not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to get server address");
  }

  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { server, baseUrl, close };
}
