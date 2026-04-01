/**
 * Better Auth configuration for Fastify.
 *
 * Moved from apps/web/src/lib/auth.ts to consolidate all server-side auth
 * in Fastify — reduces attack surface by removing DB access and signing keys
 * from the web app (now a static SPA).
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { db, sql } from "../db/client";
import { users, sessions, accounts, verifications } from "../db/schema/users";
import { sendEmail } from "../services/email";
import {
  resetPasswordTemplate,
  verifyEmailTemplate,
} from "../services/email-templates";

const authSchema = { users, sessions, accounts, verifications };

export const auth = betterAuth({
  appName: "AgentHiFive",
  baseURL: process.env["WEB_URL"] ?? "http://localhost:3000",
  basePath: "/api/auth",
  secret: process.env["BETTER_AUTH_SECRET"],
  onAPIError: {
    // Redirect OAuth errors (state_mismatch, etc.) to the login page
    // instead of Better Auth's built-in /error page.
    errorURL: "/login",
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
    usePlural: true,
  }),
  advanced: {
    database: {
      generateId: "uuid",
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "microsoft", "apple", "facebook"],
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    sendResetPassword: async ({ user, url }) => {
      sendEmail(
        user.email,
        "Reset your AgentHiFive password",
        resetPasswordTemplate(user.name, url),
      ).catch((err) => console.error("Reset email failed:", err));
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      // Better Auth's url points to /api/auth/verify-email?token=...&callbackURL=...
      // After server-side verification, it redirects to callbackURL.
      // Rewrite to land on /login with a success banner.
      const verifyUrl = new URL(url);
      verifyUrl.searchParams.set("callbackURL", "/login?verified=true");
      sendEmail(
        user.email,
        "Verify your AgentHiFive email",
        verifyEmailTemplate(user.name, verifyUrl.toString()),
      ).catch((err) => console.error("Verification email failed:", err));
    },
  },
  socialProviders: {
    google: {
      clientId: process.env["AUTH_GOOGLE_CLIENT_ID"] || process.env["GOOGLE_CLIENT_ID"] || "",
      clientSecret: process.env["AUTH_GOOGLE_CLIENT_SECRET"] || process.env["GOOGLE_CLIENT_SECRET"] || "",
      enabled: Boolean(process.env["AUTH_GOOGLE_CLIENT_ID"] || process.env["GOOGLE_CLIENT_ID"]),
      prompt: "select_account",
    },
    microsoft: {
      clientId: process.env["AUTH_MICROSOFT_CLIENT_ID"] || process.env["MICROSOFT_CLIENT_ID"] || "",
      clientSecret: process.env["AUTH_MICROSOFT_CLIENT_SECRET"] || process.env["MICROSOFT_CLIENT_SECRET"] || "",
      tenantId: process.env["AUTH_MICROSOFT_TENANT_ID"] || process.env["MICROSOFT_TENANT_ID"] || "common",
      enabled: Boolean(process.env["AUTH_MICROSOFT_CLIENT_ID"] || process.env["MICROSOFT_CLIENT_ID"]),
      prompt: "select_account",
      async mapProfileToUser(profile) {
        // Azure AD may omit the email claim from the ID token depending on
        // tenant config. Fall back to preferred_username (UPN) which is
        // always present for organizational accounts.
        if (!profile.email && profile.preferred_username) {
          return { email: profile.preferred_username as string };
        }
        return {};
      },
    },
    apple: {
      clientId: process.env["APPLE_CLIENT_ID"] ?? "",
      clientSecret: process.env["APPLE_CLIENT_SECRET"] ?? "",
      enabled: Boolean(process.env["APPLE_CLIENT_ID"]),
    },
    facebook: {
      clientId: process.env["FACEBOOK_CLIENT_ID"] ?? "",
      clientSecret: process.env["FACEBOOK_CLIENT_SECRET"] ?? "",
      enabled: Boolean(process.env["FACEBOOK_CLIENT_ID"]),
    },
  },
  session: {
    expiresIn: 60 * 60 * 24, // 1 day
    cookieCache: {
      enabled: true,
      maxAge: 60, // 60 seconds — keep short for fast session revocation
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Auto-create a personal workspace for every new user
          const name = `${user.name}'s Workspace`;
          await sql`
            INSERT INTO t_workspaces (id, name, owner_id, created_at, updated_at)
            VALUES (gen_random_uuid(), ${name}, ${user.id}, now(), now())
          `;
        },
      },
    },
  },
  plugins: [expo()],
  trustedOrigins:
    process.env["NODE_ENV"] !== "production"
      ? (request?: Request) => {
          // Dev: trust any origin (emulators hit via WSL IP, etc.)
          const origin = request?.headers.get("origin");
          return ["agenthifive://", "exp://", ...(origin ? [origin] : [])];
        }
      : ["agenthifive://"],
});

export const nodeHandler = toNodeHandler(auth);
export { fromNodeHeaders };
