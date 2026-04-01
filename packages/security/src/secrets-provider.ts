/**
 * Pluggable secrets management abstraction.
 * Allows different backends for different environments:
 * - EnvSecretsProvider: environment variables (dev/self-hosted simple)
 * - AwsSecretsProvider: AWS Secrets Manager (SaaS production)
 * - VaultSecretsProvider: HashiCorp Vault (self-hosted enterprise)
 *
 * Selected via SECRETS_PROVIDER environment variable.
 */

/** Interface for secrets management backends */
export interface SecretsProvider {
  /** Retrieve a secret by key. Returns undefined if not found. */
  getSecret(key: string): Promise<string | undefined>;
  /** Store or update a secret by key. */
  setSecret(key: string, value: string): Promise<void>;
}

/**
 * EnvSecretsProvider — reads secrets from environment variables.
 * For dev/local and simple self-hosted deployments.
 *
 * Key mapping: dots and slashes are converted to underscores and uppercased.
 * e.g., "oauth/google.client_id" → "OAUTH_GOOGLE_CLIENT_ID"
 */
export class EnvSecretsProvider implements SecretsProvider {
  async getSecret(key: string): Promise<string | undefined> {
    const envKey = this.normalizeKey(key);
    return process.env[envKey];
  }

  async setSecret(key: string, value: string): Promise<void> {
    const envKey = this.normalizeKey(key);
    process.env[envKey] = value;
  }

  private normalizeKey(key: string): string {
    return key.replace(/[./]/g, "_").toUpperCase();
  }
}

/**
 * AwsSecretsProvider — reads/writes secrets using AWS Secrets Manager.
 * For SaaS production deployments on AWS.
 *
 * Requires @aws-sdk/client-secrets-manager as a peer dependency.
 * Region configured via AWS_REGION environment variable or constructor option.
 */
export class AwsSecretsProvider implements SecretsProvider {
  private client: AwsSecretsManagerClient | undefined;
  private readonly region: string;
  private readonly prefix: string;

  constructor(options?: { region?: string; prefix?: string }) {
    this.region = options?.region ?? process.env["AWS_REGION"] ?? "us-east-1";
    this.prefix = options?.prefix ?? "agenthifive/";
  }

  async getSecret(key: string): Promise<string | undefined> {
    const client = await this.getClient();
    const secretId = this.prefix + key;

    try {
      const response = await client.getSecretValue(secretId);
      return response;
    } catch (err: unknown) {
      if (isAwsNotFoundError(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async setSecret(key: string, value: string): Promise<void> {
    const client = await this.getClient();
    const secretId = this.prefix + key;

    try {
      await client.putSecretValue(secretId, value);
    } catch (err: unknown) {
      if (isAwsNotFoundError(err)) {
        await client.createSecret(secretId, value);
        return;
      }
      throw err;
    }
  }

  private async getClient(): Promise<AwsSecretsManagerClient> {
    if (!this.client) {
      this.client = await createAwsClient(this.region);
    }
    return this.client;
  }
}

/**
 * Minimal AWS Secrets Manager client interface.
 * Keeps the actual SDK as an optional peer dependency — loaded dynamically.
 */
interface AwsSecretsManagerClient {
  getSecretValue(secretId: string): Promise<string | undefined>;
  putSecretValue(secretId: string, value: string): Promise<void>;
  createSecret(secretId: string, value: string): Promise<void>;
}

async function createAwsClient(region: string): Promise<AwsSecretsManagerClient> {
  // Dynamic import to keep @aws-sdk as optional peer dependency.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;

  try {
    // Use variable to prevent TypeScript from resolving this at compile time.
    // The SDK is an optional peer dependency loaded at runtime.
    const moduleName = "@aws-sdk/client-secrets-manager";
    sdk = await import(/* webpackIgnore: true */ moduleName);
  } catch {
    throw new Error(
      "AwsSecretsProvider requires @aws-sdk/client-secrets-manager. " +
      "Install it: pnpm add @aws-sdk/client-secrets-manager"
    );
  }

  const client = new sdk.SecretsManagerClient({ region });

  return {
    async getSecretValue(secretId: string): Promise<string | undefined> {
      const response = await client.send(new sdk.GetSecretValueCommand({ SecretId: secretId }));
      return response.SecretString;
    },
    async putSecretValue(secretId: string, value: string): Promise<void> {
      await client.send(new sdk.PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
    },
    async createSecret(secretId: string, value: string): Promise<void> {
      await client.send(new sdk.CreateSecretCommand({ Name: secretId, SecretString: value }));
    },
  };
}

function isAwsNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error &&
    ("name" in err && (err.name === "ResourceNotFoundException" || err.name === "SecretNotFoundException"))
  );
}

/**
 * VaultSecretsProvider — reads/writes secrets using HashiCorp Vault KV v2.
 * For self-hosted enterprise deployments.
 *
 * Uses HTTP API directly (no external dependency required).
 * Requires VAULT_ADDR and VAULT_TOKEN environment variables.
 */
export class VaultSecretsProvider implements SecretsProvider {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly mountPath: string;

  constructor(options?: { endpoint?: string; token?: string; mountPath?: string }) {
    this.endpoint = options?.endpoint ?? process.env["VAULT_ADDR"] ?? "http://127.0.0.1:8200";
    this.token = options?.token ?? process.env["VAULT_TOKEN"] ?? "";
    this.mountPath = options?.mountPath ?? "secret";

    if (!this.token) {
      throw new Error("VaultSecretsProvider requires VAULT_TOKEN environment variable or token option");
    }
  }

  async getSecret(key: string): Promise<string | undefined> {
    const url = `${this.endpoint}/v1/${this.mountPath}/data/${key}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Vault-Token": this.token,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Vault GET ${key} failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { data?: { data?: { value?: string } } };
    return body.data?.data?.value;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const url = `${this.endpoint}/v1/${this.mountPath}/data/${key}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Vault-Token": this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: { value } }),
    });

    if (!response.ok) {
      throw new Error(`Vault PUT ${key} failed: ${response.status} ${response.statusText}`);
    }
  }
}

/**
 * Create a SecretsProvider based on SECRETS_PROVIDER environment variable.
 *
 * Supported values:
 * - "env" (default): EnvSecretsProvider
 * - "aws": AwsSecretsProvider
 * - "vault": VaultSecretsProvider
 */
export function createSecretsProvider(provider?: string): SecretsProvider {
  const providerName = provider ?? process.env["SECRETS_PROVIDER"] ?? "env";

  switch (providerName) {
    case "env":
      return new EnvSecretsProvider();
    case "aws":
      return new AwsSecretsProvider();
    case "vault":
      return new VaultSecretsProvider();
    default:
      throw new Error(`Unknown secrets provider: ${providerName}. Supported: env, aws, vault`);
  }
}
