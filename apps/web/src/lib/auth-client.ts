// @ts-nocheck — TS2742: better-auth internal types aren't portable across
// the enterprise repo's node_modules layout. This file is a thin wrapper
// around createAuthClient; the types are correct at runtime.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  basePath: "/api/auth",
});

export const { useSession, signIn, signUp, signOut } = authClient;
