import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

const connectionString =
  process.env["DATABASE_URL"] ??
  "postgresql://agenthifive:dev-password@localhost:5432/agenthifive";

const logLevel = process.env["LOG_LEVEL"] || "info";
const isDebug = logLevel === "debug" || logLevel === "trace";

const sql = postgres(connectionString);

export const db = drizzle(sql, {
  schema,
  logger: isDebug
    ? {
        logQuery(query: string, params: unknown[]) {
          // Pino-compatible JSON to stdout (level 20 = debug).
          // Can't import Fastify's Pino here (circular dep), so write directly.
          process.stdout.write(
            JSON.stringify({
              level: 20,
              time: new Date().toISOString(),
              msg: "db.query",
              query: query.length > 300 ? query.slice(0, 300) + "..." : query,
              paramCount: params.length,
            }) + "\n",
          );
        },
      }
    : false,
});

export { sql };
