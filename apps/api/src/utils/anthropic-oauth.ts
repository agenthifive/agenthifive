/**
 * Anthropic OAuth token refresh.
 *
 * Uses the same public client_id and token endpoint as pi-ai / OpenClaw.
 * Refresh tokens issued by Anthropic's OAuth flow are bound to this client_id,
 * so we must use the same one to refresh them.
 */

const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface AnthropicTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute ms timestamp when the access token expires */
  expiresAt: number;
}

/**
 * Refresh an Anthropic OAuth access token.
 * Returns the new access token, refresh token (rotated), and expiry.
 */
export async function refreshAnthropicToken(
  refreshToken: string,
): Promise<AnthropicTokenSet> {
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic token refresh failed (${response.status}): ${error}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // 5 min buffer before actual expiry (matches pi-ai behavior)
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}
