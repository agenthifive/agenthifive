import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".agenthifive");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface CliConfig {
  /** Base URL of the AgentHiFive API */
  apiUrl: string;
  /** Stored API key or JWT for authentication */
  apiKey?: string;
  /** Base URL of the AgentHiFive web app (for device flow login) */
  webUrl?: string;
}

const DEFAULT_CONFIG: CliConfig = {
  apiUrl: "http://localhost:8080",
  webUrl: "http://localhost:3000",
};

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): CliConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) as Partial<CliConfig> };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function getApiKey(): string {
  const envKey = process.env.AH5_API_KEY;
  if (envKey) return envKey;

  const config = loadConfig();
  if (config.apiKey) return config.apiKey;

  console.error("Error: Not authenticated. Run `ah5 login` or set AH5_API_KEY environment variable.");
  process.exit(1);
}

export function getApiUrl(): string {
  return process.env.AH5_API_URL ?? loadConfig().apiUrl;
}

export function getWebUrl(): string {
  return process.env.AH5_WEB_URL ?? loadConfig().webUrl ?? "http://localhost:3000";
}
