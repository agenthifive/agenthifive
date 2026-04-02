import {
  GoogleConnector,
  MicrosoftConnector,
  type MicrosoftConnectorConfig,
  type OAuthConnector,
} from "@agenthifive/oauth-connectors";
import { decrypt, type EncryptedPayload } from "@agenthifive/security";
import { db } from "../db/client";
import { workspaceOauthApps } from "../db/schema/workspace-oauth-apps";
import { eq, and } from "drizzle-orm";

import { getEncryptionKey } from "../services/encryption-key";

interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
  tenantId?: string;
}

/**
 * Build an OAuthConnector from corporate env vars.
 * Returns null if the env vars are not set for this provider.
 */
function getCorporateConnector(provider: string): OAuthConnector | null {
  switch (provider) {
    case "google": {
      const clientId = process.env["GOOGLE_CLIENT_ID"];
      const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      return new GoogleConnector({ clientId, clientSecret });
    }
    case "microsoft": {
      const clientId = process.env["MICROSOFT_CLIENT_ID"];
      const clientSecret = process.env["MICROSOFT_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      const config: MicrosoftConnectorConfig = { clientId, clientSecret };
      const tenantId = process.env["MICROSOFT_TENANT_ID"];
      if (tenantId) config.tenantId = tenantId;
      return new MicrosoftConnector(config);
    }
    default:
      return null;
  }
}

/**
 * Build an OAuthConnector from explicit credentials.
 */
function buildConnector(
  provider: string,
  creds: OAuthAppCredentials,
): OAuthConnector {
  switch (provider) {
    case "google":
      return new GoogleConnector({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });
    case "microsoft": {
      const config: MicrosoftConnectorConfig = {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      };
      if (creds.tenantId) config.tenantId = creds.tenantId;
      return new MicrosoftConnector(config);
    }
    default:
      throw new Error(`Unsupported OAuth provider: ${provider}`);
  }
}

/**
 * Decrypt a workspace OAuth app's client secret and build credentials.
 */
function decryptAppCredentials(app: {
  clientId: string;
  encryptedClientSecret: string;
  tenantId: string | null;
}): OAuthAppCredentials {
  const clientSecret = decrypt(
    JSON.parse(app.encryptedClientSecret) as EncryptedPayload,
    getEncryptionKey(),
  );
  const result: OAuthAppCredentials = { clientId: app.clientId, clientSecret };
  if (app.tenantId) result.tenantId = app.tenantId;
  return result;
}

/**
 * Resolve an OAuthConnector for a provider.
 *
 * Resolution order:
 * 1. If oauthAppId given → use that specific workspace OAuth app (for token refresh)
 * 2. If corporate env vars set → use those
 * 3. If workspaceId given → look up workspace BYA app
 * 4. Throw with clear error
 *
 * Returns `{ connector, oauthAppId }` so callers can store the app ID on new connections.
 */
export async function resolveConnector(opts: {
  provider: string;
  oauthAppId?: string | null | undefined;
  workspaceId?: string | undefined;
}): Promise<{ connector: OAuthConnector; oauthAppId: string | null }> {
  const { provider, oauthAppId, workspaceId } = opts;

  // 1. Specific OAuth app ID (from connection.oauthAppId during refresh)
  if (oauthAppId) {
    const [app] = await db
      .select()
      .from(workspaceOauthApps)
      .where(eq(workspaceOauthApps.id, oauthAppId))
      .limit(1);

    if (!app) {
      throw new Error(
        `OAuth app ${oauthAppId} not found (may have been deleted). ` +
          `The connection needs to be re-authenticated with valid OAuth credentials.`,
      );
    }

    const creds = decryptAppCredentials(app);
    return { connector: buildConnector(provider, creds), oauthAppId };
  }

  // 2. Corporate env vars
  const corporate = getCorporateConnector(provider);
  if (corporate) {
    return { connector: corporate, oauthAppId: null };
  }

  // 3. Workspace BYA app
  if (workspaceId) {
    const [app] = await db
      .select()
      .from(workspaceOauthApps)
      .where(
        and(
          eq(workspaceOauthApps.workspaceId, workspaceId),
          eq(workspaceOauthApps.provider, provider as "google" | "microsoft"),
        ),
      )
      .limit(1);

    if (app) {
      const creds = decryptAppCredentials(app);
      return { connector: buildConnector(provider, creds), oauthAppId: app.id };
    }
  }

  const err = new Error(
    `No OAuth credentials available for provider "${provider}". ` +
      `Add your own OAuth app in Settings → Apps.`,
  );
  (err as Error & { statusCode: number; hint: string }).statusCode = 400;
  (err as Error & { statusCode: number; hint: string }).hint =
    `Go to Settings → Apps and add your ${provider === "google" ? "Google" : "Microsoft"} OAuth credentials (Client ID and Client Secret). ` +
    `This is required to connect ${provider === "google" ? "Google" : "Microsoft"} services.`;
  throw err;
}

/**
 * Check whether OAuth credentials exist for a provider in a given workspace.
 * Used by the capabilities endpoint to tell the frontend what's available.
 */
export async function hasOAuthCredentials(
  provider: string,
  workspaceId: string,
): Promise<{ available: boolean; source: "corporate" | "bya" | null }> {
  // Corporate takes priority
  const hasCorporate = getCorporateConnector(provider) !== null;
  if (hasCorporate) {
    return { available: true, source: "corporate" };
  }

  // Check workspace BYA app
  const [app] = await db
    .select({ id: workspaceOauthApps.id })
    .from(workspaceOauthApps)
    .where(
      and(
        eq(workspaceOauthApps.workspaceId, workspaceId),
        eq(workspaceOauthApps.provider, provider as "google" | "microsoft"),
      ),
    )
    .limit(1);

  if (app) {
    return { available: true, source: "bya" };
  }

  return { available: false, source: null };
}
