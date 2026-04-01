import { createAuthClient } from "better-auth/react";

export const authClient: ReturnType<typeof createAuthClient> = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  basePath: "/api/auth",
});

export const { useSession, signIn, signUp, signOut } = authClient;
