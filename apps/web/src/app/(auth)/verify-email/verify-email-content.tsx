"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export default function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"verifying" | "success" | "error">(
    token ? "verifying" : "success",
  );
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    // If no token, verification already happened server-side (Better Auth redirect)
    if (!token) {
      setTimeout(() => router.push("/login?verified=true"), 1500);
      return;
    }
    if (attempted.current) return;
    attempted.current = true;

    authClient.verifyEmail({ query: { token } }).then(({ error: verifyError }) => {
      if (verifyError) {
        setError(verifyError.message ?? "Verification failed");
        setStatus("error");
        return;
      }
      setStatus("success");
      setTimeout(() => router.push("/dashboard"), 2000);
    });
  }, [token, router]);

  return (
    <>
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Email verification
        </h1>
      </div>

      <div className="rounded-lg border border-border bg-card p-8 shadow-sm text-center">
        {status === "verifying" && (
          <>
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-sm text-muted">Verifying your email...</p>
          </>
        )}

        {status === "success" && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <svg className="h-6 w-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-foreground">Email verified</h2>
            <p className="mt-2 text-sm text-muted">
              {token ? "Redirecting to dashboard..." : "Redirecting to sign in..."}
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <svg className="h-6 w-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-foreground">Verification failed</h2>
            <p className="mt-2 text-sm text-destructive">{error}</p>
            <Link
              href="/login"
              className="mt-4 inline-block text-sm font-medium text-primary hover:text-primary/80"
            >
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </>
  );
}
