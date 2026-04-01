import { randomUUID, randomBytes, createHash } from "node:crypto";
import { encrypt, generateEncryptionKey } from "@agenthifive/security";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from "jose";

/**
 * Test encryption key for consistent test data
 * Generated once at module load time
 */
export const TEST_ENCRYPTION_KEY = generateEncryptionKey();

/**
 * Creates encrypted token payload for test connections
 */
export function createMockTokens(tokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}) {
  const payload = JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || null,
    expiresAt: tokens.expiresAt || new Date(Date.now() + 3600000).toISOString(),
  });
  return JSON.stringify(encrypt(payload, TEST_ENCRYPTION_KEY));
}

/**
 * Factory: Create test workspace
 */
export function createTestWorkspace(overrides: Partial<{
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: randomUUID(),
    name: "Test Workspace",
    ownerId: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Factory: Create test agent
 */
export function createTestAgent(workspaceId: string, overrides: Partial<{
  id: string;
  name: string;
  description: string;
  status: "created" | "active" | "disabled";
  publicKeyJwk: Record<string, unknown> | null;
  enrolledAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: randomUUID(),
    workspaceId,
    name: "Test Agent",
    description: "Test agent for unit tests",
    status: "active" as const,
    publicKeyJwk: null,
    enrolledAt: null,
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Generate an ES256 key pair for testing agent auth
 */
export async function createTestAgentKeyPair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return {
    privateKey: await exportJWK(privateKey) as JWK,
    publicKey: await exportJWK(publicKey) as JWK,
    privateKeyObj: privateKey,
    publicKeyObj: publicKey,
  };
}

/**
 * Create a signed client assertion JWT for testing
 */
export async function createTestClientAssertion(
  privateKey: KeyLike,
  agentId: string,
  overrides: Partial<{
    audience: string;
    expiresInSeconds: number;
    jti: string;
    issuer: string;
  }> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(overrides.issuer ?? agentId)
    .setSubject(agentId)
    .setAudience(overrides.audience ?? "http://localhost:4000")
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expiresInSeconds ?? 30))
    .setJti(overrides.jti ?? randomUUID())
    .sign(privateKey);
}

/**
 * Create a test bootstrap secret and its hash
 */
export function createTestBootstrapSecret() {
  const secret = `ah5b_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(secret).digest("hex");
  return { secret, hash };
}

/**
 * Create a test agent access token and its hash
 */
export function createTestAccessToken() {
  const token = `ah5t_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

/** Service names matching the serviceEnum in db/schema/enums.ts */
export type ServiceName = "google-gmail" | "google-calendar" | "google-drive" | "google-sheets" | "google-docs" | "microsoft-teams" | "microsoft-outlook-mail" | "microsoft-outlook-calendar" | "telegram" | "slack" | "anthropic-messages" | "openai" | "gemini";

/**
 * Factory: Create test connection
 */
export function createTestConnection(workspaceId: string, overrides: Partial<{
  id: string;
  provider: "google" | "microsoft" | "telegram" | "slack" | "anthropic" | "openai" | "gemini";
  service: ServiceName;
  label: string;
  status: "healthy" | "needs_reauth" | "revoked";
  encryptedTokens: string;
  grantedScopes: string[];
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: randomUUID(),
    workspaceId,
    provider: "google" as const,
    service: "google-gmail" as const,
    label: "Test Connection",
    status: "healthy" as const,
    encryptedTokens: createMockTokens({
      accessToken: "mock_access_token",
      refreshToken: "mock_refresh_token",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Factory: Create test pending connection
 */
export function createTestPendingConnection(overrides: Partial<{
  id: string;
  provider: "google" | "microsoft" | "telegram";
  service: ServiceName;
  workspaceId: string;
  state: string;
  codeVerifier: string;
  scopes: string[];
  label: string;
  metadata: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
}> = {}) {
  return {
    id: randomUUID(),
    provider: "google" as const,
    service: "google-gmail" as const,
    workspaceId: overrides.workspaceId ?? randomUUID(),
    state: randomBytes(16).toString("hex"),
    codeVerifier: randomBytes(32).toString("base64url"),
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    label: "Test Pending Connection",
    metadata: null,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Factory: Create test policy
 */
export function createTestPolicy(agentId: string, connectionId: string, overrides: Partial<{
  id: string;
  allowedModels: ("A" | "B")[];
  defaultMode: "read_only" | "read_write" | "custom";
  stepUpApproval: "always" | "risk_based" | "never";
  allowlists: Array<{
    baseUrl: string;
    methods: string[];
    pathPatterns: string[];
  }>;
  rateLimits: {
    maxRequestsPerHour: number;
    maxPayloadSizeBytes: number;
    maxResponseSizeBytes: number;
  } | null;
  timeWindows: Array<{
    dayOfWeek: number;
    startHour: number;
    endHour: number;
    timezone: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: randomUUID(),
    agentId,
    connectionId,
    allowedModels: ["A", "B"] as ("A" | "B")[],
    defaultMode: "read_only" as const,
    stepUpApproval: "risk_based" as const,
    allowlists: [],
    rateLimits: null,
    timeWindows: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Factory: Create test approval request
 */
export function createTestApprovalRequest(agentId: string, connectionId: string, overrides: Partial<{
  id: string;
  status: "pending" | "approved" | "denied" | "expired";
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  metadata: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
  resolvedAt: Date | null;
}> = {}) {
  return {
    id: randomUUID(),
    agentId,
    connectionId,
    status: "pending" as const,
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    requestHeaders: { "content-type": "application/json" },
    requestBody: JSON.stringify({ to: "test@example.com", subject: "Test" }),
    metadata: null,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    createdAt: new Date(),
    resolvedAt: null,
    ...overrides,
  };
}

/**
 * Factory: Create test audit event
 */
export function createTestAuditEvent(overrides: Partial<{
  id: string;
  timestamp: Date;
  actor: string;
  agentId: string | null;
  connectionId: string | null;
  action: string;
  decision: "allowed" | "denied" | "error";
  metadata: Record<string, unknown> | null;
}> = {}) {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    actor: randomUUID(),
    agentId: null,
    connectionId: null,
    action: "token_vended",
    decision: "allowed" as const,
    metadata: null,
    ...overrides,
  };
}

/**
 * Factory: Create test JWT claims
 */
export function createTestJwtClaims(overrides: Partial<{
  sub: string;
  wid: string;
  roles: string[];
  scp: string[];
  sid: string;
  iat: number;
  exp: number;
}> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: randomUUID(),
    wid: randomUUID(),
    roles: ["owner"],
    scp: ["connections:read", "connections:write", "vault:execute"],
    sid: randomUUID(),
    iat: now,
    exp: now + 300, // 5 minutes
    ...overrides,
  };
}

/**
 * Factory: Create OAuth token response (for mocking provider APIs)
 */
export function createMockOAuthTokenResponse(overrides: Partial<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}> = {}) {
  return {
    access_token: "mock_access_token_" + randomBytes(8).toString("hex"),
    refresh_token: "mock_refresh_token_" + randomBytes(8).toString("hex"),
    expires_in: 3600,
    token_type: "Bearer",
    scope: "openid email profile",
    ...overrides,
  };
}

/**
 * Factory: Create Telegram bot info (for mocking Telegram getMe API)
 */
export function createMockTelegramBotInfo(overrides: Partial<{
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
}> = {}) {
  return {
    ok: true,
    result: {
      id: 123456789,
      is_bot: true,
      first_name: "Test Bot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      ...overrides,
    },
  };
}
