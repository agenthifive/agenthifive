/**
 * Cloudflare Turnstile server-side verification.
 *
 * The frontend embeds an invisible Turnstile widget on the sign-up form
 * and sends the resulting token via the X-Turnstile-Token request header.
 * This module validates the token with Cloudflare's siteverify API.
 *
 * Env vars:
 *   TURNSTILE_SECRET_KEY — Cloudflare Turnstile secret key.
 *                          If not set, verification is skipped (dev mode).
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Verify a Turnstile token. Returns true if valid or if Turnstile is not configured.
 */
export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const secret = process.env["TURNSTILE_SECRET_KEY"];

  // Not configured — skip check (dev/test environments)
  if (!secret) return true;

  // No token provided — reject
  if (!token) return false;

  try {
    const body = new URLSearchParams({
      secret,
      response: token,
      ...(remoteIp ? { remoteip: remoteIp } : {}),
    });

    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) return false;

    const data = (await res.json()) as SiteverifyResponse;
    return data.success;
  } catch {
    // Network error — fail open to avoid blocking real users.
    // WAF rate limits provide a safety net.
    console.error("[turnstile] verification request failed");
    return true;
  }
}
