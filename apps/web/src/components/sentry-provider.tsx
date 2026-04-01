"use client";

import { useEffect } from "react";
import { Sentry } from "@/lib/sentry";

/**
 * Initializes Sentry on the client side.
 * Import sentry.ts triggers Sentry.init() — this component just ensures
 * the import runs early in the React tree and sets up the global error boundary.
 */
export function SentryProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Sentry is already initialized via the sentry.ts import.
    // This is a hook point for future user-context enrichment, e.g.:
    // Sentry.setUser({ id: userId }) when session is available.
  }, []);

  return <Sentry.ErrorBoundary fallback={<SentryFallback />}>{children}</Sentry.ErrorBoundary>;
}

function SentryFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="mt-2 text-muted-foreground">
          The error has been reported. Please try refreshing the page.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
