/**
 * E2E DB Seeder
 *
 * Inserts test data (workspace, agent, connections, policies) directly into
 * PostgreSQL using Drizzle ORM. Reuses the same schema definitions and
 * encryption helpers as the API.
 */
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { encrypt } from "@agenthifive/security";

// Import schema tables directly
import { workspaces } from "../../../../apps/api/src/db/schema/workspaces.js";
import { agents } from "../../../../apps/api/src/db/schema/agents.js";
import { agentBootstrapSecrets } from "../../../../apps/api/src/db/schema/agent-bootstrap-secrets.js";
import { connections } from "../../../../apps/api/src/db/schema/connections.js";
import { policies } from "../../../../apps/api/src/db/schema/policies.js";

const ENCRYPTION_KEY =
  process.env["ENCRYPTION_KEY"] ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export interface SeedResult {
  workspaceId: string;
  ownerId: string;
  agentId: string;
  bootstrapSecret: string;
  telegramConnectionId: string;
  openaiConnectionId: string;
  telegramPolicyId: string;
  openaiPolicyId: string;
  restrictivePolicyId: string;
}

function createEncryptedTokens(tokens: Record<string, unknown>): string {
  const payload = JSON.stringify(tokens);
  return JSON.stringify(encrypt(payload, ENCRYPTION_KEY));
}

export async function seedDatabase(): Promise<SeedResult> {
  const connectionString =
    process.env["DATABASE_URL"] ||
    "postgresql://agenthifive:test-password@postgres:5432/agenthifive_test";
  const sql = postgres(connectionString);
  const db = drizzle(sql);

  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const agentId = randomUUID();
  const telegramConnectionId = randomUUID();
  const openaiConnectionId = randomUUID();
  const telegramPolicyId = randomUUID();
  const openaiPolicyId = randomUUID();
  const restrictivePolicyId = randomUUID();

  // Bootstrap secret
  const bootstrapSecret = `ah5b_${randomBytes(32).toString("base64url")}`;
  const bootstrapSecretHash = createHash("sha256")
    .update(bootstrapSecret)
    .digest("hex");

  // 1. Create workspace
  await db.insert(workspaces).values({
    id: workspaceId,
    name: "E2E Test Workspace",
    ownerId,
  });

  // 2. Create agent (status: "created" — awaiting bootstrap)
  await db.insert(agents).values({
    id: agentId,
    name: "E2E Test Agent",
    description: "Agent for E2E integration tests",
    status: "created",
    workspaceId,
  });

  // 3. Create bootstrap secret
  await db.insert(agentBootstrapSecrets).values({
    agentId,
    type: "bootstrap",
    secretHash: bootstrapSecretHash,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
  });

  // 4. Create Telegram connection (bot token)
  await db.insert(connections).values({
    id: telegramConnectionId,
    provider: "telegram",
    service: "telegram",
    label: "E2E Telegram Bot",
    status: "healthy",
    workspaceId,
    encryptedTokens: createEncryptedTokens({
      botToken: "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ",
    }),
    grantedScopes: ["bot"],
  });

  // 5. Create OpenAI connection (API key)
  await db.insert(connections).values({
    id: openaiConnectionId,
    provider: "openai",
    service: "openai",
    label: "E2E OpenAI",
    status: "healthy",
    workspaceId,
    encryptedTokens: createEncryptedTokens({
      apiKey: "sk-test-mock-openai-api-key-for-e2e",
    }),
    grantedScopes: ["api"],
  });

  // 6. Create policy: Telegram — allow Model B to echo server
  await db.insert(policies).values({
    id: telegramPolicyId,
    agentId,
    connectionId: telegramConnectionId,
    allowedModels: ["A", "B"],
    defaultMode: "read_write",
    stepUpApproval: "never",
    allowlists: [
      {
        baseUrl: "http://echo:8080",
        methods: ["GET", "POST", "PUT", "DELETE"],
        pathPatterns: ["/**"],
      },
    ],
    rateLimits: null,
    timeWindows: [],
    rules: { request: [], response: [] },
  });

  // 7. Create policy: OpenAI — allow Model A credential resolution
  await db.insert(policies).values({
    id: openaiPolicyId,
    agentId,
    connectionId: openaiConnectionId,
    allowedModels: ["A"],
    defaultMode: "read_only",
    stepUpApproval: "never",
    allowlists: [],
    rateLimits: null,
    timeWindows: [],
    rules: { request: [], response: [] },
  });

  // 8. Create restrictive policy: Telegram — only GET on /allowed
  //    (uses a separate connection for policy-denial tests)
  await db.insert(policies).values({
    id: restrictivePolicyId,
    agentId,
    connectionId: telegramConnectionId,
    status: "revoked", // Revoked by default — tests activate when needed
    allowedModels: ["B"],
    defaultMode: "read_only",
    stepUpApproval: "never",
    allowlists: [
      {
        baseUrl: "http://echo:8080",
        methods: ["GET"],
        pathPatterns: ["/allowed"],
      },
    ],
    rateLimits: null,
    timeWindows: [],
    rules: { request: [], response: [] },
  });

  await sql.end();

  return {
    workspaceId,
    ownerId,
    agentId,
    bootstrapSecret,
    telegramConnectionId,
    openaiConnectionId,
    telegramPolicyId,
    openaiPolicyId,
    restrictivePolicyId,
  };
}
