/**
 * Thin API client for making authenticated requests to the AH5 API.
 *
 * Uses either a session cookie (from Playwright) or a Bearer token.
 */
import { API_URL } from "./constants.js";

export interface ApiClientOptions {
  sessionCookie?: string;
  bearerToken?: string;
}

export async function apiFetch(
  method: string,
  path: string,
  opts: ApiClientOptions & { body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (opts.bearerToken) {
    headers["Authorization"] = `Bearer ${opts.bearerToken}`;
  }
  if (opts.sessionCookie) {
    headers["Cookie"] = opts.sessionCookie;
  }

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const url = path.startsWith("http") ? path : `${API_URL}${path}`;
  return fetch(url, init);
}

/**
 * Exchange a session cookie for a JWT token via the token endpoint.
 *
 * The token endpoint has CSRF protection: it checks that the Origin header
 * matches WEB_URL. We must send it to pass the check.
 */
export async function getJwtFromSession(
  sessionCookie: string,
): Promise<string> {
  const webUrl = process.env["AH5_WEB_URL"] || "http://localhost:3000";
  const res = await fetch(`${API_URL}/api/auth/token`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: webUrl,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string; expiresAt: string };
  return data.token;
}
