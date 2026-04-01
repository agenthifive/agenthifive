import * as oauth from "oauth4webapi";
import type { OAuthTokenSet } from "@agenthifive/contracts";
import type {
  OAuthConnector,
  ProviderCapabilities,
  AuthCodeStartInput,
  AuthCodeStartOutput,
  AuthCodeExchangeInput,
} from "./types.js";

const GOOGLE_ISSUER = new URL("https://accounts.google.com");

/**
 * Default Google Workspace scopes for AgentHiFive MVP.
 */
export const GOOGLE_SCOPES = {
  GMAIL_READONLY: "https://www.googleapis.com/auth/gmail.readonly",
  GMAIL_SEND: "https://www.googleapis.com/auth/gmail.send",
  CALENDAR_READONLY: "https://www.googleapis.com/auth/calendar.readonly",
  CALENDAR_EVENTS: "https://www.googleapis.com/auth/calendar.events",
  DRIVE_READONLY: "https://www.googleapis.com/auth/drive.readonly",
  DRIVE_FILE: "https://www.googleapis.com/auth/drive.file",
} as const;

export interface GoogleConnectorConfig {
  clientId: string;
  clientSecret: string;
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

export class GoogleConnector implements OAuthConnector {
  private readonly config: GoogleConnectorConfig;
  private readonly client: oauth.Client;
  private readonly clientAuth: oauth.ClientAuth;
  private asCache: oauth.AuthorizationServer | null = null;

  constructor(config: GoogleConnectorConfig) {
    this.config = config;
    this.client = { client_id: config.clientId };
    this.clientAuth = oauth.ClientSecretPost(config.clientSecret);
  }

  capabilities(): ProviderCapabilities {
    return {
      provider: "google",
      supportsAuthCode: true,
      supportsPkce: true,
    };
  }

  private async getAuthorizationServer(): Promise<oauth.AuthorizationServer> {
    if (this.asCache) return this.asCache;

    const response = await oauth.discoveryRequest(GOOGLE_ISSUER, {
      algorithm: "oidc",
    });
    this.asCache = await oauth.processDiscoveryResponse(
      GOOGLE_ISSUER,
      response,
    );
    return this.asCache;
  }

  async createAuthorizationUrl(
    input: AuthCodeStartInput,
  ): Promise<AuthCodeStartOutput> {
    const as = await this.getAuthorizationServer();

    if (!as.authorization_endpoint) {
      throw new Error("Google authorization_endpoint not found in metadata");
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
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");

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

    const result = await oauth.processAuthorizationCodeResponse(
      as,
      this.client,
      response,
    );

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
