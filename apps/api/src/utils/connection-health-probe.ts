import { buildProviderAuthHeaders } from "./provider-auth";

/**
 * Lightweight health-check endpoints per service. Same URLs the "test" button
 * uses — we call these to verify a credential is valid when a provider returns 401.
 *
 * A 2xx here means the credential is good and the original 401 was a scope/permission
 * issue (not a bad token). A 401 here means the credential is actually invalid.
 */
const SERVICE_PROBE_URLS: Record<string, string> = {
  "google-gmail": "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  "google-calendar": "https://www.googleapis.com/calendar/v3/calendars/primary",
  "google-drive": "https://www.googleapis.com/drive/v3/about?fields=user",
  "google-sheets": "https://www.googleapis.com/drive/v3/about?fields=user",
  "google-docs": "https://www.googleapis.com/drive/v3/about?fields=user",
  "microsoft-teams": "https://graph.microsoft.com/v1.0/me",
  "microsoft-outlook-mail": "https://graph.microsoft.com/v1.0/me",
  "microsoft-outlook-calendar": "https://graph.microsoft.com/v1.0/me",
  "microsoft-outlook-contacts": "https://graph.microsoft.com/v1.0/me",
  "microsoft-onedrive": "https://graph.microsoft.com/v1.0/me",
};

export function getHealthProbeUrl(service: string): string | null {
  return SERVICE_PROBE_URLS[service] ?? null;
}

export type ProbeResult =
  | { status: "valid" }       // 2xx — credential works, 401 on target endpoint was a scope/permission issue
  | { status: "invalid" }     // 401 — credential is actually bad
  | { status: "unknown" };    // no probe URL, network error, or non-auth failure

export async function probeConnectionAuth(
  service: string,
  provider: string,
  accessToken: string,
): Promise<ProbeResult> {
  const url = getHealthProbeUrl(service);
  if (!url) return { status: "unknown" };

  try {
    const res = await fetch(url, {
      headers: buildProviderAuthHeaders(provider, accessToken),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 200 && res.status < 300) return { status: "valid" };
    if (res.status === 401) return { status: "invalid" };
    return { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}