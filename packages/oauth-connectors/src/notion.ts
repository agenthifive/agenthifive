import type { OAuthTokenSet } from "@agenthifive/contracts";
import type {
  OAuthConnector,
  ProviderCapabilities,
  AuthCodeStartInput,
  AuthCodeStartOutput,
  AuthCodeExchangeInput,
} from "./types.js";

/**
 * Notion scopes are configured at the integration level (not per-request),
 * so this is intentionally empty.
 */
export const NOTION_SCOPES = {} as const;

export interface NotionConnectorConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Raw Notion workspace info returned by GET /v1/users/me.
 * Used to populate connection metadata after token exchange.
 */
export interface NotionWorkspaceInfo {
  botId: string;
  workspaceId: string;
  workspaceName: string;
  ownerEmail: string | null;
}

/**
 * Notion OAuth connector.
 *
 * Key differences from Google/Microsoft:
 * - No OIDC discovery — fixed authorization and token endpoints
 * - Basic auth for token exchange (not POST body)
 * - No PKCE support
 * - Tokens are permanent (no expiry, no refresh token)
 * - Token exchange uses JSON body (not form-encoded)
 */
export class NotionConnector implements OAuthConnector {
  private readonly config: NotionConnectorConfig;

  constructor(config: NotionConnectorConfig) {
    this.config = config;
  }

  capabilities(): ProviderCapabilities {
    return {
      provider: "notion",
      supportsAuthCode: true,
      supportsPkce: false,
    };
  }

  async createAuthorizationUrl(
    input: AuthCodeStartInput,
  ): Promise<AuthCodeStartOutput> {
    const authorizationUrl = new URL(
      "https://api.notion.com/v1/oauth/authorize",
    );
    authorizationUrl.searchParams.set("client_id", this.config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("state", input.state);
    authorizationUrl.searchParams.set("owner", "user");
    // PKCE not supported by Notion — codeChallenge params intentionally ignored

    return { authorizationUrl: authorizationUrl.toString() };
  }

  async exchangeAuthorizationCode(
    input: AuthCodeExchangeInput,
  ): Promise<OAuthTokenSet> {
    // Notion uses Basic auth (client_id:client_secret) for token exchange
    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");

    const response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Notion token exchange failed (${response.status}): ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      token_type?: string;
      bot_id?: string;
      workspace_id?: string;
      workspace_name?: string;
    };

    // Notion tokens are permanent — no refreshToken, no expiresAt
    return {
      accessToken: data.access_token,
      tokenType: data.token_type ?? "bearer",
    };
  }

  async refresh(_refreshToken: string): Promise<OAuthTokenSet> {
    throw new Error("Notion tokens are permanent and do not support refresh");
  }

  /**
   * Fetch workspace info using a Notion access token.
   * Call after exchangeAuthorizationCode() to populate connection metadata.
   */
  static async fetchWorkspaceInfo(
    accessToken: string,
  ): Promise<NotionWorkspaceInfo> {
    const response = await fetch("https://api.notion.com/v1/users/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": "2022-06-28",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Notion workspace info (${response.status})`,
      );
    }

    const data = (await response.json()) as {
      id: string;
      type: string;
      bot?: {
        owner?: {
          type?: string;
          user?: { person?: { email?: string } };
          workspace?: boolean;
        };
        workspace_name?: string;
      };
    };

    return {
      botId: data.id,
      workspaceId: data.bot?.owner?.workspace ? data.id : "",
      workspaceName: data.bot?.workspace_name ?? "",
      ownerEmail: data.bot?.owner?.user?.person?.email ?? null,
    };
  }
}
