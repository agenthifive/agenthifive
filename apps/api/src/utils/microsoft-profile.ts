/**
 * Utility to fetch Microsoft user profile information from Microsoft Graph API.
 * Used after OAuth token exchange to show account email and tenant info on connection cards.
 */

export interface MicrosoftProfileInfo {
  /** Microsoft account email (mail or userPrincipalName) */
  email: string;
  /** Display name */
  displayName: string;
  /** Tenant ID from the token's tid claim or organization info */
  tenantId?: string;
}

/**
 * Fetch the signed-in user's profile from Microsoft Graph API.
 * Returns email, display name, and tenant info for display on connection cards.
 */
export async function fetchMicrosoftProfile(
  accessToken: string,
): Promise<MicrosoftProfileInfo | null> {
  try {
    const response = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
    };

    const email =
      data.mail || data.userPrincipalName || "unknown@microsoft.com";
    const displayName = data.displayName || email;

    // Try to extract tenant ID from the access token (JWT)
    let tenantId: string | undefined;
    try {
      const parts = accessToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1]!, "base64url").toString("utf-8"),
        ) as { tid?: string };
        tenantId = payload.tid;
      }
    } catch {
      // Ignore JWT parsing errors — tenantId is optional
    }

    const result: MicrosoftProfileInfo = {
      email,
      displayName,
    };
    if (tenantId !== undefined) {
      result.tenantId = tenantId;
    }
    return result;
  } catch {
    return null;
  }
}
