"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

const POPUP_WIDTH = 500;
const POPUP_HEIGHT = 600;

function openCenteredPopup(url: string, name: string): Window | null {
  const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
  return window.open(
    url,
    name,
    `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},popup=yes`,
  );
}

type SocialProvider = "google" | "microsoft" | "apple" | "facebook";

const SOCIAL_BUTTONS: { provider: SocialProvider; label: string; enabled: boolean; icon: React.ReactNode }[] = [
  {
    provider: "google",
    label: "Continue with Google",
    enabled: Boolean(process.env.NEXT_PUBLIC_SOCIAL_GOOGLE),
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
      </svg>
    ),
  },
  {
    provider: "microsoft",
    label: "Continue with Microsoft",
    enabled: Boolean(process.env.NEXT_PUBLIC_SOCIAL_MICROSOFT),
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 21 21">
        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
      </svg>
    ),
  },
  {
    provider: "apple",
    label: "Continue with Apple",
    enabled: Boolean(process.env.NEXT_PUBLIC_SOCIAL_APPLE),
    icon: (
      <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
        <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.52-3.23 0-1.44.62-2.2.44-3.06-.4C3.79 16.17 4.36 9.02 8.93 8.76c1.31.07 2.22.75 2.98.8.94-.19 1.84-.89 3.15-.81 1.53.12 2.68.72 3.44 1.84-3.14 1.9-2.4 6.06.49 7.23-.57 1.55-1.31 3.09-2.94 4.46zM12.03 8.7c-.16-2.38 1.73-4.39 3.97-4.6.29 2.63-2.34 4.84-3.97 4.6z" />
      </svg>
    ),
  },
  {
    provider: "facebook",
    label: "Continue with Facebook",
    enabled: Boolean(process.env.NEXT_PUBLIC_SOCIAL_FACEBOOK),
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24">
        <path fill="#1877F2" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
      </svg>
    ),
  },
];

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const authError = searchParams.get("error");
  const verified = searchParams.get("verified") === "true" && !authError;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // BroadcastChannel listener for social login popup completion.
  // postMessage/window.closed are blocked by Cross-Origin-Opener-Policy
  // when OAuth providers (Google, Microsoft) sever window.opener.
  useEffect(() => {
    const channel = new BroadcastChannel("ah5-social-auth");
    channel.onmessage = async (event) => {
      if (event.data?.type === "social-auth-complete") {
        channel.close();
        // Verify session was actually created before navigating
        const { data: session } = await authClient.getSession();
        if (!session) {
          setError("Sign-in failed. Please try again.");
          return;
        }
        // Hard navigation to clear stale router cache after sign-out/sign-in
        window.location.href = "/dashboard";
      }
    };
    return () => channel.close();
  }, []);

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });

    if (signInError) {
      const code = (signInError as { code?: string }).code;
      const msg = signInError.message ?? "";
      if (code === "EMAIL_NOT_VERIFIED" || msg.toLowerCase().includes("not verified")) {
        setError("Please verify your email before signing in. Check your inbox for the verification link.");
      } else {
        setError(msg || "Sign in failed");
      }
      setLoading(false);
      return;
    }

    router.push("/dashboard");
  }

  async function handleSocialLogin(provider: SocialProvider) {
    setError(null);
    const { data, error: socialError } = await authClient.signIn.social({
      provider,
      callbackURL: "/auth/social-callback",
      disableRedirect: true,
    });

    if (socialError) {
      setError(socialError.message ?? "Social sign in failed");
      return;
    }

    if (data?.url) {
      const popup = openCenteredPopup(data.url, "social-login");
      if (!popup) {
        // Popup blocked — fall back to redirect
        window.location.href = data.url;
      }
    }
  }

  return (
    <>
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Sign in to AgentHiFive
        </h1>
        <p className="mt-2 text-sm text-muted">
          Authority delegation for AI agents
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-8 shadow-sm">
        {authError && !verified && (
          <div className="mb-6 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <svg className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Sign-in session expired. Please try again.
          </div>
        )}
        {verified && (
          <div className="mb-6 flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <svg className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Email verified successfully. You can now sign in.
          </div>
        )}
        <div className="space-y-3">
          {SOCIAL_BUTTONS.map(({ provider, label, enabled, icon }) => {
            return (
              <button
                key={provider}
                type="button"
                onClick={() => handleSocialLogin(provider)}
                disabled={!enabled}
                title={enabled ? undefined : "Not configured"}
                className={`flex w-full items-center justify-center gap-3 rounded-md border border-border bg-white px-4 py-2.5 text-sm font-medium transition-colors ${
                  enabled
                    ? "text-foreground hover:bg-gray-50"
                    : "cursor-not-allowed text-muted opacity-50"
                }`}
              >
                {icon}
                {label}
              </button>
            );
          })}
        </div>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-card px-2 text-muted">or continue with email</span>
          </div>
        </div>

        <form onSubmit={handleEmailLogin} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-foreground">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-foreground">
              Password
            </label>
            <div className="relative mt-1">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="Enter your password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted hover:text-foreground"
              >
                {showPassword ? (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>

          <div className="text-right">
            <Link href="/forgot-password" className="text-sm font-medium text-primary hover:text-primary/80">
              Forgot password?
            </Link>
          </div>
        </form>

        <p className="mt-4 text-center text-sm text-muted">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="font-medium text-primary hover:text-primary/80">
            Register
          </Link>
        </p>
      </div>
    </>
  );
}
