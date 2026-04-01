import * as oauth from "oauth4webapi";
import type { OAuthTokenSet } from "@agenthifive/contracts";
import type {
  OAuthConnector,
  ProviderCapabilities,
  AuthCodeStartInput,
  AuthCodeStartOutput,
  AuthCodeExchangeInput,
} from "./types.js";

/**
 * Microsoft Teams scopes for AgentHiFive.
 *
 * Default scopes require only user consent (no admin approval).
 * Channel scopes require tenant admin consent and are opt-in.
 */
export const MICROSOFT_SCOPES = {
  // User consent — no admin approval needed
  CHAT_READ: "Chat.Read",
  CHAT_READ_WRITE: "Chat.ReadWrite",
  CHAT_MESSAGE_SEND: "ChatMessage.Send",
  USER_READ: "User.Read",
  FILES_READ_ALL: "Files.Read.All",
  FILES_READ_WRITE_ALL: "Files.ReadWrite.All",
  OFFLINE_ACCESS: "offline_access",
  // Admin consent required — opt-in for Teams channel access
  CHANNEL_MESSAGE_READ_ALL: "ChannelMessage.Read.All",
  CHANNEL_MESSAGE_SEND: "ChannelMessage.Send",
} as const;

export interface MicrosoftConnectorConfig {
  clientId: string;
  clientSecret: string;
  /** Optional tenant ID. Defaults to "common" for multi-tenant. */
  tenantId?: string;
}

function tokenSetFromResponse(
  response: oauth.TokenEndpointResponse,
): OAuthTokenSet {
  const tokenSet: OAuthTokenSet = {
    accessToken: response.access_token,
    tokenType: response.token_type ?? "bearer",
  };

  if (response.refresh_token !== undefined) {
    tokenSet.refreshToken = response.refresh_token;
  }
  if (response.expires_in !== undefined) {
    tokenSet.expiresAt = Math.floor(Date.now() / 1000) + response.expires_in;
  }
  if (response.scope !== undefined) {
    tokenSet.scope = response.scope.split(" ");
  }

  return tokenSet;
}

export class MicrosoftConnector implements OAuthConnector {
  private readonly config: MicrosoftConnectorConfig;
  private readonly client: oauth.Client;
  private readonly clientAuth: oauth.ClientAuth;
  private readonly tenant: string;
  private readonly issuer: URL;
  private asCache: oauth.AuthorizationServer | null = null;

  constructor(config: MicrosoftConnectorConfig) {
    this.config = config;
    this.client = { client_id: config.clientId };
    this.clientAuth = oauth.ClientSecretPost(config.clientSecret);
    this.tenant = config.tenantId ?? "common";
    this.issuer = new URL(
      `https://login.microsoftonline.com/${this.tenant}/v2.0`,
    );
  }

  capabilities(): ProviderCapabilities {
    return {
      provider: "microsoft",
      supportsAuthCode: true,
      supportsPkce: true,
    };
  }

  private async getAuthorizationServer(): Promise<oauth.AuthorizationServer> {
    if (this.asCache) return this.asCache;

    // For multi-tenant authorities ("common", "organizations", "consumers"),
    // Microsoft's OIDC discovery returns issuer "https://login.microsoftonline.com/{tenantid}/v2.0"
    // with a literal {tenantid} placeholder, which fails oauth4webapi's strict issuer validation.
    // Use hardcoded endpoints for these; use OIDC discovery for specific tenant IDs.
    const isMultiTenant = ["common", "organizations", "consumers"].includes(this.tenant);
    if (isMultiTenant) {
      const base = `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0`;
      this.asCache = {
        issuer: `https://login.microsoftonline.com/${this.tenant}/v2.0`,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      };
      return this.asCache;
    }

    const response = await oauth.discoveryRequest(this.issuer, {
      algorithm: "oidc",
    });
    this.asCache = await oauth.processDiscoveryResponse(
      this.issuer,
      response,
    );
    return this.asCache;
  }

  async createAuthorizationUrl(
    input: AuthCodeStartInput,
  ): Promise<AuthCodeStartOutput> {
    const as = await this.getAuthorizationServer();

    if (!as.authorization_endpoint) {
      throw new Error(
        "Microsoft authorization_endpoint not found in metadata",
      );
    }

    const authorizationUrl = new URL(as.authorization_endpoint);
    authorizationUrl.searchParams.set("client_id", this.config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", input.scopes.join(" "));
    authorizationUrl.searchParams.set("state", input.state);
    authorizationUrl.searchParams.set("code_challenge", input.codeChallenge);
    authorizationUrl.searchParams.set(
      "code_challenge_method",
      input.codeChallengeMethod,
    );
    // Show account picker so user can choose/switch Microsoft account
    authorizationUrl.searchParams.set("prompt", "select_account");

    return { authorizationUrl: authorizationUrl.toString() };
  }

  async exchangeAuthorizationCode(
    input: AuthCodeExchangeInput,
  ): Promise<OAuthTokenSet> {
    const as = await this.getAuthorizationServer();

    const params: Record<string, string> = { code: input.code, state: input.state };
    if (input.iss) params.iss = input.iss;

    const callbackParams = oauth.validateAuthResponse(
      as,
      this.client,
      new URLSearchParams(params),
      input.state,
    );

    const response = await oauth.authorizationCodeGrantRequest(
      as,
      this.client,
      this.clientAuth,
      callbackParams,
      input.redirectUri,
      input.codeVerifier,
    );

    let result;
    try {
      result = await oauth.processAuthorizationCodeResponse(
        as,
        this.client,
        response,
      );
    } catch (err) {
      // oauth4webapi's ResponseBodyError hides details — surface them
      if (err instanceof oauth.ResponseBodyError) {
        throw new Error(
          `Microsoft token exchange failed: ${err.error}${err.error_description ? ` — ${err.error_description}` : ""}`,
        );
      }
      throw err;
    }

    return tokenSetFromResponse(result);
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    const as = await this.getAuthorizationServer();

    const response = await oauth.refreshTokenGrantRequest(
      as,
      this.client,
      this.clientAuth,
      refreshToken,
    );

    const result = await oauth.processRefreshTokenResponse(
      as,
      this.client,
      response,
    );

    return tokenSetFromResponse(result);
  }
}
