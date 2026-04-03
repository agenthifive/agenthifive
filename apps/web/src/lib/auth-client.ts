import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  basePath: "/v1/auth",
});

export const { useSession, signIn, signUp, signOut } = authClient;
