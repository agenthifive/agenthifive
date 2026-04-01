import { createAuthClient } from "better-auth/react";

const client = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  basePath: "/api/auth",
});

// Re-export with explicit types to avoid TS2742 in enterprise repo
// (better-auth internal types aren't portable across different node_modules layouts)
export const authClient: ReturnType<typeof createAuthClient> = client;
export const useSession: typeof client.useSession = client.useSession;
export const signIn: typeof client.signIn = client.signIn;
export const signUp: typeof client.signUp = client.signUp;
export const signOut: typeof client.signOut = client.signOut;
