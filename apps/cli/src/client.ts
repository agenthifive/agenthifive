import { AgentHiFiveClient, AgentHiFiveError } from "@agenthifive/sdk";
import { getApiKey, getApiUrl } from "./config.js";

export function createClient(): AgentHiFiveClient {
  return new AgentHiFiveClient({
    baseUrl: getApiUrl(),
    bearerToken: getApiKey(),
  });
}

export function handleError(err: unknown): never {
  if (err instanceof AgentHiFiveError) {
    console.error(`Error (${err.statusCode}): ${err.message}`);
    if (err.auditId) console.error(`  Audit ID: ${err.auditId}`);
    if (err.retryAfter) console.error(`  Retry after: ${err.retryAfter}s`);
  } else if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error("An unexpected error occurred");
  }
  process.exit(1);
}
