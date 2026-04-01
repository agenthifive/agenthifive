"use client";

import { useEffect } from "react";

/**
 * Popup callback page for social login.
 * Better Auth redirects here after successful OAuth.
 * Uses BroadcastChannel to notify the opener — postMessage/window.closed
 * are blocked by Cross-Origin-Opener-Policy when OAuth providers (Google,
 * Microsoft) sever the window.opener reference.
 */
export default function SocialCallbackPage() {
  useEffect(() => {
    const channel = new BroadcastChannel("ah5-social-auth");
    channel.postMessage({ type: "social-auth-complete" });
    channel.close();

    // Try closing the popup. window.close() is a no-op when:
    //   (a) the window was opened by the user (not by script), or
    //   (b) COOP severed window.opener after Google/Microsoft OAuth redirect.
    // We detect we're a popup by the window.name set in login-form.tsx.
    // If we're the popup, stay here — the main window handles navigation.
    // If window.name is empty, this is the redirect fallback (popup was blocked).
    if (window.name === "social-login") {
      window.close();
      // close() failed (COOP) — just stay on this page; main window will navigate
      return;
    }
    // Redirect flow: popup was blocked, this IS the main window
    window.location.href = "/dashboard";
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-muted">Completing sign in...</p>
    </div>
  );
}
