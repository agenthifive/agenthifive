"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useSession, signOut } from "@/lib/auth-client";
import { apiFetch } from "@/lib/api-client";
import { REQUESTS_CHANGED_EVENT } from "@/lib/events";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { data: session, isPending, error } = useSession();
  const [showAdvancedMenu, setShowAdvancedMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [pendingRequestCount, setPendingRequestCount] = useState(0);

  useEffect(() => {
    // Only redirect if session check completed with no session AND no error.
    // If there's an error (e.g. server restarting), the session may still be
    // valid — don't kick the user to login on transient failures.
    if (!isPending && !session && !error) {
      router.push("/login");
    }
  }, [isPending, session, error, router]);

  // Fetch combined pending count: permission requests + step-up approvals
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function fetchCount() {
      try {
        const [permRes, approvalRes] = await Promise.all([
          apiFetch("/agent-permission-requests"),
          apiFetch("/approvals"),
        ]);
        if (cancelled) return;
        let total = 0;
        if (permRes.ok) {
          const data = (await permRes.json()) as { requests: unknown[] };
          total += data.requests.length;
        }
        if (approvalRes.ok) {
          const data = (await approvalRes.json()) as {
            approvals: Array<{ status: string; expiresAt: string }>;
          };
          const now = Date.now();
          total += data.approvals.filter(
            (a) => a.status === "pending" && new Date(a.expiresAt).getTime() > now,
          ).length;
        }
        setPendingRequestCount(total);
      } catch { /* ignore */ }
    }
    fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    const handleChanged = () => { fetchCount(); };
    window.addEventListener(REQUESTS_CHANGED_EVENT, handleChanged);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener(REQUESTS_CHANGED_EVENT, handleChanged);
    };
  }, [session]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setShowAdvancedMenu(false);
      setShowUserMenu(false);
    };
    if (showAdvancedMenu || showUserMenu) {
      document.addEventListener("click", handleClickOutside);
      return () => document.removeEventListener("click", handleClickOutside);
    }
  }, [showAdvancedMenu, showUserMenu]);

  if (isPending || !session) {
    if (error && !isPending) {
      return (
        <div className="flex min-h-screen items-center justify-center px-4">
          <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
            <h1 className="text-lg font-semibold text-foreground">We could not verify your session</h1>
            <p className="mt-2 text-sm text-muted">
              The dashboard could not reach the authentication service. Try refreshing the page,
              and if that does not help, sign in again.
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
              >
                Refresh
              </button>
              <Link
                href="/login"
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go to login
              </Link>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted">Loading...</div>
      </div>
    );
  }

  const userInitial = (session.user.name?.[0] || session.user.email?.[0] || "?").toUpperCase();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-6">
            <Link href="/dashboard/my-agents" className="text-lg font-bold text-foreground hover:text-blue-600 transition-colors">
              AgentHiFive
            </Link>
            <div className="flex gap-4 items-center">
              <Link href="/dashboard/approvals" className="relative text-sm font-medium text-muted hover:text-foreground">
                Requests
                {pendingRequestCount > 0 && (
                  <span className="absolute -top-2 -right-2 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
                    {pendingRequestCount}
                  </span>
                )}
              </Link>
              <Link href="/dashboard/activity" className="text-sm font-medium text-muted hover:text-foreground">
                Activity
              </Link>

              {/* Advanced dropdown */}
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAdvancedMenu(!showAdvancedMenu);
                    setShowUserMenu(false);
                  }}
                  className="flex items-center gap-1 text-sm font-medium text-muted hover:text-foreground"
                >
                  Advanced
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showAdvancedMenu && (
                  <div className="absolute left-0 top-full mt-2 w-48 rounded-md border border-border bg-white shadow-lg z-50">
                    <Link
                      href="/dashboard/agents"
                      className="block px-4 py-2 text-sm text-foreground hover:bg-gray-50"
                      onClick={() => setShowAdvancedMenu(false)}
                    >
                      Agents
                    </Link>
                    <Link
                      href="/dashboard/connections"
                      className="block px-4 py-2 text-sm text-foreground hover:bg-gray-50"
                      onClick={() => setShowAdvancedMenu(false)}
                    >
                      Connections
                    </Link>
                    <Link
                      href="/dashboard/policies"
                      className="block px-4 py-2 text-sm text-foreground hover:bg-gray-50"
                      onClick={() => setShowAdvancedMenu(false)}
                    >
                      Policies
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
          {/* Documentation link */}
          <a
            href={process.env.NEXT_PUBLIC_DOCS_URL || "/docs"}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted hover:text-foreground transition-colors"
            title="Documentation"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </a>
          {/* User avatar dropdown */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowUserMenu(!showUserMenu);
                setShowAdvancedMenu(false);
              }}
              className="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              {session.user.image && !imgError ? (
                <Image
                  src={session.user.image}
                  alt=""
                  width={32}
                  height={32}
                  className="rounded-full object-cover"
                  onError={() => setImgError(true)}
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm font-medium text-white">
                  {userInitial}
                </div>
              )}
            </button>
            {showUserMenu && (
              <div className="absolute right-0 top-full mt-2 w-56 rounded-md border border-border bg-white shadow-lg z-50">
                {/* User info header */}
                <div className="px-4 py-3">
                  {session.user.name && (
                    <p className="text-sm font-medium text-foreground">{session.user.name}</p>
                  )}
                  <p className="text-xs text-muted truncate">{session.user.email}</p>
                </div>
                <div className="border-t border-border" />

                {/* Menu items */}
                <Link
                  href="/dashboard/settings"
                  className="flex items-center gap-2 px-4 py-2 text-sm text-foreground hover:bg-gray-50"
                  onClick={() => setShowUserMenu(false)}
                >
                  <svg className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Settings
                </Link>
                <Link
                  href="/dashboard/settings/notifications"
                  className="flex items-center gap-2 px-4 py-2 text-sm text-foreground hover:bg-gray-50"
                  onClick={() => setShowUserMenu(false)}
                >
                  <svg className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  Notifications
                </Link>
                <Link
                  href="/dashboard/settings/apps"
                  className="flex items-center gap-2 px-4 py-2 text-sm text-foreground hover:bg-gray-50"
                  onClick={() => setShowUserMenu(false)}
                >
                  <svg className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                  </svg>
                  Apps
                </Link>
                <a
                  href={process.env.NEXT_PUBLIC_DOCS_URL || "/docs"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 text-sm text-foreground hover:bg-gray-50"
                  onClick={() => setShowUserMenu(false)}
                >
                  <svg className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                  Documentation
                  <svg className="ml-auto h-3 w-3 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>

                <div className="border-t border-border" />
                <button
                  onClick={async () => {
                    setShowUserMenu(false);
                    await signOut();
                    router.push("/login");
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-gray-50"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Sign out
                </button>
              </div>
            )}
          </div>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
