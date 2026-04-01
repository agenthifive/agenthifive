import type {
  OAuthProvider,
  OAuthTokenSet,
  Scope,
} from "@agenthifive/contracts";

/**
 * Provider Capabilities
 */
export interface ProviderCapabilities {
  provider: OAuthProvider;
  supportsAuthCode: boolean;
  supportsPkce: boolean;
}

/**
 * Authorization Code Flow - Start
 */
export interface AuthCodeStartInput {
  redirectUri: string;
  scopes: Scope[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export interface AuthCodeStartOutput {
  authorizationUrl: string;
}

/**
 * Authorization Code Flow - Exchange
 */
export interface AuthCodeExchangeInput {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  /** RFC 9207 issuer identifier from the authorization response callback. */
  iss?: string;
}

/**
 * OAuth Connector Interface
 * Abstraction over oauth4webapi for each provider
 */
export interface OAuthConnector {
  capabilities(): ProviderCapabilities;

  createAuthorizationUrl(
    input: AuthCodeStartInput,
  ): Promise<AuthCodeStartOutput>;

  exchangeAuthorizationCode(
    input: AuthCodeExchangeInput,
  ): Promise<OAuthTokenSet>;

  refresh(refreshToken: string): Promise<OAuthTokenSet>;
}
